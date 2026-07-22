/**
 * teamApi.ts — team-memory-control 新面板 Control API 封装层。
 *
 * 对接文档（唯一权威）：
 *   - docs/architecture/09-new-panel-control-backend-design.md  新面板设计（Header 鉴权、登录流程）
 *   - docs/api/meta-api.openapi.yaml                            前端对接契约（机器可读）
 *
 * 规则（新面板 · 无 Cookie · 无状态）：
 *   - 元数据 CRUD 统一走 POST /api/v1/meta/{action}；
 *   - 鉴权由前端 sessionStorage 缓存 instance_id + user_key（见 lib/panelSession.ts），
 *     每次请求注入 Header X-Tdai-Service-Id + X-Tdai-User-Key（auth/verify 除外，
 *     该接口 user_key 只放 body，不放 Header）；
 *     ⚠️ Header 名以 meta-api.openapi.yaml v1.1.0 为准：instance 的 Header 名是
 *     `X-Tdai-Service-Id`（不是早期版本用过的 `X-Metadata-Instance-Id`），改名后未同步
 *     会导致 Control 报 400 MISSING_INSTANCE_ID。
 *   - asset/* 域已放开（skill「分配到 Agent」走授权接口：先 asset/create 登记
 *     再 acl/grant）；agent-fixed-asset/*（运行时固定注入）仍 501 NOT_IN_SCOPE。
 *     注：PANEL_CAPABILITIES.assets 仍为 false —— 它只控制通用「资产」UI 是否展示
 *     占位，skill 挂载走 v3 数据面 fork（skillApi.forkToAgent），不受该开关影响；
 *   - 一期不注册 /api/v1/auth/*、/users/*（OAuth、Cookie 会话、environment-bindings 等）；
 *   - 所有函数返回 Promise<T>，失败抛 ApiError。
 */
import { getPanelSession, clearPanelSession } from './panelSession';
import { formatApiErrorMessage } from './error-message';

/**
 * 新面板一期能力开关（对齐 09 设计文档 §4.6、§9 N6）。
 * UI 消费 assetsApi / agentsApi.getAssets|getFixedAssets|setFixedAssets 前应先判断
 * `PANEL_CAPABILITIES.assets`，为 false 时展示"暂未开放"占位，不要发起注定 501 的请求。
 */
export const PANEL_CAPABILITIES = {
  assets: false,
} as const;

// ========================= Error =========================

export class ApiError extends Error {
  public code?: number | string;
  public requestId?: string;
  public rawMessage?: string;

  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    opts: { code?: number | string; requestId?: string; rawMessage?: string } = {}
  ) {
    super(formatApiErrorMessage({
      code: opts.code,
      message: opts.rawMessage ?? statusText,
      requestId: opts.requestId,
      httpStatus: status,
      httpStatusText: statusText,
      body,
    }));
    this.name = 'ApiError';
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.rawMessage = opts.rawMessage ?? statusText;
  }
}

// ========================= Base Request =========================

const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

/** 发出 401 事件，App 层监听后清 auth state 展示登录页 */
function emitUnauthorized() {
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
}

/** 监听 401 事件 */
export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
}

function parseMetaErrorEnvelope(text: string): {
  code?: number | string;
  requestId?: string;
  rawMessage?: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const env = JSON.parse(trimmed) as MetaEnvelope<unknown>;
    if (typeof env?.message === 'string' && env.message.trim()) {
      return {
        code: env.code,
        requestId: env.request_id,
        rawMessage: env.message,
      };
    }
  } catch {
    /* non-JSON error body */
  }
  return {};
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    emitUnauthorized();
    throw new ApiError(res.status, res.statusText, 'Unauthorized');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const env = parseMetaErrorEnvelope(text);
    throw new ApiError(res.status, res.statusText, text, env);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ========================= Meta API（/api/v1/meta/*，新面板链路 A）=========================

interface MetaEnvelope<T> {
  code: number;
  message: string;
  request_id: string;
  data: T | null;
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

const META_PREFIX = '/api/v1/meta';
const META_PAGE_SIZE = 100;

/**
 * 登出 / 401 时清空前端会话（instance_id + user_key + user 缓存）。
 * 新面板无 Cookie，"清会话"就是清 sessionStorage，不涉及后端调用。
 */
export function clearSessionCache(): void {
  clearPanelSession();
}

/** 从当前会话取 user_id 归属的当前登录用户；未登录抛错（调用方应先保证已登录）。 */
async function getCurrentUser(): Promise<PublicUser> {
  const session = getPanelSession();
  if (!session?.user) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return session.user;
}

/**
 * 内核 meta 透明代理的公共调用：注入指定 Header，POST body，解析信封。
 * `auth/verify` 走此函数但只传 X-Tdai-Service-Id（不带 user-key），
 * 其余 action 走 `metaPost`（自动从 session 注入双 Header）。
 */
async function metaCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${META_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty meta response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty meta response',
    });
  }
  return envelope.data;
}

async function metaPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return metaCall<T>(action, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
}

async function metaListAll<T>(action: string, body: Record<string, unknown>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await metaPost<PaginatedResult<T>>(action, {
      ...body,
      limit: META_PAGE_SIZE,
      offset,
    });
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) break;
  }
  return items;
}

