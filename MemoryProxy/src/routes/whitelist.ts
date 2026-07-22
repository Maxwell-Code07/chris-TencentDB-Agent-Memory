/**
 * 白名单端点表：集中管理 context-proxy 支持转发的 Anthropic/OpenAI 端点。
 *
 * 该表是路由、URL 拼接、handler 分派三处逻辑的**单一数据源**：
 * - `server.ts` 依据表注册 Hono 路由（精确匹配放在 catch-all 之前）
 * - `guard-adapter.ts:joinUrl` 依据表决定上游 endpoint suffix，而非硬编码二分支
 * - `auxiliaryHandler.ts` 依据表决定是否透传、是否需要走 stream 分支
 *
 * 新增端点时，只需在 `WHITELIST_ENDPOINTS` 增加一条记录即可，无需散点修改。
 */

/** 白名单端点元数据。 */
export interface WhitelistEndpoint {
  /**
   * 用户请求 path 的后缀（剥离 `/proxy/{spaceId}` 前缀后精确匹配）。
   * 例：`/v1/messages/count_tokens`
   */
  pathSuffix: string;
  /**
   * 转发到 upstream 时拼接到 `upstream.url` 之后的 endpoint 部分。
   * 例：`/messages/count_tokens`（拼在 `https://tokenhub.../v1` 之后）
   */
  upstreamEndpoint: string;
  /**
   * 协议类型：决定鉴权头格式（anthropic → `x-api-key`，openai → `Authorization: Bearer`）
   * 与 credit-reporter 的 usage 解析分支一致。
   */
  protocol: "anthropic" | "openai";
  /** 端点是否支持流式响应（SSE）。 */
  supportsStream: boolean;
  /**
   * 是否为主端点：主端点由现有的 `handleAnthropicMessages` / `handleChatCompletions`
   * 处理（含路由决策）；非主端点走轻量的 `handleAuxiliaryEndpoint`
   * （跳过路由，仅做鉴权 + 转发 + credit）。
   */
  isPrimary: boolean;
}

/**
 * 当前支持的白名单端点列表。
 *
 * 顺序不重要——`matchWhitelistEndpoint` 内部会按 `pathSuffix` 长度**从长到短**排序，
 * 以保证 `/v1/messages/count_tokens` 优先于 `/v1/messages` 命中。
 */
export const WHITELIST_ENDPOINTS: readonly WhitelistEndpoint[] = [
  // ── 主端点（由现有 handler 处理，含路由）────────────────────────
  {
    pathSuffix: "/v1/messages",
    upstreamEndpoint: "/messages",
    protocol: "anthropic",
    supportsStream: true,
    isPrimary: true,
  },
  {
    pathSuffix: "/v1/chat/completions",
    upstreamEndpoint: "/chat/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: true,
  },
  // ── 辅助端点（由 handleAuxiliaryEndpoint 处理，不走路由）─────────
  {
    pathSuffix: "/v1/messages/count_tokens",
    upstreamEndpoint: "/messages/count_tokens",
    protocol: "anthropic",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/embeddings",
    upstreamEndpoint: "/embeddings",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/completions",
    upstreamEndpoint: "/completions",
    protocol: "openai",
    supportsStream: true,
    isPrimary: false,
  },
  {
    pathSuffix: "/v1/moderations",
    upstreamEndpoint: "/moderations",
    protocol: "openai",
    supportsStream: false,
    isPrimary: false,
  },
] as const;

/** 按长度降序排列的缓存，避免每次匹配都重新排序。 */
const SORTED_BY_SUFFIX_LEN: readonly WhitelistEndpoint[] = [...WHITELIST_ENDPOINTS].sort(
  (a, b) => b.pathSuffix.length - a.pathSuffix.length,
);

/** `/proxy/{spaceId}` 前缀正则：仅剥离一层，避免误伤路径中的 "proxy" 字面量。 */
const PROXY_PREFIX_RE = /^\/proxy\/[^/]+/;
/**
 * Agent 前缀正则：匹配 `/{agent}[/{spaceId}]/v1/...` 两种形态。
 *   - `/claude-code/v1/messages`              → 剥 `/claude-code`
 *   - `/claude-code/{spaceId}/v1/messages`    → 剥 `/claude-code/{spaceId}`
 * lookahead `(?=/v1/)` 确保白名单入口 `/v1/messages` 自身不会被误剥。
 * agent 段限定为已知名字，避免误伤路径中恰好有 "v1" 字面量的其它请求。
 */
const AGENT_PREFIX_RE = /^\/(claude-code|codebuddy|cursor|anthropic|openai)(?:\/[^/]+)?(?=\/v1\/)/i;

/**
 * 规范化请求路径以便白名单匹配。
 *
 * 1. 剥离 query string
 * 2. 剥离 `/proxy/{spaceId}` 前缀（如有）
 * 3. 剥离 `/{agent}/{spaceId}` 前缀（如 `/claude-code/{spaceId}/v1/messages`）
 */
export function normalizeWhitelistRequestPath(requestPath: string): string {
  if (!requestPath) return "";
  const withoutQuery = requestPath.split("?", 1)[0] ?? "";
  const withoutProxy = withoutQuery.replace(PROXY_PREFIX_RE, "");
  return withoutProxy.replace(AGENT_PREFIX_RE, "");
}

/**
 * 从请求路径匹配白名单条目。
 *
 * 匹配规则：
 * 1. `normalizeWhitelistRequestPath` 规范化路径（剥离 query / proxy 前缀 / agent+spaceId 前缀）
 * 2. 按 `pathSuffix` 长度**从长到短**尝试精确后缀匹配
 *
 * @returns 命中的白名单条目，未命中返回 `null`
 */
export function matchWhitelistEndpoint(
  requestPath: string,
): WhitelistEndpoint | null {
  const normalized = normalizeWhitelistRequestPath(requestPath);
  if (!normalized) return null;

  for (const entry of SORTED_BY_SUFFIX_LEN) {
    if (normalized === entry.pathSuffix) return entry;
  }
  return null;
}
