/**
 * skill-versioning — 版本递增的事务编排
 *
 * 把 skill-store 的 `appendVersion` 与 storage 的 `copyTree` 包成一组「append a new version」原语。
 * 为 SkillCore (Phase 6) 简化 6 个 manage action 的实现。
 *
 * 一次完整的"加一版"动作：
 *   1. 取 head（如果有）
 *   2. 校验：owner / version / 内容是否变更
 *   3. storage 拷贝 head 的版本目录到新版本目录（如果有 head）
 *   4. 在新版本目录上 apply 本次资源变更（write/remove）
 *   5. store.appendVersion 写 DB（事务内）
 *   6. 失败时尝试清理已写入的 storage 副本（best-effort）
 */

import { createHash } from "node:crypto";

import type { ISkillStore } from "./skill-store.interface.js";
import { IdempotentNoOpError, SkillStoreError } from "./skill-store.js";
import { SkillResourceStore, SkillResourceError, type SkillResourcePayload } from "./skill-resource-store.js";
import type { StorageAdapter } from "../storage/adapter.js";
import type { SkillManifestEntry, Skill } from "./types.js";

function computeContentHash(content: string): string {
  return createHash("md5").update(content, "utf-8").digest("hex");
}

export interface AppendVersionContext {
  user_id?: string;
  team_id?: string;
  agent_id?: string;
  task_id?: string;
}

export interface AppendVersionMutation {
  /** SKILL.md 全文（含 frontmatter）。所有写入路径都需要它（hash 校验幂等）。 */
  content: string;
  /** 解析后 frontmatter 提取出的 name / description。 */
  name: string;
  description: string;
  /** 资源变更：本次新增 / 覆盖的文件。 */
  resourcesToWrite?: SkillResourcePayload[];
  /** 资源变更：本次删除的相对 path。 */
  resourcesToRemove?: string[];
  /** 可选：metadata_json 直接覆盖（默认保留上一版）。 */
  metadata_json?: string;
}

export interface SkillVersioningOptions {
  store: ISkillStore;
  resources: SkillResourceStore;
  storage: StorageAdapter;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
  /**
   * VDB 条数变更回调（用于向 Shark 上报用量）。
   * 每次 store.appendVersion / store.deleteVersion 成功后触发。
   * @param delta +1 表示新增了一条 VDB 文档，-N 表示删除了 N 条。
   */
  onSkillVdbChanged?: (delta: number) => void;
  /**
   * v1 首创时的资产登记钩子。
   *
   * 契约：
   *  - 在 storage 与 DB 写入之前 `await` 调用（前置一致性保护）
   *  - 抛异常 = createNewSkill 失败，storage / DB 都不会写
   *  - 上层实现须幂等（同一 skill_id 多次调用应成功且不产生副作用）
   *  - 仅 `createNewSkill` 触发；`appendNextVersion` / TTL 清理均不触发
   *    （asset 与 version 无关，只认 skill_id）
   */
  onSkillCreated?: (params: {
    skill_id: string;
    team_id?: string;
    agent_id?: string;
    user_id?: string;
    name: string;
    description: string;
  }) => Promise<void>;
}

export class SkillVersioning {
  private readonly store: ISkillStore;
  private readonly resources: SkillResourceStore;
  private readonly storage: StorageAdapter;
  private readonly logger?: SkillVersioningOptions["logger"];
  private readonly onSkillVdbChanged?: (delta: number) => void;
  private readonly onSkillCreated?: SkillVersioningOptions["onSkillCreated"];

  constructor(opts: SkillVersioningOptions) {
    this.store = opts.store;
    this.resources = opts.resources;
    this.storage = opts.storage;
    this.logger = opts.logger;
    this.onSkillVdbChanged = opts.onSkillVdbChanged;
    this.onSkillCreated = opts.onSkillCreated;
  }

  /**
   * 创建一个全新 skill 的 v1。head 不存在；调用方负责生成 skill_id。
   */
  async createNewSkill(
    skillId: string,
    ownerAgentId: string,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = 1;
    const storageDir = this.resources.versionDir(skillId, newVersion);

    // 0. 前置：v1 首创时同步登记资产（钩子必须 await）。
    //    放在 storage / DB 之前，任何失败都直接中断 create，
    //    避免出现「skill 已落库但 asset 不存在」这一前端管控页不可见的严重状态。
    //    孤儿 asset（asset 存在但 skill 未落库）是可自愈的：下次同 skill_id
    //    重试会命中上层 ensureSkillAsset 的幂等短路，无副作用。
    if (this.onSkillCreated) {
      await this.onSkillCreated({
        skill_id: skillId,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        user_id: ctx.user_id,
        name: mut.name,
        description: mut.description,
      });
    }

    // 整 skill 总大小聚合校验（设计 §3.5.1：≤ 50MB）。
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      this.resources.assertTotalSize([], mut.resourcesToWrite, []);
    }