/**
 * 「请求进行中去重」：同一 key 上一次发起尚未 settle 时，复用同一个 Promise，
 * 请求结束后立即从表中移除（不做结果缓存）。
 *
 * 用途：消除 React 18 StrictMode 开发态对 effect 的双调用、以及组件并发挂载
 * 造成的同一接口重复网络请求。
 *
 * 约束：只能用于**幂等只读**接口（list/get）。create/revoke 等写操作严禁复用，
 * 否则会把两次独立写合并成一次。
 */
const inFlightReads = new Map<string, Promise<unknown>>();
function dedupeInFlight<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = factory().finally(() => {
    inFlightReads.delete(key);
  });
  inFlightReads.set(key, p);
  return p;
}

function newExternalAssetId(assetType: AssetType): string {
  const prefix = { skill: 'skl', llm_wiki: 'wiki', code_graph: 'cg', chat_memory: 'mem' }[assetType];
  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}-${suffix}`;
}

// ========================= Types =========================

/** 内核 user/create 响应（CreateUserResult） — 不含 username，含一次性密钥 */
export interface CreateUserResult {
  user_id: string;
  user_type: 'normal' | 'system_admin';
  created_at: string;
  /** 默认 API 密钥明文，仅此次响应返回 */
  default_user_key: string;
}

export interface PublicUser {
  user_id: string;
  auth_provider: string;
  external_id: string;
  username: string;
  display_name?: string;
  email?: string;
  status: 'active' | 'inactive' | 'invited';
  created_at: string;
  updated_at: string;
  /**
   * 全局用户类型（内核 auth/verify、user/get、user/list 均会返回），
   * 'system_admin' = 全局唯一的 admin 身份，与 team 无关；其余（如 'user'）都是普通用户。
   * 这是判断"当前登录用户是不是 admin"的唯一权威字段——不要再用 username === 'admin' 兜底猜。
   */
  user_type?: 'system_admin' | 'user' | string;
}

export interface Team {
  team_id: string;
  name: string;
  description?: string;
  owner_user_id: string;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamMember {
  id: string;
  team_id: string;
  user_id: string;
  role: 'admin' | 'member' | 'reviewer';
  joined_at: string;
  status: 'active' | 'removed';
  /** team-member/list · get 响应附带（读时 JOIN，v3.2.2+） */
  username?: string;
}

export interface Agent {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string;
  prompt?: string;
  visibility: 'private' | 'task' | 'agent' | 'team' | 'restricted';
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export type AssetType = 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';
export type AssetStatus = 'draft' | 'candidate' | 'approved' | 'deprecated' | 'archived';

export interface Asset {
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string;
  owner_user_id: string;
  source_type: 'uploaded' | 'url' | 'extracted' | 'synced';
  source_ref?: string;
  version: number;
  visibility: 'private' | 'task' | 'agent' | 'team' | 'restricted';
  status: AssetStatus;
  confidence?: number;
  expires_at?: string;
  last_used_at?: string;
  usage_count: number;
  content_ref?: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface AgentAssetView {
  asset_id: string;
  asset_type: AssetType;
  name: string;
  description?: string;
  status: AssetStatus;
  visibility: string;
  injection_mode: 'direct' | 'summary' | 'tool' | 'reference';
  priority: number;
  created_at: string;
}

export interface FixedAssetBinding {
  asset_id: string;
  asset_type: AssetType;
  injection_mode?: 'direct' | 'summary' | 'tool' | 'reference';
  priority?: number;
}

// ========================= Meta Instances（登录前选实例）=========================

/**
 * 客户端可见的实例元信息。
 *   - `api_key`（真 secret）不下发。
 *   - `gateway_endpoint` 是客户端接入 baseUrl，本来就要给用户配到 CodeBuddy /
 *     ClaudeCode CLI 里，不属于 secret；每个实例独立（dev/staging/prod 不同），
 *     前端不能硬编码。
 */
export interface MetadataInstance {
  instance_id: string;
  name: string;
  gateway_endpoint: string;
}

export const metaInstancesApi = {
  /** 登录前选实例；GET /api/v1/meta/instances，公开、无需鉴权、无分页 */
  list: () =>
    dedupeInFlight('meta/instances', () =>
      request<{ instances: MetadataInstance[] }>('GET', '/api/v1/meta/instances').then((r) => r.instances),
    ),
};

// ========================= Auth（选实例 + user_key + auth/verify）=========================
//
// 新面板登录流程（09 设计文档 §3.3.1）：
//   ① GET /meta/instances 选实例
//   ② 用户输入自持的 user_key（sk-mem-…）
//   ③ POST /meta/auth/verify（Header 仅 X-Tdai-Service-Id，body 带 user_key）
//   ④ data.valid === true → 登录成功，前端把 { instance_id, user_key, user } 写入 session
// 无 OAuth、无 Cookie、Control 不落库；见 lib/panelSession.ts。

export const authVerifyApi = {
  /** 登录验活：Header 仅带实例 ID，user_key 只放 body（meta-api.openapi.yaml §auth/verify） */
  verify: (instanceId: string, userKey: string) =>
    metaCall<{ valid: boolean; user?: PublicUser }>(
      'auth/verify',
      { user_key: userKey },
      { 'X-Tdai-Service-Id': instanceId }
    ),
};

// ========================= Environment Bindings =========================
//
// ⚠️ 新面板一期不注册 /api/v1/users/* 路由（09 设计文档 §6.1、§9 N1），
// 以下接口在新面板 Control 下会 404。保留代码是为了兼容仍跑在链路 B（Legacy）
// 的环境；若某个页面要切到新面板，请先隐藏/置灰调用这组接口的入口。

/**
 * 环境绑定（environment_bindings）：把用户在外部环境（CodeBuddy / Cursor 等）的
 * 外部 user_id 与本平台 user 关联，供 proxy 通过 (environment, environment_user_id)
 * 反查到团队 / agent / task。
 *
 * 唯一约束：(environment, environment_user_id) 全局唯一；被他人占用 → 409。
 */
export interface EnvironmentBinding {
  id: string;
  user_id: string;
  environment: string;
  environment_user_id: string;
  created_at: string;
  updated_at: string;
}

export const environmentBindingsApi = {
  /** 列出当前登录用户的全部绑定 */
  list: () => request<EnvironmentBinding[]>('GET', '/api/v1/users/me/environment-bindings'),

  /** 新增一条绑定（幂等：同 user 重复 POST 同样的 (env, env_user_id) 不报错） */
  create: (data: { environment: string; environment_user_id: string }) =>
    request<EnvironmentBinding>('POST', '/api/v1/users/me/environment-bindings', data),

  /** 删除一条绑定（只能删自己的；删别人 → 403） */
  remove: (id: string) => request<{ ok: boolean }>('DELETE', `/api/v1/users/me/environment-bindings/${id}`),
};

// ========================= Teams（链路 A：meta/team/*）=========================

export const teamsApi = {
  /**
   * 列出当前用户作为 active 成员的 team（内核 listTeamsByUser）。
   * 内核 /v3/meta/team/list 要求 body 带 user_id 或 user_key；身份只在 header 不够。
   * admin 也传自己的 user_id（后端暂无 user/list 式「实例级列举全部 team」）。
   */
  list: async () => {
    const me = await getCurrentUser();
    return metaListAll<Team>('team/list', { user_id: me.user_id });
  },

  /** team 详情 */
  get: (teamId: string) => metaPost<Team>('team/get', { team_id: teamId }),

  /** 创建 team */
  create: async (data: { name: string; description?: string }) => {
    const me = await getCurrentUser();
    return metaPost<Team>('team/create', {
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
    });
  },

  /** 更新 team */
  update: (teamId: string, data: { name?: string; description?: string }) =>
    metaPost<Team>('team/update', { team_id: teamId, ...data }),

  /** 删除 team（meta team/delete） */
  delete: (teamId: string) => metaPost<{ ok: boolean }>('team/delete', { team_id: teamId }),
};

// ========================= Members（链路 A：meta/team-member/*）=========================

export const membersApi = {
  /** 列出 team 成员 */
  list: (teamId: string) => metaListAll<TeamMember>('team-member/list', { team_id: teamId }),

  /**
   * 添加成员（按已知 user_id 加入 team）。
   *
   * 新面板下"开号"（拿到 user_key）与"加入 team"是两件独立的事：用户自行持有
   * user_key 登录后即可从 auth/verify 拿到自己的 user_id；team 管理员只需要
   * 已知这个 user_id 就能调 team-member/add（标准 meta action，非阻断）。
   * 没有"按用户名建户"的等价能力——若要按用户名查找 user_id，可用 `usersApi.list`
   * 传入 `{ username }` 做精确匹配（与内核 user/list 一致）。
   */
  add: (teamId: string, data: { user_id: string; role: 'admin' | 'member' | 'reviewer' }) =>
    metaPost<TeamMember>('team-member/add', { team_id: teamId, user_id: data.user_id, role: data.role }),

  /** 移除成员 */
  remove: async (teamId: string, userId: string) => {
    await metaPost<{ ok: boolean }>('team-member/remove', { team_id: teamId, user_id: userId });
  },
};

// ========================= Agents（链路 A：meta/agent/* + meta/agent-fixed-asset/*）=========================

export const agentsApi = {
  /**
   * 列出 team 下的 agents。
   *
   * @param teamId team ID
   * @param params.owner_user_id 可选：只返该 user owner 的 agent（"agent 私有可见性"场景，
   *   如 Skill 面板固定资产 tab）；不传则返 team 全量。内核 `agent/list` schema 已支持
   *   `team_id + owner_user_id` 组合过滤。
   */
  list: (teamId: string, params?: { owner_user_id?: string }) =>
    metaListAll<Agent>('agent/list', {
      team_id: teamId,
      status: 'active',
      owner_user_id: params?.owner_user_id,
    }),

  /** agent 详情 */
  get: (agentId: string) => metaPost<Agent>('agent/get', { agent_id: agentId }),

  /** 创建 agent */
  create: async (
    teamId: string,
    data: { name: string; description?: string; prompt?: string; visibility?: string }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Agent>('agent/create', {
      team_id: teamId,
      owner_user_id: me.user_id,
      name: data.name,
      description: data.description,
      prompt: data.prompt,
      visibility: data.visibility ?? 'team',
    });
  },

  /**
   * 更新 agent。
   *
   * `metadata_json` 是给前端自定义关系的兜底通道：后端 schema 未落地的展示字段
   * （如 icon / accent / 关联 user 等 UI-only 字段）可以序列化进这里的自定义 namespace。
   */
  update: (
    agentId: string,
    data: {
      name?: string;
      description?: string;
      prompt?: string;
      visibility?: string;
      status?: string;
      metadata_json?: string;
    }
  ) => metaPost<Agent>('agent/update', { agent_id: agentId, ...data }),

  /**
   * 删除 agent：走 control 层业务路由 /api/v1/agent/delete-cascade。
   *
   * 该路由会先把 owner_agent_id = 当前 agent 的所有 active skill 走 skill/delete，
   * 全部成功后才调 meta/agent/archive；任一 skill 删失败即中断，agent 不会被 archive，
   * 抛出 SKILL_DELETE_FAILED 让调用方给用户展示（错误 data 里带上已删的 skill_ids
   * 和失败的 skill_id）。
   *
   * 内核 archiveAgent 会顺手清 chat_memory asset，这部分行为不变。
   */
  delete: async (agentId: string) => {
    const session = getPanelSession();
    if (!session) {
      throw new ApiError(401, 'Unauthorized', 'no active panel session');
    }
    const envelope = await request<MetaEnvelope<{
      archived: boolean;
      agent_id: string;
      deleted_skill_count: number;
      deleted_skill_ids: string[];
    }>>('POST', '/api/v1/agent/delete-cascade', { agent_id: agentId }, {
      'X-Tdai-Service-Id': session.instanceId,
      'X-Tdai-User-Key': session.userKey,
    });
    if (envelope.code !== 0) {
      throw new ApiError(200, envelope.message, '', {
        code: envelope.code,
        requestId: envelope.request_id,
        rawMessage: envelope.message,
      });
    }
  },

  /** 获取 agent 的资产聚合视图（binding + asset 详情） */
  getAssets: async (agentId: string) => {
    const detail = await metaPost<{
      items: Array<{
        asset_id: string;
        asset_type: AssetType;
        name: string;
        description?: string;
        status: AssetStatus;
        visibility: string;
        injection_mode: FixedAssetBinding['injection_mode'];
        priority: number;
        created_at: string;
      }>;
    }>('agent-fixed-asset/list-with-detail', {
      agent_id: agentId,
      apply_visibility_filter: true,
      touch_usage: false,
    });
    return detail.items.map((item) => ({
      asset_id: item.asset_id,
      asset_type: item.asset_type,
      name: item.name,
      description: item.description,
      status: item.status,
      visibility: item.visibility,
      injection_mode: item.injection_mode ?? 'direct',
      priority: item.priority,
      created_at: item.created_at,
    }));
  },

  /** 获取 agent 固定资产 binding（仅 binding 字段） */
  getFixedAssets: async (agentId: string) => {
    const rows = await metaListAll<{
      asset_id: string;
      asset_type: AssetType;
      injection_mode?: FixedAssetBinding['injection_mode'];
      priority: number;
    }>('agent-fixed-asset/list', { agent_id: agentId });
    return rows.map((r) => ({
      asset_id: r.asset_id,
      asset_type: r.asset_type,
      injection_mode: r.injection_mode,
      priority: r.priority,
    }));
  },

  /** 全量设置 agent 固定资产 */
  setFixedAssets: async (agentId: string, bindings: FixedAssetBinding[]) => {
    const me = await getCurrentUser();
    await metaPost<{ ok: boolean }>('agent-fixed-asset/set', {
      agent_id: agentId,
      bindings: bindings.map((b) => ({
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? 'direct',
        priority: b.priority ?? 0,
        created_by: me.user_id,
      })),
    });
  },
};

// ========================= Tasks（链路 A：meta/task/* + meta/task-agent/*）=========================

export type TaskStatus = 'running' | 'completed';
export type TaskSourceType = 'manual' | 'tapd' | 'github' | 'other';

export interface BackendTask {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string;
  source_type: TaskSourceType;
  source_url?: string;
  status: TaskStatus;
  auto_assign_floating_assets: number;
  risk_level?: 'low' | 'medium' | 'high';
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface BackendTaskAgent {
  id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string;
  status: 'active' | 'removed';
  created_at: string;
}

export interface BackendTaskWithAgents extends BackendTask {
  agents: BackendTaskAgent[];
}

export const tasksApi = {
  /** 列出 team 下所有 task */
  list: (teamId: string) => metaListAll<BackendTask>('task/list', { team_id: teamId }),

  /** 获取 task 详情（含 linked agents） */
  get: async (taskId: string) => {
    const task = await metaPost<BackendTask>('task/get', { task_id: taskId });
    const agents = await metaListAll<BackendTaskAgent>('task-agent/list', { task_id: taskId });
    return { ...task, agents };
  },

  /** 创建 task */
  create: async (
    teamId: string,
    data: {
      title: string;
      description?: string;
      source_type?: TaskSourceType;
      source_url?: string;
      risk_level?: 'low' | 'medium' | 'high';
      linked_agents?: string[];
    }
  ) => {
    const me = await getCurrentUser();
    return metaPost<BackendTask>('task/create', {
      team_id: teamId,
      creator_user_id: me.user_id,
      title: data.title,
      description: data.description,
      source_type: data.source_type ?? 'manual',
      source_url: data.source_url,
      risk_level: data.risk_level,
      linked_agents: data.linked_agents?.map((agent_id) => ({ agent_id })),
    });
  },

  /** 更新 task（title / status / description / risk_level / source_url） */
  update: (
    taskId: string,
    data: Partial<{
      title: string;
      description: string;
      status: TaskStatus;
      risk_level: 'low' | 'medium' | 'high';
      source_url: string;
    }>
  ) => metaPost<BackendTask>('task/update', { task_id: taskId, ...data }),

  /** 删除 task（meta task/delete，字段为 task_ids 数组） */
  delete: async (taskId: string) => {
    await metaPost<{ deleted_ids: string[] }>('task/delete', { task_ids: [taskId] });
  },

  /** 关联 agent */
  linkAgent: (taskId: string, agentId: string, roleInTask?: string) =>
    metaPost<BackendTaskAgent>('task-agent/link', {
      task_id: taskId,
      agent_id: agentId,
      role_in_task: roleInTask,
    }),

  /** 解除 agent 关联 */
  unlinkAgent: async (taskId: string, agentId: string) => {
    await metaPost<{ ok: boolean }>('task-agent/unlink', { task_id: taskId, agent_id: agentId });
  },
};

// ========================= Participation Logs（meta/participation-log/*）=========================
//
// Session init 完成时由 proxy 侧 append 一条 (team, task, agent, user) 事件；看板据此
// 展示"实际参与 User / Agent"。语义与 `task-agent/link`（人工声明关系）互补：
//   - `linked_agents` = 意图（谁应该干这个 task）
//   - participation_log = 观测（谁实际起过 session）
//
// 内核 `dedupe:true` 只对 user_id 生效，agent 维度需前端自行 dedupe。

export interface ParticipationLogEntity {
  id?: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source?: string;
  metadata_json?: string;
  created_at?: string;
}

export const participationLogsApi = {
  /**
   * 拉取指定 task 的原始参与日志（不走内核 `dedupe`——它只按 user_id 去重，会丢
   * agent 维度信息）。调用侧按 user_id / agent_id 分别 dedupe 得到两份展示列表。
   */
  listByTask: (teamId: string, taskId: string) =>
    metaListAll<ParticipationLogEntity>('participation-log/list', {
      team_id: teamId,
      task_id: taskId,
    }),

  /**
   * 拉取 team 下所有 task 的原始参与日志。列表页用一次请求覆盖 N 个 task 的
   * 统计数字，避免 fanout；前端按 task_id 分桶后再各自 dedupe。
   */
  listByTeam: (teamId: string) =>
    metaListAll<ParticipationLogEntity>('participation-log/list', {
      team_id: teamId,
    }),
};

// ========================= Users（链路 A：meta/user/*，用于按用户名查 user_id）=========================

export const usersApi = {
  /** 分页列出用户；可传入 { username } 精确匹配或 { user_ids } 过滤 */
  list: (params?: { username?: string; user_ids?: string[] }) => metaListAll<PublicUser>('user/list', { ...params }),

  /** 用户详情 */
  get: (userId: string) => metaPost<PublicUser>('user/get', { user_id: userId }),

  /**
   * 新建用户（透明代理至内核 user/create）。
   *
   * 内核响应为 CreateUserResult：含 user_id / user_type / created_at / default_user_key。
   * default_user_key 为一次性明文密钥，仅此次响应返回。
   *
   * ⚠️ 权限：OpenAPI §1.4 — 须 Header X-Tdai-User-Key 为 system_admin；
   *         普通用户 → 内核 403。Legacy 模式 Control 会用 METADATA_SYSTEM_ADMIN_USER_KEY
   *         代调；stateless 模式下 Control 透明代理当前用户 key，需当前用户持有 system_admin 权限。
   *         若团队管理员无 system_admin 权限，此接口会报 403，届时需后端支持。
   */
  create: (data: { username: string; auth_provider: string; external_id: string; display_name?: string; email?: string }) =>
    metaPost<CreateUserResult>('user/create', data),

  /**
   * 删除用户（透明代理至内核 user/delete）。
   *
   * ⚠️ 权限同上，须 system_admin 才能调用。
   */
  delete: (userId: string) => metaPost<{ ok: boolean }>('user/delete', { user_id: userId }),
};

// ========================= User API Keys（meta/user-key/*）=========================
//
// 走标准 meta action（与 team/agent 同模型，双 Header 鉴权），非链路 B 的 REST 包装。

export interface UserKey {
  key_id: string;
  user_id?: string;
  name?: string;
  /** key 的可展示前缀（如 `sk-mem-ab12****`），内核 list/get 返回，用于免密识别具体是哪把 key */
  key_prefix?: string;
  /** 明文 key —— 仅创建响应里出现这一次，之后（list/get）内核不会再回传，安全设计如此 */
  key_value?: string;
  created_at?: string;
  expires_at?: string;
  revoked_at?: string;
  last_used_at?: string;
}

export const userKeysApi = {
  /** 列出当前登录用户的全部 API Key（按内核分页拉全量） */
  list: () => dedupeInFlight('user-key/list', () => metaListAll<UserKey>('user-key/list', {})),

  /** 创建一把新 Key；返回值里的 key_value 明文只展示这一次，调用方需立即展示给用户 */
  create: (data: { name?: string; expires_at?: string; user_id?: string }) => metaPost<UserKey>('user-key/create', data),

  /** 吊销一把 Key */
  revoke: (keyId: string) => metaPost<{ ok: boolean }>('user-key/revoke', { key_id: keyId }),
};

// ========================= User Config（meta/config/user/*）=========================

export type AssetCapabilityKey = 'skill.enabled' | 'llm_wiki.enabled' | 'code_graph.enabled' | 'chat_memory.enabled';

export interface UserConfigItem {
  module: string;
  param_name: AssetCapabilityKey | string;
  param_key: string;
  description: string;
  effective_value: string;
}

export interface UserConfigView {
  user_id: string;
  module: string;
  module_description: string;
  items: UserConfigItem[];
}

export type AssetCapabilityConfig = Record<AssetCapabilityKey, boolean>;

const ASSET_CAPABILITY_KEYS: AssetCapabilityKey[] = [
  'skill.enabled',
  'llm_wiki.enabled',
  'code_graph.enabled',
  'chat_memory.enabled',
];

function boolFromConfigValue(value: string | undefined): boolean {
  return value === undefined ? true : value === '1' || value.toLowerCase() === 'true';
}

export const userConfigApi = {
  get: (userId: string, module: string, paramName?: string) =>
    metaPost<UserConfigView>('config/user/get', { user_id: userId, module, param_name: paramName }),

  set: (userId: string, module: string, params: Record<string, string>) =>
    metaPost<{ ok: boolean }>('config/user/set', { user_id: userId, module, params }),

  getAssetCapabilities: async (): Promise<AssetCapabilityConfig> => {
    const me = await getCurrentUser();
    const view = await userConfigApi.get(me.user_id, 'asset_type');
    const byName = new Map(view.items.map((it) => [it.param_name, it.effective_value]));
    return Object.fromEntries(
      ASSET_CAPABILITY_KEYS.map((key) => [key, boolFromConfigValue(byName.get(key))]),
    ) as AssetCapabilityConfig;
  },

  setAssetCapability: async (key: AssetCapabilityKey, enabled: boolean) => {
    const me = await getCurrentUser();
    return userConfigApi.set(me.user_id, 'asset_type', { [key]: enabled ? '1' : '0' });
  },
};

// ========================= Assets（链路 A：meta/asset/*）=========================

export const assetsApi = {
  /** 列出 team 资产（支持按 type/status/owner 筛选） */
  list: (
    teamId: string,
    params?: { asset_type?: AssetType; status?: AssetStatus; owner_user_id?: string }
  ) =>
    metaListAll<Asset>('asset/list', {
      team_id: teamId,
      asset_type: params?.asset_type,
      status: params?.status,
      owner_user_id: params?.owner_user_id,
    }),

  /** 资产详情 */
  get: (assetId: string) => metaPost<Asset>('asset/get', { asset_id: assetId }),

  /** 创建/登记资产（两段式：内核主表 + Control 本地详情表） */
  create: async (
    teamId: string,
    data: {
      asset_type: AssetType;
      name: string;
      description?: string;
      source_type?: string;
      content_ref?: string;
      visibility?: string;
      metadata_json?: string;
      detail?: Record<string, unknown>;
    }
  ) => {
    const me = await getCurrentUser();
    return metaPost<Asset>('asset/create', {
      asset_id: newExternalAssetId(data.asset_type),
      team_id: teamId,
      asset_type: data.asset_type,
      name: data.name,
      description: data.description,
      owner_user_id: me.user_id,
      source_type: data.source_type ?? 'uploaded',
      content_ref: data.content_ref,
      visibility: data.visibility ?? 'team',
      metadata_json: data.metadata_json,
      detail: data.detail,
    });
  },

  /** 更新资产 */
  update: (
    assetId: string,
    data: Partial<{ name: string; description: string; status: AssetStatus; visibility: string }>
  ) => metaPost<Asset>('asset/update', { asset_id: assetId, ...data }),

  /** 删除资产（meta asset/delete → 物理删除行） */
  delete: async (assetId: string) => {
    await metaPost<{ deleted_ids: string[] }>('asset/delete', { asset_ids: [assetId] });
  },

  /**
   * 列出当前用户在指定 team 内**可访问**的资产（走内核 permission-checker，
   * 严格执行 visibility × ACL 过滤）。
   *
   * 与 asset/list 的区别：
   *   - asset/list：SQL 直查 meta_assets，不做 visibility/ACL 过滤，adminOps 视角。
   *   - asset/list-accessible：先按 visibility × role × ACL 计算可见集合，
   *     私密 skill 别人自动看不到；owner 优先放行。
   *
   * 可选 `visibility` 参数：在服务端做二次白名单过滤（例 `['team']` 只返回
   * 团队共享的），避免\"响应体带全量、前端 JS 过滤\"的信息泄露风险。
   *
   * 用于"团队资产"tab —— 团队成员应该只看到"团队公开 + 自己私密 + 显式授权"三部分。
   */
  listAccessible: async (
    teamId: string,
    params?: {
      asset_type?: AssetType;
      action?: 'read' | 'write' | 'use';
      visibility?: Asset['visibility'] | Asset['visibility'][];
    }
  ): Promise<Asset[]> => {
    const me = await getCurrentUser();
    return metaListAll<Asset>('asset/list-accessible', {
      user_id: me.user_id,
      team_id: teamId,
      asset_type: params?.asset_type,
      action: params?.action ?? 'read',
      visibility: params?.visibility,
    });
  },
};

// ========================= Skill 数据面（/api/v1/skill/*，内核 /v3/skill/*）=========================
//
// 对接文档：tdai-memory-openclaw-plugin/docs/skill-api-for-frontend.md
//
// 与 meta 链路的关键区别：
//   - skill 有独立存储与主键 skill_id（前缀 skl-），团队内可读、owner agent 可写；
//   - 身份字段（user_id / team_id / agent_id）放在 body，不放 Header（鉴权 Header
//     仍是 X-Tdai-Service-Id + X-Tdai-User-Key，与 meta 一致）；
//   - 写操作（create/update/patch/delete/files.*）需带 agent_id（= owner），
//     update/patch/delete/files.* 还需 expected_version 乐观锁；
//   - 分页用嵌套 pagination.{limit,offset}。
//
// 「挂载到 Agent」的语义：让 skill 真正归属某 agent 的唯一机制是 fork —— 复制一份
// owner_agent_id=目标 agent 的独立副本（见 skillApi.forkToAgent）。acl/grant 只改
// meta 授权层，对「固定资产」tab 与运行时注入（均按 owner_agent_id）无效。

export interface SkillSummary {
  skill_id: string;
  name: string;
  description: string;
  version: number;
  is_head: boolean;
  status: 'active' | 'archived';
  owner_user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  metadata?: Record<string, unknown>;
}

export interface SkillManifestEntry {
  path: string;
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
}

export interface SkillDetail extends SkillSummary {
  content: string;
  manifest: SkillManifestEntry[];
  content_hash?: string;
  storage_dir?: string;
}

export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime_type?: string;
  is_executable?: boolean;
}

export interface SkillFileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size_bytes: number;
  mime_type: string;
  version: number;
}

const SKILL_PREFIX = '/api/v1/skill';

/** skill 数据面调用：注入双 Header，POST body，解析信封（code!=0 抛 ApiError）。 */
async function skillCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${SKILL_PREFIX}/${action}`, body, headers);
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || 'empty skill response', '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || 'empty skill response',
    });
  }
  return envelope.data;
}

