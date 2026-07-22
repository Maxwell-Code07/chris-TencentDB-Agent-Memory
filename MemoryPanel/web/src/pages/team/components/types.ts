/**
 * TeamManagementPanel 拆分出的公共类型 + 纯函数。
 * 无 React 依赖，方便被 hooks / 各 Dialog 子模块共用。
 */

import { isTeamAdmin, isGlobalAdmin, type Team } from '@/services';

export const MAX_IMPORTED_CHAT_MEMORIES = 2;

/** 排除 agent 自身默认拥有的 chat_memory（chat_memory-{team}-{agent}），得到「额外导入」的部分。 */
export function importedChatMemoryIds(teamId: string, agentId: string, ids: string[]): string[] {
  const selfChatMemoryId = `chat_memory-${teamId}-${agentId}`;
  return Array.from(new Set(ids.filter((id) => id !== selfChatMemoryId)));
}

// =================== Types ===================

export interface MountableAsset {
  key: string;
  title: string;
  group: string;
  slug: string;
  status?: string;
}

export interface AgentCard {
  id: string;
  name: string;
  description: string;
  rolePrompt: string;
  rulesPrompt: string;
  icon: string;
  accent: 'blue' | 'purple' | 'orange' | 'emerald' | 'rose' | 'slate';
  skills: string[];
  codeGraphs: string[];
  llmWikis: string[];
  chatMemories: string[];
}

export interface AgentMountedCounts {
  skills: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

export interface AgentOverviewPayload {
  assets: {
    skills: MountableAsset[];
    codeGraphs: MountableAsset[];
    wikis: MountableAsset[];
    chatMemories: MountableAsset[];
  };
  counts: Record<string, AgentMountedCounts>;
}

export interface AgentOverviewEnvelope {
  code: number;
  message: string;
  request_id: string;
  data: AgentOverviewPayload;
}

export function emptyMountedCounts(): AgentMountedCounts {
  return { skills: 0, code_graph: 0, llm_wiki: 0, chat_memory: 0 };
}

export const ACCENT_STYLES: Record<AgentCard['accent'], { bg: string; text: string }> = {
  blue: { bg: '_memory-accent-blue', text: '_memory-accent-blue-text' },
  purple: { bg: '_memory-accent-purple', text: '_memory-accent-purple-text' },
  orange: { bg: '_memory-accent-orange', text: '_memory-accent-orange-text' },
  emerald: { bg: '_memory-accent-emerald', text: '_memory-accent-emerald-text' },
  rose: { bg: '_memory-accent-rose', text: '_memory-accent-rose-text' },
  slate: { bg: '_memory-accent-slate', text: '_memory-accent-slate-text' },
};

/** 移除成员权限：全局 admin / team owner / team admin 可以移除非 owner 成员；owner 不可被移除（含全局 admin）。 */
export function canRemoveMember(
  team: Team,
  targetUserId: string,
  currentUser: string,
  globalAdmin: boolean,
): boolean {
  if (targetUserId === team.owner_user_id) return false;
  if (isGlobalAdmin(currentUser, globalAdmin)) return true;
  return isTeamAdmin(team, currentUser);
}
