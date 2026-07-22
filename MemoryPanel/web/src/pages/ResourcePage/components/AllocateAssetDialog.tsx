/**
 * AllocateAssetDialog — 通用「资产分配到 Agent」弹窗。
 *
 * Tea 组件重构版：底层复用 `./Modal`（Tea Modal），Agent 选择器换成 Tea `Select`，
 * 错误/成功提示换成 Tea `Alert`。
 *
 * 与 AllocateSkillDialog 视觉对齐，但不限于 skill：用 assetType + assetLabel
 * 参数化标题，支持 wiki / code_graph / chat_memory 等任何挂载到 agent 固定
 * 资产的场景。
 *
 * 演示阶段 onAllocated 只接受一个 agent_id 字符串；后端 agent_fixed_assets
 * API 上线后再换成真正的 POST。
 */

import { useState } from 'react';
import { Alert, Button, Form, Modal, Select, Tag } from 'tea-component';
import { tea } from '@/lib/tea-bridge';
import './allocate-dialog.css';

export type AllocateAssetType = 'skill' | 'llm_wiki' | 'code_graph' | 'chat_memory';

const TYPE_LABEL: Record<AllocateAssetType, string> = {
  skill: 'Skill',
  llm_wiki: 'Wiki',
  code_graph: '代码图谱',
  chat_memory: 'Memory'
};

export default function AllocateAssetDialog(props: {
  /** 资产类型（决定标题措辞） */
  assetType: AllocateAssetType;
  /** 资产展示名（如 wiki name / repo:branch / memory block 标题） */
  assetLabel: string;
  /** Agent 列表 — 调用方已经按当前激活 team 过滤过 */
  agents: Array<{ id: string; name: string }>;
  /** 当前操作所属的 team（来自右上角全局 TeamSwitcher）。
   *  分配是 team 内行为：agent 严格归属一个 team（PRD §15.4），
   *  这里展示出来让用户在生成时确认「我现在挂的是哪个 team 下的 agent」 */
  team?: { team_id: string; name: string } | null;
  onClose: () => void;
  /** 用户点击「分配」时的回调，参数是选中的 agent id */
  onAllocate: (agentId: string) => Promise<void> | void;
}) {
  const [agentId, setAgentId] = useState(props.agents[0]?.id ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const typeLabel = TYPE_LABEL[props.assetType];

  async function submit(): Promise<void> {
    if (!agentId) {
      setError('请选择 agent。');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await props.onAllocate(agentId);
      tea.notify.success(`已分配「${props.assetLabel}」→ ${agentId}`);
      props.onClose();
    } catch (err) {
      tea.notify.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal visible caption={`分配 ${typeLabel} 到 Agent`} size="s" onClose={props.onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          {props.team && (
            <Form.Item label="所属 Team">
              <Form.Text>{props.team.name} <Tag size="sm">{props.team.team_id}</Tag></Form.Text>
            </Form.Item>
          )}
          <Form.Item label="资产" extra="挂到所选 agent 的固定资产库（仅记录归属，不复制内容）">
            <Form.Text>{props.assetLabel}</Form.Text>
          </Form.Item>
          <Form.Item label="Agent" required>
            <Select
              size="full"
              value={agentId}
              onChange={setAgentId}
              placeholder={props.agents.length === 0 ? '(暂无 agent)' : '请选择 agent'}
              options={props.agents.map((a) => ({ value: a.id, text: `${a.id} · ${a.name}` }))}
              disabled={props.agents.length === 0}
            />
          </Form.Item>
          {error && <Form.Item><Alert type="error">{error}</Alert></Form.Item>}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={submitting || !agentId} loading={submitting}>分配</Button>
        <Button onClick={props.onClose} disabled={submitting}>取消</Button>
      </Modal.Footer>
    </Modal>
  );
}
