/**
 * CreateTeamDialog —— 新建 Team 弹窗（拆自 TeamManagementPanel）。
 */

import { useState } from 'react';
import { Button, Form, Input, Modal } from 'tea-component';

export default function CreateTeamDialog({
  onClose,
  onCreate,
  busy,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; description: string }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const canSubmit = name.trim().length > 0 && !busy;
  return (
    <Modal visible caption="创建 Team" size="s" onClose={onClose} disableEscape={busy}>
      <Modal.Body>
        <Form>
          <Form.Item label="名称" required extra="Team 是资产、agent 和 task 的主要边界。">
            <Input
              autoFocus
              size="full"
              value={name}
              onChange={setName}
              placeholder="例如 tdai-memory · 后端组"
            />
          </Form.Item>
          <Form.Item label="描述">
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={3}
              placeholder="一句话说明 team 范围与目标"
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button type="primary" disabled={!canSubmit} loading={busy} onClick={() => onCreate({ name: name.trim(), description: description.trim() })}>创建</Button>
        <Button onClick={onClose} disabled={busy}>取消</Button>
      </Modal.Footer>
    </Modal>
  );
}
