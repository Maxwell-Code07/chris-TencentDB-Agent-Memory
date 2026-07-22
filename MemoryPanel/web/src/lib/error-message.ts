export interface ErrorEnvelopeLike {
  code?: number | string;
  message?: string;
  request_id?: string;
}

const ERROR_CODE_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '登录状态已失效，请重新登录。',
  INVALID_USER_KEY: '用户密钥无效或已失效，请重新登录。',
  MISSING_USER_KEY: '缺少用户密钥，请重新登录。',
  MISSING_INSTANCE_ID: '缺少实例信息，请重新选择实例后重试。',
  INVALID_INSTANCE: '实例配置无效，请检查当前选择的实例。',
  NOT_TEAM_MEMBER: '你不是该团队成员，无法执行此操作。',
  PERMISSION_DENIED: '没有权限执行此操作。',
  FORBIDDEN: '没有权限执行此操作。',
  NOT_FOUND: '资源不存在或已被删除。',
  ALREADY_EXISTS: '资源已存在，请勿重复创建。',
  MEMBER_ALREADY_EXISTS: '该用户已是团队成员，无需重复添加。',
  CONFLICT: '资源状态已变化，请刷新后重试。',
  KERNEL_UNAVAILABLE: '内核服务不可用，请稍后重试。',
  UPSTREAM_ERROR: '上游服务调用失败，请稍后重试。',
  UNKNOWN_META_ACTION: '当前接口暂不支持，请刷新页面或联系管理员。',
  NOT_IN_SCOPE: '该能力当前暂未开放。',

  MISSING_TEAM_ID: '缺少团队信息，请重新选择团队。',
  MISSING_AGENT_ID: '缺少 Agent 信息，请重新选择 Agent。',
  AGENT_NOT_FOUND: 'Agent 不存在或已被删除。',
  NOT_YOUR_AGENT: '只能操作你自己创建的 Agent。',
  AGENT_NOT_IN_TEAM: '该 Agent 不属于当前团队。',
  MISSING_TASK_ID: '缺少 Task 信息，请重新选择 Task。',

  MISSING_ASSET_ID: '缺少资产 ID。',
  ASSET_NOT_FOUND: '资产不存在或已被删除。',
  ASSET_NOT_SHARED: '该资产尚未共享到团队，不能分配给其它 Agent。',
  ASSET_TYPE_MISMATCH: '资产类型不匹配，请刷新后重试。',
  MISSING_BLOCK_ID: '缺少记忆资产信息。',
  BLOCK_NOT_FOUND: '记忆资产不存在或已被删除。',
  NOT_CHAT_MEMORY: '当前资产不是 Chat Memory。',
  TEAM_MISMATCH: '资源不属于当前团队，请刷新后重试。',
  INVALID_SCOPE: '可见范围无效。',

  CANNOT_ALLOCATE_SELF_CHAT_MEMORY: '不能把该 Agent 自己的记忆再分配给自己。',
  CANNOT_UNBIND_SELF_CHAT_MEMORY: '不能解绑 Agent 自己的记忆。',
  ALREADY_ALLOCATED: '这条资产已经分配给该 Agent，无需重复分配。',
  IMPORT_LIMIT_EXCEEDED: '该 Agent 最多只能借入 2 条其它 Agent 的记忆。',
  // 内核 canBindAsset/permission-checker 判定失败：常见场景是 asset 被 owner 切私密后
  // 其他成员再对它做 read / bind / update 类操作。
  ASSET_PRIVATE_INACCESSIBLE: '该资产已被 owner 设为私密，你无权访问。',
  ASSET_NOT_BINDABLE: '该资产的可见范围不允许绑定到此 Agent。请让 owner 将它设为团队可见后重试。',

  INVALID_TITLE: '标题不能为空且不能超过长度限制。',
  MISSING_MESSAGES: '缺少对话消息。',
  TOO_MANY_MESSAGES: '一次最多导入 100 条消息。',
  NO_VALID_MESSAGES: '没有可导入的有效消息。',

  MISSING_WIKI_ID: '缺少 Wiki 信息。',
  WIKI_NOT_FOUND: 'Wiki 不存在或已被删除。',
  WIKI_EMPTY_NO_SOURCES: 'Wiki 还没有上传源文件，请先上传 .md 文件后再抽取。',
  MISSING_FILES: '请至少上传一个文件。',
  TOO_MANY_FILES: '上传文件数量超过限制（最多 10 个），请分批上传。',
  FILE_TOO_LARGE: '单个文件不能超过 512KB，请精简后再上传。',
  TOTAL_TOO_LARGE: '单次上传总量不能超过 5MB，请分批上传。',
  MISSING_CODE_GRAPH_ID: '缺少 CodeGraph 信息。',
  CODE_GRAPH_NOT_FOUND: 'CodeGraph 不存在或已被删除。',
  KNOWLEDGE_NOT_FOUND: '知识库资源不存在或已被删除。',

  INVALID_ARGUMENT: '请求参数不正确，请检查输入后重试。',
  VALIDATION_ERROR: '请求参数不正确，请检查输入后重试。',
  RATE_LIMITED: '请求过于频繁，请稍后重试。',
  INTERNAL_ERROR: '服务内部错误，请稍后重试。',
};

