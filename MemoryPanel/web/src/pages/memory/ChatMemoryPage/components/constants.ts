import type { LayerMeta, ScopeTab } from './types';

export const PROSE_CLASS =
  'prose prose-sm prose-slate max-w-none prose-headings:my-2 prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-pre:my-1.5';

export const LAYERS: LayerMeta[] = [
  { id: 'L0', label: 'L0 · 对话原文', short: '对话原文', desc: '原始对话 / 工具调用流水，不做压缩', tone: 'default' },
  { id: 'L1', label: 'L1 · 原子记忆', short: '原子记忆', desc: '从原文抽取出来的最小事实 / 约束', tone: 'brand' },
  { id: 'L2', label: 'L2 · 场景记忆', short: '场景记忆', desc: '围绕场景聚合的多条原子记忆总结', tone: 'success' },
  { id: 'L3', label: 'L3 · 核心记忆', short: '核心记忆', desc: '沉淀的核心准则 / 模板 / 决策', tone: 'warning' },
];

export const SCOPE_TAB_LABELS: Record<ScopeTab, string> = {
  all: '全部',
  team: '团队资产',
  fixed: 'Agent 资产',
  scope: '可分配资产',
  personal: '我的资产分配',
};
