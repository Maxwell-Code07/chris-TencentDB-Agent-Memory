/**
 * /skill/* HTTP handlers — v3 (migrated from v2, 2026-06-17).
 *
 * 设计文档对应：docs/design/2026-06-17-skill-redesign-v2.md §3.5 / §3.6。
 *
 * 错误码映射（核心层 SkillCoreError → HTTP envelope code）：
 *   INVALID_FRONTMATTER       → 40001  (frontmatter.name 与 body/head 不一致)
 *   INVALID_PATH              → 40001
 *   SKILL_NOT_OWNER           → 40301
 *   SKILL_TEAM_MISMATCH       → 40302
 *   SKILL_NOT_FOUND           → 40401
 *   SKILL_VERSION_STALE       → 40901
 *   RESOURCE_TOO_LARGE        → 41301
 *   SKILL_NAME_DUPLICATE      → 42201
 *   SKILL_PATCH_NOT_UNIQUE    → 42202
 *   SKILL_FRONTMATTER_INVALID → 42203  (frontmatter parse / 长度 / regex)
 *   STORAGE_NOT_FOUND         → 50301  (版本目录被 GC)
 *   QUEUE_UNAVAILABLE         → 50301  (extract 时队列未就绪)
 *   LLM_UNAVAILABLE           → 50302  (LLM 不可用)
 *   其他                       → 50001
 */

import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import {
  createRequestSchema,
  updateRequestSchema,
  patchRequestSchema,
  deleteRequestSchema,
  getRequestSchema,
  listRequestSchema,
  searchRequestSchema,
  versionsRequestSchema,
  filesWriteRequestSchema,
  filesRemoveRequestSchema,
  filesReadRequestSchema,
  listingRequestSchema,
  extractRequestSchema,
  conversationAddRequestSchema,
} from "./skill-schemas.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import { SkillCoreError, type SkillCore } from "../core/skill/skill-core.js";
import type { SkillExtractor } from "../core/skill/skill-extractor.js";
import type { Logger } from "../core/types.js";
import type { Skill, ResolvedSkillConfig } from "../core/skill/types.js";
import { DEFAULT_COMPRESS_OPTIONS } from "../core/skill/conversation-add/message-compressor.js";
import { DEFAULT_OVERSIZE_OPTIONS } from "../core/skill/conversation-add/oversize-strategy.js";
import { prepareArchivePayload } from "../core/skill/conversation-add/prepare-archive.js";
import type { CompressibleMessage } from "../core/skill/conversation-add/message-compressor.js";
import { trace } from "../core/report/trace.js";
import { metricProducer } from "../core/report/kafka-metric-producer.js";

const TAG = "[skill-handlers]";

// ═════════════════════════════════════════════════════════════════════
//  Deps
// ═════════════════════════════════════════════════════════════════════