    // 先落 storage（如果有资源），失败 → 不写 DB
    let manifest: SkillManifestEntry[] = [];
    if (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) {
      try {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(skillId, newVersion, p);
          manifest.push(entry);
        }
      } catch (e) {
        // best-effort 清理
        await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
        throw e;
      }
    }

    try {
      const row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: skillId,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: computeContentHash(mut.content),
        manifest,
        storage_dir: storageDir,
        owner_agent_id: ownerAgentId,
        metadata_json: mut.metadata_json,
      });
      this.onSkillVdbChanged?.(1);
      return row;
    } catch (e) {
      // DB 写失败 → 清理刚刚创建的 storage 目录
      await this.cleanupVersionDir(storageDir).catch(() => { /* ignore */ });
      throw e;
    }
  }

  /**
   * 在已有 head 之上追加新版本。head 必须存在（调用方先调 store.getHead 拿到）。
   *
   * 内容未变（content_hash 相同）且无资源变更 → 返回 head（幂等，不写 storage / DB）。
   */
  async appendNextVersion(
    head: Skill,
    ctx: AppendVersionContext,
    mut: AppendVersionMutation,
  ): Promise<Skill> {
    const newVersion = head.version + 1;
    const newStorageDir = this.resources.versionDir(head.skill_id, newVersion);
    const oldStorageDir = head.storage_dir;
    const newContentHash = computeContentHash(mut.content);

    const noContentChange = newContentHash === head.content_hash;
    const noResourceChange =
      (!mut.resourcesToWrite || mut.resourcesToWrite.length === 0) &&
      (!mut.resourcesToRemove || mut.resourcesToRemove.length === 0);

    if (noContentChange && noResourceChange) {
      return head; // 幂等
    }

    // 整 skill 总大小聚合校验（设计 §3.5.1：≤ 50MB）。
    if (
      (mut.resourcesToWrite && mut.resourcesToWrite.length > 0) ||
      (mut.resourcesToRemove && mut.resourcesToRemove.length > 0)
    ) {
      this.resources.assertTotalSize(
        head.manifest,
        mut.resourcesToWrite,
        mut.resourcesToRemove,
      );
    }

    // 1) 拷贝旧版本目录到新版本目录（如果旧版本有内容）
    try {
      await this.storage.copyTree(oldStorageDir, newStorageDir);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // 如果旧版本根本没目录（旧 skill 创建时无资源），跳过 copy
      if (!/STORAGE_NOT_FOUND/.test(msg)) {
        throw e;
      }
    }

    // 2) 在新版本目录上应用资源变更
    let manifest: SkillManifestEntry[] = [...head.manifest];
    try {
      if (mut.resourcesToRemove) {
        for (const p of mut.resourcesToRemove) {
          await this.resources.removeResource(head.skill_id, newVersion, p);
          manifest = manifest.filter((m) => m.path !== p);
        }
      }
      if (mut.resourcesToWrite) {
        for (const p of mut.resourcesToWrite) {
          const entry = await this.resources.writeResource(head.skill_id, newVersion, p);
          // 合并到 manifest（覆盖同 path）
          manifest = manifest.filter((m) => m.path !== entry.path);
          manifest.push(entry);
        }
      }
    } catch (e) {
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }

    // 3) 写 DB（事务内 + fts 同步）
    try {
      const row = await this.store.appendVersion({
        user_id: ctx.user_id,
        team_id: ctx.team_id,
        agent_id: ctx.agent_id,
        task_id: ctx.task_id,
        skill_id: head.skill_id,
        name: mut.name,
        description: mut.description,
        content: mut.content,
        content_hash: newContentHash,
        manifest,
        storage_dir: newStorageDir,
        owner_agent_id: head.owner_agent_id,
        metadata_json: mut.metadata_json ?? head.metadata_json,
      });
      this.onSkillVdbChanged?.(1);
      return row;
    } catch (e) {
      // DB 失败 → 清理刚 copy 的新目录
      // 注：store.appendVersion 不再做 hash 幂等（由本类早期 short-circuit 处理），
      // 因此不会抛 IdempotentNoOpError；类型仍保留导出供外部 import 一处即可。
      await this.cleanupVersionDir(newStorageDir).catch(() => { /* ignore */ });
      throw e;
    }
  }

  // ─────────────────────────────────────────────────
  //  helpers
  // ─────────────────────────────────────────────────

  private async cleanupVersionDir(dir: string): Promise<void> {
    if (!dir) return;
    try { await this.storage.rmdir(dir); } catch { /* ignore */ }
  }

  // ─────────────────────────────────────────────────
  //  真删除：一次性删掉某 skill 的所有版本（含 storage 与 shark 上报）
  // ─────────────────────────────────────────────────

  /**
   * 物理删除一整个 skill（含所有版本行 + 每个版本的 storage 目录）。
   *
   * 编排语义：
   *   1. 先 listVersions 拿到所有版本的 storage_dir（DB 是权威源，先读后删）
   *   2. store.deleteAllVersions —— 一次性 DELETE 所有版本行 + 清 fts / vec
   *   3. 逐版本 rmdir storage（失败仅 warn，不回滚 DB）
   *   4. 汇总一次 `onSkillVdbChanged(-N)`（N = 实际删除的行数）
   *      —— 与 TTL 路径逐行 `onSkillVdbChanged(-1)` 不同，delete 走整块上报，
   *      减少 shark HTTP 请求；语义上都是 shark MemoryDelta 累加。
   *
   * 返回实际删除的行数。skill 不存在时返回 0，不触发上报（避免虚报）。
   *
   * 权限校验（team_id / owner / expected_version）由调用方 SkillCore.delete
   * 完成。本方法不做业务规则校验，只按 (skill_id, team_id) 做物理清理。
   */
  async deleteSkill(skillId: string, teamId?: string): Promise<number> {
    // 1. 先拉全量版本元信息（拿 storage_dir）。listVersions 上限 1000，
    //    单 skill 版本数在 TTL 保护 + 业务上限下远小于此值。
    const versions = await this.store.listVersions(skillId, teamId, { limit: 1000, offset: 0 });

    // 2. 物理删 DB 行
    const deleted = await this.store.deleteAllVersions(skillId, teamId);
    if (deleted <= 0) {
      // 什么都没删（skill 不存在 / team 不匹配）→ 不上报，不清 storage
      return 0;
    }

    // 3. 清 storage 目录（失败仅 warn）—— 用 listVersions 拿到的 dir，
    //    而不是拼路径，容忍历史版本 storage_dir 命名不一致的情况。
    for (const v of versions) {
      if (!v.storage_dir) continue;
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-delete] storage rmdir failed for ${v.storage_dir}`);
      }
    }

    // 4. 一次性上报 shark（-N）
    this.onSkillVdbChanged?.(-deleted);

    return deleted;
  }

  // ─────────────────────────────────────────────────
  //  TTL：写后清理过期旧版本
  // ─────────────────────────────────────────────────

  private static readonly KEEP_RECENT = 3;

  /**
   * 清理指定 skill 的过期非 head 版本（先删 DB 行，后删 storage 目录）。
   * fire-and-forget 调用，不抛异常。
   */
  async cleanupExpiredVersionsForSkill(
    skillId: string,
    ttlSeconds: number,
    now?: number,
  ): Promise<void> {
    if (ttlSeconds <= 0) return;

    const nowMs = now ?? Date.now();
    const cutoffMs = nowMs - ttlSeconds * 1000;
    const all = await this.store.listVersions(skillId);
    if (!all.length) return;

    // archived skill 整组保护
    const head = all.find((v) => v.is_head);
    if (!head || head.status === "archived") return;

    // version DESC
    const sorted = [...all].sort((a, b) => b.version - a.version);
    // KEEP_RECENT 保护最近 N 个非 head 版本（即使过期）
    const protectedVersions = new Set(
      sorted.filter((v) => !v.is_head).slice(0, SkillVersioning.KEEP_RECENT).map((v) => v.version),
    );

    for (const v of sorted) {
      if (v.is_head) continue;
      if (protectedVersions.has(v.version)) continue;
      if (v.created_at_ms >= cutoffMs) continue;

      // 先删 DB 行（数据源），再删 storage 目录（附属物）
      const deleted = await this.store.deleteVersion(v.skill_id, v.version);
      if (!deleted) continue;

      // 上报 VDB 删除（负值）
      this.onSkillVdbChanged?.(-1);

      // storage 删除失败仅记日志，不影响 DB 的正确性
      try {
        await this.storage.rmdir(v.storage_dir);
      } catch {
        this.logger?.warn(`[skill-ttl] storage rmdir failed for ${v.storage_dir}`);
      }
    }
  }

}

// 重新导出错误类型，让上层 import 一处即可
export { IdempotentNoOpError, SkillStoreError, SkillResourceError };
