/**
 * account-store.ts — 演示阶段的本地账号表（本地 localStorage）。
 *
 * 从原 demoStore.ts 中抽出。
 *
 * email → { username, password, isAdmin } 的本地账号体系，供旧版
 * 用户名密码登录使用。链路 A（新面板 Control）已切换到 user_key 鉴权，
 * 这套账号体系仅作历史兼容保留（`addTeamMember` 的 requireAccount 校验
 * 仍会用到 findAccountByUsername）。
 *
 * 后端上线后替换成真正的用户中心 API 即可。
 */

const ACCOUNTS_KEY = 'tdai-memory.accounts.v1';

/**
 * 生成 12 位随机密码，用作 mock 创建账号时的 fallback（用户未显式填时使用）。
 * 只是 demo 用途，不承载真实凭证 —— 但避免硬编码 `123123` 弱口令入 bundle。
 */
function genRandomPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 12; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export interface MockAccount {
  email: string;
  username: string;
  password: string;
  isAdmin: boolean;
  description?: string;
}

function getDefaultAccounts(): MockAccount[] {
  // 空种子：不再硬编码任何真实用户名/密码。
  // 历史上这里列过 6 个内部员工英文名 + 弱口令 `123123`（会 bundle 进前端 JS，
  // 客户拿到镜像开 devtools 就能看到 → 员工身份泄漏）。remote 上一版改成
  // alice/bob 等通用假名但仍保留 `123123`，本版继续彻底空 —— 用户按需自建。
  // 链路 A 已切 user_key 鉴权，本 mock 只服务 `addTeamMember` 的 findAccountByUsername。
  return [];
}

function writeAccountsRaw(accounts: MockAccount[]): void {
  try {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  } catch {
    /* ignore */
  }
}

function readAccounts(): MockAccount[] {
  try {
    const raw = localStorage.getItem(ACCOUNTS_KEY);
    if (!raw) {
      // 首次使用：把硬编码的种子账号写入 localStorage
      const seeds = getDefaultAccounts();
      writeAccountsRaw(seeds);
      return seeds;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const seeds = getDefaultAccounts();
      writeAccountsRaw(seeds);
      return seeds;
    }
    return parsed.filter(
      (a): a is MockAccount => a && typeof a.email === 'string' && typeof a.username === 'string' && typeof a.password === 'string'
    );
  } catch {
    const seeds = getDefaultAccounts();
    writeAccountsRaw(seeds);
    return seeds;
  }
}

/** 用邮箱查账号（不区分大小写） */
export function findAccountByEmail(email: string): MockAccount | null {
  const e = email.trim().toLowerCase();
  return readAccounts().find((a) => a.email.toLowerCase() === e) ?? null;
}

/** 用 username 查账号 */
export function findAccountByUsername(username: string): MockAccount | null {
  return readAccounts().find((a) => a.username === username) ?? null;
}

/** 校验邮箱 + 密码登录 */
export function verifyAccountCredentials(email: string, password: string): MockAccount {
  const e = email.trim().toLowerCase();
  if (!e) throw new Error('请输入邮箱。');
  if (!password) throw new Error('请输入密码。');
  const account = readAccounts().find((a) => a.email.toLowerCase() === e);
  if (!account) throw new Error(`账号不存在：${e}`);
  if (account.password !== password) throw new Error('密码错误。');
  return account;
}

/** 创建单个账号（admin 专有权限，权限校验在 UI 层）。
 *  用户名允许重复，邮箱全局唯一。 */
export function createAccount(input: { email: string; username: string; password?: string; isAdmin?: boolean; description?: string }): MockAccount {
  const e = input.email.trim().toLowerCase();
  if (!e) throw new Error('邮箱不能为空。');
  if (!input.username.trim()) throw new Error('用户名不能为空。');
  const accounts = readAccounts();
  if (accounts.some((a) => a.email.toLowerCase() === e)) {
    throw new Error(`邮箱 "${input.email}" 已被注册。`);
  }
  const account: MockAccount = {
    email: input.email.trim(),
    username: input.username.trim(),
    // fallback 随机密码 —— 避免硬编码弱口令；未来切真用户中心可去掉
    password: input.password || genRandomPassword(),
    isAdmin: input.isAdmin ?? false,
    description: input.description?.trim() || undefined,
  };
  writeAccountsRaw([...accounts, account]);
  return account;
}

/** 批量创建账号 */
export function batchCreateAccounts(
  entries: Array<{ email: string; username: string; description?: string }>
): { created: MockAccount[]; errors: Array<{ email: string; error: string }> } {
  const created: MockAccount[] = [];
  const errors: Array<{ email: string; error: string }> = [];
  const accounts = readAccounts();
  const emailSet = new Set(accounts.map((a) => a.email.toLowerCase()));

  for (const entry of entries) {
    const e = entry.email.trim().toLowerCase();
    const u = entry.username.trim();
    if (!e || !u) {
      errors.push({ email: entry.email || '(空)', error: '邮箱和用户名都不能为空' });
      continue;
    }
    if (emailSet.has(e)) {
      errors.push({ email: entry.email, error: '邮箱已被注册' });
      continue;
    }
    const account: MockAccount = {
      email: entry.email.trim(),
      username: u,
      password: genRandomPassword(),
      isAdmin: false,
      description: entry.description?.trim() || undefined,
    };
    emailSet.add(e);
    accounts.push(account);
    created.push(account);
  }

  if (created.length > 0) {
    writeAccountsRaw(accounts);
  }
  return { created, errors };
}

/** 修改密码 */
export function changePassword(username: string, oldPassword: string, newPassword: string): void {
  if (!oldPassword) throw new Error('请输入当前密码。');
  if (!newPassword) throw new Error('请输入新密码。');
  if (newPassword.length < 4) throw new Error('新密码至少需要 4 位。');
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error('账号不存在。');
  if (account.password !== oldPassword) throw new Error('当前密码错误。');
  account.password = newPassword;
  writeAccountsRaw(accounts);
}

/**
 * Admin 直接设置任意用户的密码（不需要旧密码）。
 * 权限校验在 UI 层（仅 admin 可调用）。
 */
export function setAccountPassword(username: string, newPassword: string): void {
  if (!newPassword) throw new Error('请输入新密码。');
  if (newPassword.length < 4) throw new Error('新密码至少需要 4 位。');
  if (!username) throw new Error('用户名不能为空。');
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(`账号不存在：${username}`);
  account.password = newPassword;
  writeAccountsRaw(accounts);
}

/** 修改用户邮箱（admin 专有权限，权限校验在 UI 层） */
export function updateAccountEmail(username: string, newEmail: string): void {
  const e = newEmail.trim().toLowerCase();
  if (!e) throw new Error('邮箱不能为空。');
  if (!username) throw new Error('用户名不能为空。');
  const accounts = readAccounts();
  const account = accounts.find((a) => a.username === username);
  if (!account) throw new Error(`账号不存在：${username}`);
  // 检查邮箱是否已被其他人使用
  const conflict = accounts.find((a) => a.email.toLowerCase() === e && a.username !== username);
  if (conflict) throw new Error(`邮箱 "${newEmail.trim()}" 已被其他用户使用。`);
  account.email = newEmail.trim();
  writeAccountsRaw(accounts);
}

/** 获取所有账号列表（admin 可见全部，普通用户只能看自己） */
export function getAllAccounts(): MockAccount[] {
  return readAccounts();
}