async function skillPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return skillCall<T>(action, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
}

export const skillApi = {
  /** 列出 team 下的 head skill（分页拉全量；可选按 owner agent / 名称前缀 / 状态过滤） */
  list: async (
    teamId: string,
    opts?: { ownerAgentId?: string; namePrefix?: string; status?: Array<'active' | 'archived'> }
  ): Promise<SkillSummary[]> => {
    const me = await getCurrentUser();
    const items: SkillSummary[] = [];
    let offset = 0;
    for (;;) {
      const page = await skillPost<{ items: SkillSummary[]; total: number }>('list', {
        user_id: me.user_id,
        team_id: teamId,
        filters: {
          owner_agent_id: opts?.ownerAgentId,
          name_prefix: opts?.namePrefix,
          status: opts?.status ?? ['active'],
        },
        pagination: { limit: META_PAGE_SIZE, offset },
      });
      items.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || offset >= page.total) break;
    }
    return items;
  },

  /** 列出某个 agent 拥有（owner）的 skill */
  listByAgent: (teamId: string, agentId: string): Promise<SkillSummary[]> =>
    skillApi.list(teamId, { ownerAgentId: agentId }),

  /** 获取 skill 详情（含 SKILL.md 正文 + 资源清单） */
  get: async (teamId: string, skillId: string): Promise<SkillDetail> => {
    const me = await getCurrentUser();
    return skillPost<SkillDetail>('get', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      include_content: true,
      include_manifest: true,
    });
  },

  /** 读取单个资源文件内容 */
  filesRead: async (teamId: string, skillId: string, path: string): Promise<SkillFileContent> => {
    const me = await getCurrentUser();
    return skillPost<SkillFileContent>('files/read', {
      user_id: me.user_id,
      team_id: teamId,
      skill_id: skillId,
      path,
    });
  },

  /** 创建 skill（agentId 将成为 owner_agent_id） */
  create: async (
    teamId: string,
    agentId: string,
    data: { name: string; content: string; resources?: SkillResourcePayload[]; metadata?: Record<string, unknown> }
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('create', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      name: data.name,
      content: data.content,
      resources: data.resources,
      metadata: data.metadata,
    });
  },

  /** 软删除（归档）；需 owner agent_id + expected_version 乐观锁 */
  delete: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number
  ): Promise<{ skill_id: string; archived: boolean }> => {
    const me = await getCurrentUser();
    return skillPost<{ skill_id: string; archived: boolean }>('delete', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
    });
  },

  /** 全量更新 SKILL.md 内容；需 owner agent_id + expected_version */
  update: async (
    teamId: string,
    agentId: string,
    skillId: string,
    expectedVersion: number,
    content: string
  ): Promise<SkillSummary> => {
    const me = await getCurrentUser();
    return skillPost<SkillSummary>('update', {
      user_id: me.user_id,
      team_id: teamId,
      agent_id: agentId,
      skill_id: skillId,
      expected_version: expectedVersion,
      content,
    });
  },

  /** 团队范围搜索 skill */
  search: async (
    teamId: string,
    query: string,
    opts?: { topK?: number; scope?: 'team' }
  ): Promise<Array<SkillSummary & { score: number; snippet: string }>> => {
    const me = await getCurrentUser();
    const res = await skillPost<{ items: Array<SkillSummary & { score: number; snippet: string }> }>('search', {
      user_id: me.user_id,
      team_id: teamId,
      query,
      top_k: opts?.topK ?? 10,
      scope: opts?.scope ?? 'team',
    });
    return res.items;
  },

  /**
   * Fork skill 给 Agent —— 复制一份独立副本，`owner_agent_id` = 目标 agent。
   *
   * 为什么用 fork 而不是 meta 授权（acl/grant）：
   *   - 「固定资产」tab（SkillsPanel）按 `owner_agent_id` 过滤展示；
   *   - agent 运行时注入 `<available_skills>`（/skill/listing → core.list）同样按
   *     `owner_agent_id` 过滤（skill-core.ts：`owner_agent_id = agent_id`）。
   *   两处读取都认 `owner_agent_id`，而 acl/grant 只改 meta 授权层，对它们均无效。
   *   因此让 skill 真正归属某 agent 的唯一机制就是复制一份 owner=该 agent 的副本。
   *
   * 命名：副本沿用**源 skill 原名**，不加后缀。skill 唯一约束是
   * (team_id, owner_agent_id, name)：同一 team 允许多个同名副本（分属不同 agent），
   * 但同一 agent 下重名会被后端拒绝（42201）——此时向上抛错，由调用方提示。
   *
   * 实现：getSkill（源正文 + 清单）→ filesRead（逐个资源，单个失败跳过）→
   *       create（name=原名，agent_id=目标 agent 即 owner）。
   */
  forkToAgent: async (
    teamId: string,
    sourceSkillId: string,
    targetAgentId: string
  ): Promise<SkillSummary> => {
    const detail = await skillApi.get(teamId, sourceSkillId);
    const resources: SkillResourcePayload[] = [];
    for (const entry of detail.manifest ?? []) {
      try {
        const f = await skillApi.filesRead(teamId, sourceSkillId, entry.path);
        resources.push({
          path: f.path,
          content: f.content,
          encoding: f.encoding,
          mime_type: f.mime_type || undefined,
          is_executable: entry.is_executable || undefined,
        });
      } catch {
        /* 单个资源读取失败则跳过，不阻断 fork 主流程 */
      }
    }
    return skillApi.create(teamId, targetAgentId, {
      name: detail.name,
      content: detail.content,
      resources: resources.length ? resources : undefined,
      // 血缘：记录 fork 自哪个源 skill，供从副本反查源、避免重复 fork。
      metadata: { forked_from: { skill_id: sourceSkillId, name: detail.name } },
    });
  },
};

