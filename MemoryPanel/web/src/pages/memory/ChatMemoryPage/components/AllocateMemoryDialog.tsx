import { useState, useRef, useEffect } from 'react';
import { Alert, Button, Form, Modal, Select, Text } from 'tea-component';
import { type AgentOption } from './types';

/**
 * 记忆块来源：影响弹窗文案与"无可分配 agent"提示的措辞。
 *   - team     ：来自团队共享池（team tab，scope='team'）—— 文案说"团队池里"
 *   - personal ：来自当前用户 owner 的 agent 自有记忆（personal tab）
 *                —— 不是"团队池"，文案用更通用的"分配"措辞
 */
export type MemorySource = 'team' | 'personal';

export function AllocateMemoryDialog({
  memoryTitle,
  agents,
  memorySource = 'team',
  onClose,
  onAllocated,
}: {
  memoryTitle: string;
  agents: AgentOption[];
  /**
   * 记忆块来源，决定描述文案。
   * 不传时按 team 处理（保持与历史默认行为一致）。
   */
  memorySource?: MemorySource;
  onClose: () => void;
  onAllocated: (agentId: string) => void | Promise<void>;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.agent_id ?? '');
  const [submitting, setSubmitting] = useState(false);
  // 组件卸载后不再 setState（分配成功时父组件会关闭本弹窗）
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  async function submit() {
    // in-flight 锁：提交进行中直接忽略后续点击，避免高延迟下把同一记忆块重复分配给 agent
    if (!agentId || submitting) return;
    setSubmitting(true);
    try {
      await onAllocated(agentId);
    } finally {
      // 成功时父组件已关闭弹窗（组件卸载）；失败时恢复可点，允许重试
      if (mountedRef.current) setSubmitting(false);
    }
  }

  // 文案分支：不同来源说不同的话，避免"团队池里"这种错误措辞出现在 personal tab。
  const description = memorySource === 'team' ? (
    <>
      把团队池里的记忆块 <Text theme="strong" parent="span">{memoryTitle}</Text> 绑定到所选 agent 的固定资产。
    </>
  ) : (
    <>
      把记忆块 <Text theme="strong" parent="span">{memoryTitle}</Text> 分配到所选 agent 的固定资产。
    </>
  );

  return (
    <Modal visible caption="分配记忆块到 Agent" size="s" onClose={onClose} disableEscape={submitting}>
      <Modal.Body>
        <Form>
          <Form.Item label="说明"><Form.Text>{description}</Form.Text></Form.Item>
          {agents.length === 0 ? (
            <Alert type="warning">
              没有可分配的 Agent。可能的原因：
              <br />· 你还没有创建任何 Agent —— 请先到「Agent 管理」创建一个。
              <br />· 选中的记忆块是你某个 Agent 的自有记忆，不能分配给同一个 Agent（规则：不能把 Agent 自己的记忆再分配给自己）。
              <br />· 该记忆块已绑定到你所有的 Agent，无需重复分配。
            </Alert>
          ) : (
            <Form.Item label="Agent" required>
              <Select size="full" value={agentId} onChange={setAgentId} placeholder="无可选 agent"
                options={agents.map((a) => ({ value: a.agent_id, text: a.name }))} />
            </Form.Item>
          )}
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" onClick={() => void submit()} disabled={!agentId || submitting} loading={submitting}>分配</Button>
        <Button onClick={onClose} disabled={submitting}>取消</Button>
      </Modal.Footer>
    </Modal>
  );
}