export interface SkillRouterDeps {
  getSkillCore: () => SkillCore | undefined;
  /** Optional. 抽取器实例（供 worker 内部驱动）。 */
  getSkillExtractor?: () => SkillExtractor | undefined;
  /** Optional. 已解析的 skill 配置；handleListing 用 searchTopK 限制注入条目数。 */
  getResolvedSkillConfig?: () => ResolvedSkillConfig | undefined;
  logger: Logger;
  /**
   * Service mode: resolve per-instance SkillCore (TcvdbSkillStore + COS).
   * When provided, takes precedence over getSkillCore() for /v3/skill/* requests
   * that carry x-tdai-service-id.
   */
  resolveSkillCore?: (instanceId: string) => Promise<SkillCore | undefined>;
  /** Quota manager for skill count limit checks (like memory's checkMemoryQuota). */
  quotaManager?: import("../core/quota/quota-manager.js").QuotaManager;
  /**
   * Service mode: build a SkillExtractor for a given SkillCore.
   * 传入 per-instance SkillCore（TCVDB + COS）+ 当次请求的 instanceId，返回 extractor。
   * 用于 service 模式下 /v3/skill/extract 的同步抽取，替代 standalone 的队列异步模式。
   *
   * `instanceId` 会传给 `resolveStandaloneLlmForRuntime` 以拼出
   * `${baseUrl}/proxy/<instanceId>/v1` —— 缺少它会导致 `provider=proxy`
   * 场景下 skill extractor 直接打错 upstream URL。
   */
  buildSkillExtractor?: (
    core: SkillCore,
    instanceId: string,
  ) => SkillExtractor | Promise<SkillExtractor>;
  /**
   * 拿到 (per instance) 的 MetadataService。用于 handleCreate 成功后自动登记
   * skill 资产（asset_id === skill_id）并绑定到 owner agent 的 fixed-asset。
   *
   * standalone 模式下 SkillCore 是 TdaiCore 全局构造的（不带钩子），所以由 handler
   * 层做这个登记；service 模式下 buildSkillCore 里的 onSkillCreated 钩子会做同样的
   * 事（幂等，重复调用无副作用）。两条路径都覆盖，保证前端管控页永远能看到 skill。
   *
   * 语义与 v2-router 里 handleConversationAdd 用同一 dep 自动登记 chat_memory 资产
   * 一致（详见 v2-router.ts:648 及 metadata-service.ts:ensureSkillAsset）。
   */
  getMetadataService?: (instanceId: string) => Promise<import("../metadata/service/metadata-service.js").MetadataService>;
  /**
   * `POST /v3/skill/conversation/add` + `POST /v3/skill/extract`
   * 共用的 wired 结果提供者。返回一整套 { handler, trigger, buffer, ... }：
   *   - handleConversationAdd 用 .handler
   *   - handleExtract 用 .trigger
   *
   * Service 模式下每租户各持一份；standalone 模式返回单例。由 wiring 层
   * (server.ts) 按 auth.serviceId 缓存 + resolve。
   */
  resolveConversationAdd?: (instanceId: string) => Promise<
    import("../core/skill/conversation-add/wire.js").WiredConversationAdd | undefined
  >;
}

// ═════════════════════════════════════════════════════════════════════
//  错误映射
// ═════════════════════════════════════════════════════════════════════

const ERROR_CODE_MAP: Record<string, number> = {
  INVALID_FRONTMATTER: 40001,
  INVALID_PATH: 40001,
  SKILL_NOT_OWNER: 40301,
  SKILL_TEAM_MISMATCH: 40302,
  SKILL_NOT_FOUND: 40401,
  SKILL_VERSION_STALE: 40901,
  RESOURCE_TOO_LARGE: 41301,
  SKILL_NAME_DUPLICATE: 42201,
  SKILL_PATCH_NOT_UNIQUE: 42202,
  SKILL_FRONTMATTER_INVALID: 42203,
  STORAGE_NOT_FOUND: 50301,
  LLM_UNAVAILABLE: 50302,
  SKILL_COS_REQUIRED: 50303,
  SKILL_VERSION_EXPIRED: 41002,
};

function mapCoreError(e: unknown, requestId: string, deps?: SkillRouterDeps, meta?: Record<string, unknown>): ApiResponseEnvelope {
  if (e instanceof SkillCoreError) {
    const code = ERROR_CODE_MAP[e.code] ?? 50001;

    // 版本冲突时记录 warn 日志，便于后续统计冲突频率
    if (e.code === "SKILL_VERSION_STALE" && deps) {
      deps.logger.warn(
        `${TAG} version_conflict requestId=${requestId} skill_id=${meta?.skill_id ?? "?"} ` +
        `expected_version=${meta?.expected_version ?? "?"} detail="${e.message}"`,
      );
    }

    // 版本冲突 409 响应里额外带上 current_version，方便调用方重试
    if (e.code === "SKILL_VERSION_STALE") {
      const match = e.message?.match(/head is (\d+)/);
      const currentVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { current_version: currentVersion });
    }

    // 版本过期 410 响应里额外带上 latest_version，方便调用方升级
    if (e.code === "SKILL_VERSION_EXPIRED") {
      const match = e.message?.match(/latest version v(\d+)/);
      const latestVersion = match ? Number(match[1]) : undefined;
      return errorEnvelope(code, e.message, requestId, { latest_version: latestVersion });
    }

    return errorEnvelope(code, e.message, requestId);
  }
  return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
}

