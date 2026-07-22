/**
 * agent-template-store.ts — Agent 新建模板（本地 localStorage）。
 *
 * 从原 demoStore.ts 中抽出（独立职责：与 team/agent/task 本体无关，只服务
 * "新建 agent 时一键预填表单"这个辅助功能）。
 *
 * 模板分两类：
 *   - 内置模板（builtin=true）：随产品发布，不可删除，覆盖几种常见角色。
 *   - 自定义模板（builtin=false）：用户在新建弹窗里「保存为模板」生成，
 *     存 localStorage，可删。
 *
 * 后端上线后这层换成 GET/POST/DELETE /agent-templates 即可，UI 不用改。
 */

import { emitChange, safeParse } from './storage-utils';

const AGENT_TEMPLATES_KEY = 'tdai-memory.agentTemplates.v1';

export interface AgentTemplate {
  template_id: string;
  /** 模板名（展示用，必填） */
  name: string;
  /** 模板说明（选填，给使用者看的一句话） */
  summary: string;
  /** 内置模板不可删除 */
  builtin: boolean;
  // ===== 预填到新建表单的字段（均为 agent 字段，不含 name —— name 由用户自己填）=====
  description: string;
  role_prompt: string;
  rules_prompt: string;
  skills: string[];
  code_graphs: string[];
  llm_wikis: string[];
  chat_memories: string[];
  created_at_ms: number;
}

/** 内置模板 —— 不落库，每次读取时与自定义模板合并返回。 */
const BUILTIN_AGENT_TEMPLATES: AgentTemplate[] = [
  {
    template_id: 'builtin-pr-reviewer',
    name: 'PR Reviewer',
    summary: '代码合入主干前的最后一道质量关卡',
    builtin: true,
    description: '执行 pr-review workflow：核对必查项 + 给出 actionable 评论。',
    role_prompt: '你是严格的 PR Reviewer，是代码合入主干前的最后一道质量关卡。',
    rules_prompt: '1. 先读 PR 描述与关联 issue，明确改动意图。\n2. 必查：正确性、边界条件、安全、测试覆盖、命名与可读性。\n3. 每条评论必须 actionable，指明位置与建议改法。\n4. 阻断性问题与建议性问题分开标注。',
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
    created_at_ms: 0,
  },
  {
    template_id: 'builtin-bugfix-engineer',
    name: 'Bug-fix 工程师',
    summary: '复现 → 定位 → 修复 → 自测的修复 loop',
    builtin: true,
    description: '面向 bug-fix loop 的工程师 agent：复现 → 定位 → 修复 → 自测。',
    role_prompt: '你是面向 bug-fix loop 的修复工程师，对每个缺陷负责到根因，追求最小且可验证的修复。',
    rules_prompt: '1. 先稳定复现，再动手；无法复现先补复现信息。\n2. 定位根因而非掩盖症状。\n3. 修复保持最小 diff，附带回归测试。\n4. 自测通过后再提交，说明验证方式。',
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
    created_at_ms: 0,
  },
  {
    template_id: 'builtin-issue-triage',
    name: 'Issue 分诊员',
    summary: '新进 issue 的第一接待人：分类 / 补全 / 指派',
    builtin: true,
    description: '面向新进 issue：判断类型、补充复现信息、指派 owner。',
    role_prompt: '你是 issue 分诊员，是新进 issue 的第一接待人，负责分类、补全信息并指派。',
    rules_prompt: '1. 判断类型（bug / feature / question / 重复）。\n2. 缺信息时按模板向报告者追问复现步骤、环境、期望。\n3. 标注优先级与影响面。\n4. 指派合适 owner 并说明理由。',
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
    created_at_ms: 0,
  },
  {
    template_id: 'builtin-doc-engineer',
    name: '文档工程师',
    summary: '随 PR 同步更新 wiki / changelog',
    builtin: true,
    description: '随 PR 同步更新 wiki / changelog，保持团队知识库与代码一致。',
    role_prompt: '你是文档工程师，确保团队知识库与代码始终保持同步、可信。',
    rules_prompt: '1. 每个会影响行为的 PR 都要评估文档影响。\n2. 更新 changelog，语言面向使用者而非实现者。\n3. 失效文档及时下线或标注。\n4. 文档需可被检索，附必要链接与示例。',
    skills: [],
    code_graphs: [],
    llm_wikis: [],
    chat_memories: [],
    created_at_ms: 0,
  },
];

function readCustomAgentTemplates(): AgentTemplate[] {
  if (typeof window === 'undefined') return [];
  return safeParse<AgentTemplate[]>(localStorage.getItem(AGENT_TEMPLATES_KEY), []);
}

function writeCustomAgentTemplates(templates: AgentTemplate[]): void {
  try {
    localStorage.setItem(AGENT_TEMPLATES_KEY, JSON.stringify(templates));
  } catch {
    /* ignore */
  }
  emitChange();
}

/** 读取全部模板（内置在前，自定义在后，按创建时间倒序）。 */
export function readAgentTemplates(): AgentTemplate[] {
  const custom = [...readCustomAgentTemplates()].sort((a, b) => b.created_at_ms - a.created_at_ms);
  return [...BUILTIN_AGENT_TEMPLATES, ...custom];
}

/** 保存一个自定义模板（builtin 恒为 false）。 */
export function createAgentTemplate(input: {
  name: string;
  summary?: string;
  description?: string;
  role_prompt?: string;
  rules_prompt?: string;
  skills?: string[];
  code_graphs?: string[];
  llm_wikis?: string[];
  chat_memories?: string[];
}): AgentTemplate {
  const name = input.name.trim();
  if (!name) throw new Error('createAgentTemplate: 模板名不能为空。');
  const now = Date.now();
  const tpl: AgentTemplate = {
    template_id: `tpl_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    summary: (input.summary ?? '').trim(),
    builtin: false,
    description: (input.description ?? '').trim(),
    role_prompt: (input.role_prompt ?? '').trim(),
    rules_prompt: (input.rules_prompt ?? '').trim(),
    skills: input.skills ?? [],
    code_graphs: input.code_graphs ?? [],
    llm_wikis: input.llm_wikis ?? [],
    chat_memories: input.chat_memories ?? [],
    created_at_ms: now,
  };
  writeCustomAgentTemplates([...readCustomAgentTemplates(), tpl]);
  return tpl;
}

/** 删除一个自定义模板；内置模板不可删（静默忽略）。 */
export function deleteAgentTemplate(template_id: string): void {
  if (BUILTIN_AGENT_TEMPLATES.some((t) => t.template_id === template_id)) return;
  writeCustomAgentTemplates(readCustomAgentTemplates().filter((t) => t.template_id !== template_id));
}