const MESSAGE_PATTERNS: Array<[RegExp, string]> = [
  [/unauthorized:\s*invalid_user_key/i, ERROR_CODE_MESSAGES.INVALID_USER_KEY],
  [/user_id or user_key is required/i, ERROR_CODE_MESSAGES.MISSING_USER_KEY],
  [/missing.*team_id/i, ERROR_CODE_MESSAGES.MISSING_TEAM_ID],
  [/missing.*agent_id/i, ERROR_CODE_MESSAGES.MISSING_AGENT_ID],
  [/not team member/i, ERROR_CODE_MESSAGES.NOT_TEAM_MEMBER],
  // 注：asset_not_bindable / visibility_restricted 在 PRIORITY_MESSAGE_PATTERNS 里前置匹配，
  // 因为它们会被 permission_denied 前缀吞掉。
  [/permission[_\s-]?denied/i, ERROR_CODE_MESSAGES.PERMISSION_DENIED],
  [/fetch failed|networkerror|failed to fetch/i, '网络请求失败，请检查服务是否可用后重试。'],
  [/timeout|aborted/i, '请求超时，请稍后重试。'],
  [/empty .* response/i, '服务返回为空，请稍后重试。'],
  [/internal server error/i, ERROR_CODE_MESSAGES.INTERNAL_ERROR],
];