function formatZodErr(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

// ═════════════════════════════════════════════════════════════════════
//  共享前置
// ═════════════════════════════════════════════════════════════════════

/**
 * 统一前置校验：优先通过 resolveSkillCore(auth.serviceId) 获取
 * per-instance SkillCore（TCVDB + COS），fallback 到 getSkillCore()（standalone）。
 *
 * 修复 (2026-07-04)：service 模式下 read handlers 之前只用 getSkillCore()（standalone
 * SQLite），导致写入 per-instance TCVDB 后读却查空 SQLite。现在读/写路径对齐同一套
 * store 解析逻辑。
 */
async function precheck<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

/**
 * 写路径的 precheck：与 precheck 逻辑完全一致，只是名字更明确表达"写入语义"。
 * 保留以维持既有 handler 命名一致性；两者可以合并，但先保持向后兼容。
 */
async function precheckWrite<T>(
  schema: { safeParse(b: unknown): { success: true; data: T } | { success: false; error: ZodError } },
  body: unknown,
  auth: V2AuthContext,
  deps: SkillRouterDeps,
  requestId: string,
): Promise<{ ok: true; core: SkillCore; data: T } | { ok: false; envelope: ApiResponseEnvelope }> {
  let core: SkillCore | undefined;
  if (deps.resolveSkillCore) {
    core = await deps.resolveSkillCore(auth.serviceId);
  }
  if (!core) {
    core = deps.getSkillCore();
  }
  if (!core) return { ok: false, envelope: errorEnvelope(404, "Skill module not enabled", requestId) };
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { ok: false, envelope: errorEnvelope(40001, formatZodErr(parsed.error), requestId) };
  return { ok: true, core, data: parsed.data };
}

// 把 Skill 行形成 SkillSummary 形态（不带 content；带 manifest 当 detail 时再加）
// 字段对齐设计文档 §3.4 SkillSummary。
/** 反序列化 skill.metadata_json 到 metadata 对象；无效 JSON 返回 undefined。 */
function parseMetadata(s: Skill): Record<string, unknown> | undefined {
  const raw = s.metadata_json;
  if (!raw || raw === "{}" || raw === "") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function toSummary(s: Skill) {
  const metadata = parseMetadata(s);
  return {
    skill_id: s.skill_id,
    name: s.name,
    description: s.description,
    version: s.version,
    is_head: s.is_head,
    status: s.status,
    owner_user_id: s.user_id,
    owner_agent_id: s.owner_agent_id,
    team_id: s.team_id,
    task_id: s.task_id,
    created_at_ms: s.created_at_ms,
    updated_at_ms: s.updated_at_ms,
    ...(metadata ? { metadata } : {}),
  };
}

// ═════════════════════════════════════════════════════════════════════
//  Handlers
// ═════════════════════════════════════════════════════════════════════

export async function handleCreate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheckWrite(createRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) return pre.envelope;

  // Quota check (like memory's checkMemoryQuota)
  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.create(pre.data);
    try { trace.report("skill.create", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name }); } catch { /* noop */ }

    // ── 自动登记 skill 资产（asset_id === skill_id）+ 绑定到 owner agent 的 fixed-asset ──
    //
    // 为什么要在这里做：
    //   - standalone 模式下 SkillCore 由 TdaiCore 全局构造（无 onSkillCreated 钩子）；
    //   - 若不在这里补登记，asset/list-accessible / acl/* 等元数据层接口就查不到这个 skill，
    //     前端管控页的"团队资产 / 授权"链路完全断开。
    //
    // 与 service 模式的关系：
    //   - service 模式下 gateway 用 buildSkillCore 构造 per-instance SkillCore 时挂了同名钩子，
    //     两条路径都调 `metaSvc.ensureSkillAsset({ skill_id, team_id, agent_id, name })`，
    //     该方法在 metadata-service.ts 内已实现幂等（LRU + 主键去重），重复调用无副作用。
    //
    // 失败策略：
    //   - 抛出异常 → create 请求整体返回错误。避免出现"skill 落库但 asset 缺失"
    //     的静默不一致状态（用户会疑惑"我创建成功了但看不到"）。
    //   - 与 v2-router.ts handleConversationAdd 里 ensureChatMemoryAsset 的做法一致。
    if (deps.getMetadataService && r.team_id && r.owner_agent_id) {
      try {
        const metaSvc = await deps.getMetadataService(auth.serviceId);
        await metaSvc.ensureSkillAsset({
          skill_id: r.skill_id,
          team_id: r.team_id,
          agent_id: r.owner_agent_id,
          name: r.name,
        });
      } catch (err) {
        deps.logger.error(
          `${TAG} ensureSkillAsset failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return mapCoreError(err, requestId, deps, { skill_id: r.skill_id });
      }
    }

    return successEnvelope(toSummary(r), requestId);
  } catch (e) { return mapCoreError(e, requestId); }
}

export async function handleUpdate(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheckWrite(updateRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) return pre.envelope;

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.update(pre.data);
    try { trace.report("skill.update", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handlePatch(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheckWrite(patchRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) return pre.envelope;

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.patch(pre.data);
    try { trace.report("skill.patch", { skill_id: r.skill_id, team_id: r.team_id, agent_id: r.owner_agent_id, name: r.name, version: r.version }); } catch { /* noop */ }
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleDelete(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheck(deleteRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) return pre.envelope;
  try {
    const r = await pre.core.delete(pre.data);

    // ── asset 物理删除兜底：DELETE meta_assets + 级联清 agent 绑定 / ACL ──
    //
    // 为什么在这里再做一次：
    //   - service 模式：buildSkillCore 里的 onSkillArchived 钩子已经调过一次；这里再
    //     调是幂等收敛（deleteAssets 对已不存在的 asset 视为成功，无副作用）。
    //   - standalone 模式：SkillCore 由 TdaiCore 全局构造，未注入钩子（避免耦合
    //     MetadataService 拉起时序）。handler 层这一次调用是唯一联动入口。
    //
    // 失败策略：fire-and-forget，warn 不回退 delete。二次 delete 会重触发 core 钩子
    // 与本次兜底，最终收敛。参考 handleCreate 里 ensureSkillAsset 的对称做法
    // （只是失败策略相反：create 严格失败，delete 宽松以保证 skill 侧一定成功）。
    let assetSynced = false;
    if (r.archived && deps.getMetadataService && pre.data.team_id) {
      try {
        const metaSvc = await deps.getMetadataService(_auth.serviceId);
        await metaSvc.deleteAssets([r.skill_id]);
        assetSynced = true;
      } catch (err) {
        deps.logger.warn(
          `${TAG} [skill-asset-sync] deleteAssets(archive) failed for ${r.skill_id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    try {
      trace.report("skill.delete", {
        skill_id: r.skill_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        asset_synced: assetSynced,
      });
    } catch { /* noop */ }
    return successEnvelope(r, requestId);
  } catch (e) {
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleGet(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheck(getRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) return pre.envelope;
  try {
    const row = await pre.core.get(pre.data);
    const includeContent = pre.data.include_content ?? true;
    const includeManifest = pre.data.include_manifest ?? true;
    // Detail view 额外附上 content_hash / storage_dir（summary 没输出这些）。
    // 参考 docs/design/2026-06-17-skill-redesign-v2.md §3.4 SkillDetail 字段。
    const data = {
      ...toSummary(row),
      ...(row.content_hash ? { content_hash: row.content_hash } : {}),
      ...(row.storage_dir ? { storage_dir: row.storage_dir } : {}),
      ...(includeContent ? { content: row.content } : {}),
      ...(includeManifest ? { manifest: row.manifest } : {}),
    };
    return successEnvelope(data, requestId);
  } catch (e) { return mapCoreError(e, requestId); }
}

export async function handleList(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheck(listRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) return pre.envelope;
  try {
    // 归档语义说明：`filters.status` 允许显式传 `['archived']` / `['active','archived']`，
    // 仅供管控台"回收站"视图使用。不传 status 时默认只返回 active（见
    // SqliteSkillStore.listSkills / TcvdbSkillStore.listSkills 中的默认值）。
    // 普通业务调用方 **不应** 显式请求 archived——它对读/写 API 已经不可见。
    const r = await pre.core.list(pre.data);
    return successEnvelope({ items: r.items.map(toSummary), total: r.total }, requestId);
  } catch (e) { return mapCoreError(e, requestId); }
}

export async function handleSearch(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheck(searchRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) return pre.envelope;
  try {
    // scope="team" → strip agent_id so store does team-wide search (no owner filter).
    // The v3 isolation middleware already verified team_id + agent_id + user_id are present.
    const { scope, ...data } = pre.data;
    const searchInput = scope === "team"
      ? { ...data, agent_id: undefined }
      : data;
    const hits = await pre.core.search(searchInput);
    const items = hits.map((h) => ({
      ...toSummary(h.skill),
      score: h.score,
      // FTS5 snippet 可能为空（content 太短）；fallback 到 description。
      snippet: h.snippet && h.snippet.length > 0 ? h.snippet : h.skill.description,
    }));
    return successEnvelope({ items }, requestId);
  } catch (e) { return mapCoreError(e, requestId); }
}

export async function handleVersions(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheck(versionsRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) return pre.envelope;
  try {
    const r = await pre.core.listVersions(pre.data);
    if (r.total === 0) return errorEnvelope(40401, "skill not found", requestId);
    const items = r.items.map((s) => ({
      ...toSummary(s),
      is_expired: (s as Skill & { is_expired: boolean }).is_expired ?? false,
    }));
    return successEnvelope({ items, total: r.total }, requestId);
  } catch (e) { return mapCoreError(e, requestId); }
}

export async function handleFilesWrite(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheckWrite(filesWriteRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) return pre.envelope;

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.writeFiles(pre.data);
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRemove(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheckWrite(filesRemoveRequestSchema, body, auth, deps, requestId);
  if (!pre.ok) return pre.envelope;

  if (deps.quotaManager) {
    const check = await deps.quotaManager.checkMemoryQuota(auth.serviceId, 1);
    if (!check.allowed) {
      return errorEnvelope(4291, `Memory limit exceeded (current=${check.current}, limit=${check.limit})`, requestId);
    }
  }

  try {
    const r = await pre.core.removeFiles(pre.data);
    return successEnvelope(toSummary(r), requestId);
  } catch (e) {
    return mapCoreError(e, requestId, deps, { skill_id: pre.data.skill_id, expected_version: pre.data.expected_version });
  }
}

export async function handleFilesRead(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheck(filesReadRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) return pre.envelope;
  try {
    const r = await pre.core.readFile(pre.data);
    return successEnvelope(r, requestId);
  } catch (e) { return mapCoreError(e, requestId); }
}

export async function handleListing(body: unknown, _auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  const pre = await precheck(listingRequestSchema, body, _auth, deps, requestId);
  if (!pre.ok) return pre.envelope;
  try {
    const charBudget = pre.data.char_budget ?? 8000;
    const query = (pre.data.query ?? "").trim();
    const useSearch = query.length > 0;

    // 从配置读 routing：searchTopK（listing 最多注入多少条）+ mode（bm25/embedding/hybrid）。
    const routing = deps.getResolvedSkillConfig?.()?.routing;
    const topK = routing?.searchTopK ?? 20;

    // search 模式：按 routing.mode 选检索算法；fallback 到 list head（query 为空）。
    type Item = { skill_id: string; name: string; description: string; version: number };
    let items: Item[];
    let mode: "full" | "search";
    if (useSearch) {
      const hits = await pre.core.search({
        user_id: pre.data.user_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        query,
        top_k: topK,
        mode: routing?.mode,
      });
      items = hits.map((h) => ({
        skill_id: h.skill.skill_id,
        name: h.skill.name,
        description: h.skill.description,
        version: h.skill.version,
      }));
      mode = "search";
    } else {
      const r = await pre.core.list({
        user_id: pre.data.user_id,
        team_id: pre.data.team_id,
        agent_id: pre.data.agent_id,
        pagination: { limit: topK },
      });
      items = r.items.map((s) => ({
        skill_id: s.skill_id,
        name: s.name,
        description: s.description,
        version: s.version,
      }));
      mode = items.length < topK ? "full" : "search";
    }

    // 渲染 listing；按 char_budget 截断（保留头部 + 显式截断标记）。
    const lines = items.map((s) => `- ${s.name}: ${s.description}`);
    let listing = lines.length === 0
      ? "<available_skills>\n(none)\n</available_skills>"
      : `<available_skills>\n${lines.join("\n")}\n</available_skills>`;

    if (listing.length > charBudget) {
      const truncated = listing.slice(0, Math.max(0, charBudget - 32));
      listing = `${truncated}\n... [truncated]\n</available_skills>`;
    }

    return successEnvelope({
      mode,
      listing,
      hits: items.map((s) => ({ skill_id: s.skill_id, version: s.version, name: s.name })),
    }, requestId);
  } catch (e) { return mapCoreError(e, requestId); }
}

/**
 * `POST /v3/skill/extract` — direct-trigger 归档一次会话切片。
 *
 * 改造前是"入 Redis job 队列 + 轮询 /result"; 改造后走跟 conversation/add
 * 完全同一套下游 (`SkillTriggerService.archive()` → agent 队列 → 复用
 * `SkillConversationExtractWorker`)，只是不写 data-current/meta，一次调用
 * 产生一个独立 archive + 一条 SkillTaskEntry。
 *
 * 详见 `docs/design/2026-07-17-skill-extract-direct-trigger-plan.md`。
 */
export async function handleExtract(body: unknown, auth: V2AuthContext, requestId: string, deps: SkillRouterDeps): Promise<ApiResponseEnvelope> {
  // [skill-perf 2026-07-21] handler 内部分段耗时。命名与 v2-router 保持一致，
  // 都是 `[skill-perf] phase=xxx req_id=… dur=Nms`，grep req_id 就能拉全链路。
  const perfLog = (phase: string, dur: number, extra?: string) => {
    deps.logger.info(
      `[skill-perf] phase=handleExtract.${phase} req_id=${requestId} dur=${dur}ms${extra ? " " + extra : ""}`,
    );
  };

  const t0Parse = Date.now();
  const parsed = extractRequestSchema.safeParse(body);
  perfLog("schemaParse", Date.now() - t0Parse, `ok=${parsed.success}`);
  if (!parsed.success) {
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  if (!deps.resolveConversationAdd) {
    return errorEnvelope(50301, "skill extract not wired (resolveConversationAdd missing)", requestId);
  }
  const t0Wire = Date.now();
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  perfLog(
    "resolveConversationAdd",
    Date.now() - t0Wire,
    `serviceId=${auth.serviceId} wired=${wired ? "hit" : "miss"}`,
  );
  if (!wired) {
    return errorEnvelope(50301, "skill extract not wired for this instance", requestId);
  }

  // direct-trigger 恒生成一次性 session id (前缀 sx-) —— 因为它没有跨轮 buffer,
  // session_id 只决定 COS 归档路径分段, 每次调用独立即可; caller 传了也接受。
  const sessionId = input.session_id ?? `sx-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  // 压缩 + 兜底 (共享 helper, direct-trigger 场景恒 forceCompress=true)
  const t0Prep = Date.now();
  const incoming: CompressibleMessage[] = input.messages.map((m) => ({
    role: m.role,
    content: m.content,
    tool_name: m.tool_name,
    tool_call_id: m.tool_call_id,
  }));
  const prepared = prepareArchivePayload(
    /* existing */ [],
    incoming,
    {
      compress: DEFAULT_COMPRESS_OPTIONS,
      oversize: DEFAULT_OVERSIZE_OPTIONS,
      forceCompress: true,
    },
  );
  perfLog(
    "prepareArchivePayload",
    Date.now() - t0Prep,
    `msg_in=${input.messages.length} msg_out=${prepared.messages.length}`,
  );

  // space_id 优先取 body（向后兼容早期调用方），缺省回落到 auth.serviceId ——
  // 两个值在设计上就该相等（都是"当前登录实例"）。不等则记一条告警, 帮助早发现
  // 调用方传错实例的 bug；隔离/鉴权/路由都靠 auth.serviceId 做，跟 body 无关。
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/extract space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const t0Archive = Date.now();
    const res = await wired.trigger.archive({
      session: {
        space_id: spaceId,
        user_id: input.user_id,
        team_id: input.team_id,
        agent_id: input.agent_id,
        session_id: sessionId,
      },
      bufferAtTrigger: { messages: prepared.messages as Array<Record<string, unknown>> },
      taskRefId: input.task_id,
      reason: input.reason,
      maxIterations: input.options?.max_iterations,
      // 透传 requestId 给 trigger 内部分段 log
      perfRequestId: requestId,
    });
    perfLog(
      "trigger.archive",
      Date.now() - t0Archive,
      `task_id=${res.taskId} archive_key=${res.archiveKey}`,
    );

    try {
      metricProducer.send({ metric: "skill.extract.request", instanceId: input.team_id, value: 1 });
    } catch { /* noop */ }

    return successEnvelope({
      ok: true,
      task_id: res.taskId,
      archived_at_ms: res.archivedAtMs,
      archive_key: res.archiveKey,
    }, requestId);
  } catch (e) {
    deps.logger.warn(`${TAG} /v3/skill/extract archive failed: ${(e as Error).message} req_id=${requestId}`);
    return errorEnvelope(50001, (e as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  /v3/skill/conversation/add  —  新链路: 每轮对话增量入口
// ═════════════════════════════════════════════════════════════════════

/**
 * `POST /v3/skill/conversation/add`
 *
 * Client (proxy) 每轮对话结束后同步调用一次。Handler 内部完成
 * 拼接 + 阈值判定 + 归档段（先登记后落 archive）。返回 { status, archived? }.
 *
 * 参考 `docs/design/2026-07-15-skill-trigger-in-core-design.md` §11.1。
 */
export async function handleConversationAdd(
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
): Promise<ApiResponseEnvelope> {
  if (!deps.resolveConversationAdd) {
    return errorEnvelope(404, "Skill conversation-add module not enabled", requestId);
  }
  const parsed = conversationAddRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorEnvelope(40001, formatZodErr(parsed.error), requestId);
  }
  const input = parsed.data;

  // service 模式下用 auth.serviceId 解析租户级 wired; standalone 忽略 serviceId
  // 由 wiring 返回单例。
  const wired = await deps.resolveConversationAdd(auth.serviceId);
  if (!wired) {
    return errorEnvelope(404, "Skill conversation-add module not enabled for this instance", requestId);
  }

  // space_id 优先取 body, 缺省回落到 auth.serviceId (跟 handleExtract 同一处理).
  // 两个值在设计上就该相等；不等则告警。
  const spaceId = input.space_id ?? auth.serviceId;
  if (input.space_id && input.space_id !== auth.serviceId) {
    deps.logger.warn(
      `${TAG} /v3/skill/conversation/add space_id mismatch: body=${input.space_id} auth=${auth.serviceId}; using body`,
    );
  }

  try {
    const out = await wired.handler.handle({
      session_id: input.session_id,
      space_id: spaceId,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      task_id: input.task_id,
      // schema 保证 role 合法, tool_name/tool_call_id 由 handler 内校验
      messages: input.messages.map((m) => ({
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_call_id: m.tool_call_id,
        timestamp: typeof m.timestamp === "number" ? m.timestamp : undefined,
      })),
    });
    return successEnvelope(out, requestId);
  } catch (err) {
    // HandlerValidationError → 400；其他 → 500
    const isValidation = err instanceof Error && err.name === "HandlerValidationError";
    if (isValidation) {
      return errorEnvelope(40001, err.message, requestId);
    }
    deps.logger.warn(`${TAG} /v3/skill/conversation/add failed: ${(err as Error).message}`);
    return errorEnvelope(50001, (err as Error).message ?? "internal error", requestId);
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Route table
// ═════════════════════════════════════════════════════════════════════

export type SkillHandler = (
  body: unknown,
  auth: V2AuthContext,
  requestId: string,
  deps: SkillRouterDeps,
) => Promise<ApiResponseEnvelope>;

export function makeSkillRouteTable(): Record<string, SkillHandler> {
  return {
    "/v3/skill/create": handleCreate,
    "/v3/skill/update": handleUpdate,
    "/v3/skill/patch": handlePatch,
    "/v3/skill/delete": handleDelete,
    "/v3/skill/get": handleGet,
    "/v3/skill/list": handleList,
    "/v3/skill/search": handleSearch,
    "/v3/skill/versions": handleVersions,
    "/v3/skill/files/write": handleFilesWrite,
    "/v3/skill/files/remove": handleFilesRemove,
    "/v3/skill/files/read": handleFilesRead,
    "/v3/skill/listing": handleListing,
    "/v3/skill/extract": handleExtract,
    "/v3/skill/conversation/add": handleConversationAdd,
  };
}
