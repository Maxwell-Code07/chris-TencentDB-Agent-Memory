/**
 * 菜单元数据 — 从 App.tsx 抽出
 *
 * 包含页面 ID 类型、页面元信息、分组排序、分组图标。
 * Sidebar / TabBar / 路由等模块共用。
 */
import {
  DashboardIcon,
  UserIcon,
  UsergroupIcon,
  LockOnIcon,
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';

export type PageId =
  | 'workbench_board'
  | 'wiki'
  | 'code'
  | 'skills'
  | 'chat_memory'
  | 'team_members'
  | 'team_agents'
  | 'api_keys';

/** 页面元数据 */
export interface PageMeta {
  id: PageId;
  label: string;
  desc?: string;
  /** 所属分组，用于侧边栏菜单分组标题 */
  group: string;
  /** 分组内排序，越小越靠前 */
  order: number;
  /** 固定标签页不可关闭（工作台看板） */
  affix?: boolean;
}

export const PAGE_META: Record<PageId, PageMeta> = {
  workbench_board: { id: 'workbench_board', label: '任务看板', desc: 'Task 列表 / 创建 / 详情', group: '工作台', order: 0, affix: true },
  wiki:            { id: 'wiki',            label: 'Wiki 知识库', desc: '来源 / 图谱 / 页面 / 搜索', group: '资产管理', order: 2 },
  code:            { id: 'code',            label: 'Code_Graph', desc: '仓库 / 索引 / 搜索 / 探索', group: '资产管理', order: 3 },
  skills:          { id: 'skills',          label: 'Skill 技能', desc: '全部 / 团队池 / Agent 资产', group: '资产管理', order: 4 },
  chat_memory:     { id: 'chat_memory',     label: 'Chat_Memory', desc: 'L0–L3 分层记忆资产', group: '资产管理', order: 5 },
  team_members:    { id: 'team_members',    label: '成员管理', desc: 'Team 成员 / 用户 / 角色', group: '组织与权限', order: 0 },
  team_agents:     { id: 'team_agents',     label: 'Agents 管理', desc: 'Agent / 可配置范围 / 固定资产', group: '组织与权限', order: 1 },
  api_keys:        { id: 'api_keys',        label: 'API Key', desc: '管理你的 API Key，用于外部客户端接入', group: '组织与权限', order: 2 },
};

/** 分组排序顺序 */
export const GROUP_ORDER = ['工作台', '组织与权限', '资产管理'];

/** 每个页面在侧边栏菜单中的图标（Tea 官方图标，size 16） */
export const ITEM_ICON: Record<PageId, JSX.Element> = {
  workbench_board: <DashboardIcon size={16} />,
  team_members: <UserIcon size={16} />,
  team_agents: <UsergroupIcon size={16} />,
  api_keys: <LockOnIcon size={16} />,
  wiki: <BooksIcon size={16} />,
  code: <CodeIcon size={16} />,
  skills: <ToolsIcon size={16} />,
  chat_memory: <ChatIcon size={16} />,
};

/** 分组图标（工作台 / 组织与权限 / 资产管理） */
export const GROUP_ICON: Record<string, JSX.Element> = {
  工作台: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  组织与权限: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  资产管理: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2l9 5-9 5-9-5 9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 17l9 5 9-5" />
    </svg>
  ),
};
