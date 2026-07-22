/**
 * ForkSkillDialog — "复制一份 skill 给某个 agent，且该副本可被该 agent 编辑"。
 *
 * 与「授权（asset visibility=team + acl/grant）」的区别：
 *   - 授权 → 通过\"我的资产分配\"tab 切共享或 acl/grant，不复制内容，其他人
 *     拿到的是对同一份 skill 的读/使用权限；
 *   - fork（本对话框）→ 拉源 skill 的 SKILL.md，**沿用原名 + 目标 agent 为 owner**
 *     调用 skill-api.createSkill 落一份独立副本，之后该 agent 可写。
 *
 * 命名约定：副本**沿用源 skill 原名**，不加后缀。skill 唯一约束基于
 * (team_id, owner_agent_id, name)：同一 team 允许多个同名副本（分属不同 agent），
 * 但目标 agent 下若已存在同名 skill，后端会拒绝（42201），此处提前拦截并提示。
 *
 * 实现：走「getSkill(源) → readSkillFile(附件们) → createSkill(新)」三步。
 */

import { useState } from 'react';
import { Alert, Button, Form, Input, Modal, Select } from 'tea-component';
import '@/pages/ResourcePage/components/allocate-dialog.css';

import {
  createSkill,
  getSkill,
  listSkills,
  readSkillFile,
  type SkillSummary,
  type SkillResourcePayload,
} from '@/lib/skill-api';

/**
 * 改写 SKILL.md frontmatter 里的 name 字段，保证 DB 记录名与文件内容一致。
 * 仅替换第一个 `--- ... ---` frontmatter 块内的 `name:` 行；无 frontmatter 则原样返回。
 */
function rewriteFrontmatterName(content: string, newName: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return content;
  const fmBody = fmMatch[1];
  if (!/^\s*name\s*:/m.test(fmBody)) return content; // 无 name 字段，不强行插入
  const newFmBody = fmBody.replace(/^(\s*name\s*:\s*).*/m, `$1${newName}`);
  return content.replace(fmBody, newFmBody);
}

export default function ForkSkillDialog(props: {
  /** 要 fork 的源 skill 名 */
  skillName: string;
  /** v3 API 需要的 skill_id */
  skillId: string;
  agents: Array<{ id: string; name: string }>;
  /** 当前 team ID（v3 API 必传） */
  teamId: string;
  /** 当前用户 ID（v3 API 必传） */
  userId: string;
  onClose: () => void;
  onForked: (newSkill: SkillSummary) => void;
}) {
  const [agentId, setAgentId] = useState(props.agents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // 副本名默认沿用源 skill 原名，用户可编辑。唯一约束靠 owner_agent_id 区分，
  // 同一 agent 下不允许重名（后端 42201），下方 submit 会提前拦截。
  const [newName, setNewName] = useState(props.skillName);

  async function submit(): Promise<void> {
    if (!agentId) {
      setError('请选择 agent。');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Step 1: 拉源 skill 详情（含 content + manifest）。
      const full = await getSkill({
        skill_id: props.skillId,
        team_id: props.teamId,
        include_content: true,
        include_manifest: true,
      });

      // Step 2: 防御性检查 —— 目标 agent 下已存在同名 skill 则提前拦截，避免后端 42201。
      const existing = await listSkills({
        team_id: props.teamId,
        filters: { owner_agent_id: agentId, status: ['active'] },
        pagination: { limit: 100 },
      });
      if (existing.items.some((s) => s.name === newName)) {
        throw new Error(
          `Agent "${agentId}" 下已存在同名 skill "${newName}"（单个 agent 不允许重名）。请先删除旧副本再重试。`
        );
      }

      // Step 3: 复制附属资源文件（逐个 readSkillFile；单个失败跳过，不阻断主流程）。
      const resources: SkillResourcePayload[] = [];
      for (const entry of full.manifest ?? []) {
        try {
          const f = await readSkillFile({
            skill_id: props.skillId,
            team_id: props.teamId,
            path: entry.path,
          });
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

      // Step 4: 以（可编辑的）副本名 + 目标 agent 为 owner 创建 skill（v3 API）。
      // 若用户改了名，同步改写 SKILL.md frontmatter 的 name 字段，保持 DB 与文件一致。
      const trimmedName = newName.trim();
      const finalContent = trimmedName !== props.skillName
        ? rewriteFrontmatterName(full.content, trimmedName)
        : full.content;
      const created = await createSkill({
        user_id: props.userId,
        team_id: props.teamId,
        agent_id: agentId,
        name: trimmedName,
        content: finalContent,
        resources: resources.length ? resources : undefined,
      });

      const resourceInfo = resources.length > 0
        ? `（已复制 ${resources.length} 个资源文件）`
        : (full.manifest?.length ?? 0) > 0
          ? `（注意：原 skill 有 ${full.manifest?.length} 个资源文件，复制均失败，如需请手动重新 import）`
          : '';
      setSuccess(`已 fork "${props.skillName}" @ ${agentId}${resourceInfo}`);
      setTimeout(() => props.onForked(created), 800);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption="Fork Skill 给 Agent" size="s" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label="说明">
            <Form.Text>将 {props.skillName} 复制一份给所选 agent。副本与源 skill 解耦，agent 之后可独立修改副本。可在下方自定义副本名。</Form.Text>
          </Form.Item>
          <Form.Item label="Agent" required>
            <Select
              size="full"
              value={agentId}
              onChange={setAgentId}
              placeholder="请选择 agent"
              options={props.agents.map((a) => ({ value: a.id, text: `${a.id} · ${a.name}` }))}
            />
          </Form.Item>
          <Form.Item label="副本名" required>
            <Input
              size="full"
              value={newName}
              onChange={setNewName}
              placeholder="副本 skill 名称"
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
          {success && <Form.Item><Alert type="success">{success}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={submitting || !agentId || !newName.trim()} loading={submitting}>Fork</Button>
        <Button onClick={props.onClose} disabled={submitting}>取消</Button>
      </Modal.Footer>
    </Modal>
  );
}