// ========================= Chat Memory（链路 A：/api/v1/chat-memory/*）=========================

const CHAT_MEMORY_PREFIX = '/api/v1/chat-memory';

/** 记忆块列表项（team-assets / agent-fixed / my-agents 共用） */
export interface ChatMemoryBlock {
  id: string;
  title: string;
  summary?: string;
  uploaded_by_user_id: string;
  updated_at_ms: number;
  layer_counts: { L0_messages: number; L1: number; L2: number; L3: number };
  /** 仅 team-assets */
  bound_agent_count?: number;
  /** 仅 agent-fixed */
  agent_id?: string;
  /** 仅 my-agents */
  scope?: 'team' | 'private';
}

/** 分层懒加载条目 */
export interface ChatMemoryLayerItem {
  id: string;
  role?: string;
  title: string;
  body: string;
  tags?: string[];
  refs?: string[];
  /** 条目创建/记录时间（ISO8601），backend 从 recorded_at_ms / created_time_ms / updated_at 转换 */
  created_at?: string;
}

async function chatMemoryCall<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  const envelope = await request<MetaEnvelope<T>>('POST', `${CHAT_MEMORY_PREFIX}/${endpoint}`, body, {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  });
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const chatMemoryApi = {
  /** 团队 Memory 池：当前团队所有已共享的 chat_memory */
  teamAssets: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('team-assets', { team_id: teamId }),

  /** Agent 固定资产 */
  agentFixed: (agentId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[]; total: number }>('agent-fixed', { agent_id: agentId }),

  /** 我的资产分配（owner=me 的 agent 列表） */
  myAgents: (teamId: string) =>
    chatMemoryCall<{ items: ChatMemoryBlock[] }>('my-agents', { team_id: teamId }),

  /** L0/L1/L2/L3 分层懒加载；L2 可传 path 懒读单个 Markdown 原文。 */
  layer: (blockId: string, l: 'L0' | 'L1' | 'L2' | 'L3', limit = 50, offset = 0, path?: string) =>
    chatMemoryCall<{ layer: string; items: ChatMemoryLayerItem[]; total: number; limit: number; offset: number }>('layer', {
      block_id: blockId, layer: l, limit, offset, ...(path ? { path } : {}),
    }),

  /** 批量设置某个 agent 的固定 memory，后端会原子校验借入上限。 */
  setAgentFixed: (teamId: string, agentId: string, blockIds: string[]) =>
    chatMemoryCall<{ updated: boolean; agent_id: string; block_ids: string[] }>('set-agent-fixed', {
      team_id: teamId, agent_id: agentId, block_ids: blockIds,
    }),

  /** 借入资产到我的 agent */
  allocate: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ allocated: boolean; agent_id: string; block_id: string }>('allocate', {
      team_id: teamId, block_id: blockId, agent_id: agentId,
    }),

  /** 从 agent 解绑 */
  unbind: (teamId: string, blockId: string, agentId: string) =>
    chatMemoryCall<{ unbound: boolean; agent_id: string; block_id: string }>('unbind', {
      team_id: teamId, block_id: blockId, agent_id: agentId,
    }),

  /** 手工建独立 UserAsset */
  create: (teamId: string, title: string, scope: 'team' | 'private', description?: string) =>
    chatMemoryCall<ChatMemoryBlock>('create', { team_id: teamId, title, scope, description }),

  /** 切换资产可见范围 */
  patchScope: (blockId: string, scope: 'team' | 'private') =>
    chatMemoryCall<{ updated: boolean; id: string; scope: string }>('patch-scope', { block_id: blockId, scope }),

  /** 导入历史对话到 agent 的 L0（走 /v3/conversation/add） */
  import: (teamId: string, agentId: string, messages: Array<{ role: string; content: string }>, sessionId?: string) =>
    chatMemoryCall<{ imported: boolean; block_id: string; session_id: string; accepted_count: number }>('import', {
      team_id: teamId, agent_id: agentId, messages, session_id: sessionId,
    }),
};