function tryParseJson(input: string): unknown | null {
  const text = input.trim();
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractCodeLike(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;
  const exact = trimmed.match(/^[A-Z][A-Z0-9_]{2,}$/);
  if (exact) return exact[0];
  const lowerPrefix = trimmed.match(/^([a-z][a-z0-9_]{2,})\s*:/);
  if (lowerPrefix) return lowerPrefix[1].toUpperCase();
  const upperInside = trimmed.match(/\b([A-Z][A-Z0-9_]{2,})\b/);
  return upperInside?.[1] ?? null;
}

function stripTechnicalPrefix(message: string): string {
  return message
    .replace(/^(skill|knowledge)\s+\d+\s*:\s*/i, '')
    .replace(/^\d{3}\s+[A-Za-z ]+\s*·\s*/, '')
    .trim();
}

function isJsonLike(message: string): boolean {
  const trimmed = message.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * 优先匹配的语义 pattern —— 在 extractCodeLike 兜底提取之前先跑。
 *
 * 场景：内核抛的错误消息形如 `permission_denied: visibility_restricted` —— 前缀 `permission_denied`
 * 会被 extractCodeLike 提取成 `PERMISSION_DENIED` 直接命中通用文案，掩盖后面的 `visibility_restricted`
 * 语义关键词。因此凡是"通用错误码 + 细化子原因"的组合都必须在这里精准命中。
 */
const PRIORITY_MESSAGE_PATTERNS: Array<[RegExp, string]> = [
  [/visibility[_\s-]?restricted/i, ERROR_CODE_MESSAGES.ASSET_PRIVATE_INACCESSIBLE],
  [/asset_not_bindable/i, ERROR_CODE_MESSAGES.ASSET_NOT_BINDABLE],
];

export function mapErrorCode(codeOrMessage: number | string | undefined, fallbackMessage?: string): string | null {
  const raw = String(codeOrMessage ?? '').trim();
  const text = fallbackMessage ?? raw;

  // 先跑优先 pattern：避免 extractCodeLike 用 `permission_denied` 前缀吃掉子原因关键词。
  for (const [pattern, message] of PRIORITY_MESSAGE_PATTERNS) {
    if (pattern.test(text) || pattern.test(raw)) return message;
  }

  let direct = ERROR_CODE_MESSAGES[raw];
  // 仅对 snake_case 业务码做大小写归一；勿把 HTTP statusText（如 Conflict）误判为 CONFLICT
  if (!direct && /^[a-z][a-z0-9_]+$/.test(raw)) {
    direct = ERROR_CODE_MESSAGES[raw.toUpperCase()];
  }
  if (!direct && /^[A-Z][A-Z0-9_]{2,}$/.test(raw)) {
    direct = ERROR_CODE_MESSAGES[raw];
  }
  if (direct) return direct;

  const fromMessage = extractCodeLike(fallbackMessage ?? raw);
  if (fromMessage && ERROR_CODE_MESSAGES[fromMessage]) return ERROR_CODE_MESSAGES[fromMessage];

  for (const [pattern, message] of MESSAGE_PATTERNS) {
    if (pattern.test(text)) return message;
  }
  return null;
}

export function formatApiErrorMessage(input: {
  code?: number | string;
  message?: string;
  requestId?: string;
  httpStatus?: number;
  httpStatusText?: string;
  body?: string;
  fallback?: string;
}): string {
  const bodyJson = input.body ? tryParseJson(input.body) : null;
  const env = bodyJson && !Array.isArray(bodyJson) ? bodyJson as ErrorEnvelopeLike : null;
  const code = input.code ?? env?.code ?? input.httpStatus;
  const rawMessage = env?.message ?? input.message ?? input.httpStatusText ?? input.body ?? input.fallback ?? '';

  const mapped = mapErrorCode(code, rawMessage) ?? mapErrorCode(rawMessage);
  if (mapped) return mapped;

  const clean = stripTechnicalPrefix(rawMessage);
  if (clean && !isJsonLike(clean)) return clean;

  if (input.httpStatus === 401) return ERROR_CODE_MESSAGES.UNAUTHORIZED;
  if (input.httpStatus === 403) return ERROR_CODE_MESSAGES.PERMISSION_DENIED;
  if (input.httpStatus === 404) return ERROR_CODE_MESSAGES.NOT_FOUND;
  if (input.httpStatus && input.httpStatus >= 500) return ERROR_CODE_MESSAGES.INTERNAL_ERROR;
  return input.fallback ?? '操作失败，请稍后重试。';
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.name === 'ApiError') {
    const apiErr = err as Error & {
      status: number;
      statusText: string;
      body: string;
      code?: number | string;
      requestId?: string;
      rawMessage?: string;
    };
    return formatApiErrorMessage({
      code: apiErr.code,
      message: apiErr.rawMessage ?? apiErr.message,
      requestId: apiErr.requestId,
      httpStatus: apiErr.status,
      httpStatusText: apiErr.statusText,
      body: apiErr.body,
      fallback: apiErr.message,
    });
  }
  if (err instanceof Error) return formatApiErrorMessage({ message: err.message, fallback: err.message });
  if (typeof err === 'string') return formatApiErrorMessage({ message: err, fallback: err });
  return '操作失败，请稍后重试。';
}
