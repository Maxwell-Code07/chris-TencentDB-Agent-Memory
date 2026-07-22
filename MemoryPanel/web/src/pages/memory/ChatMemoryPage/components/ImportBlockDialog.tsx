import { useState, useMemo, useRef, useEffect } from 'react';
import { Alert, Button, Form, Input, Modal, Segment, Select, Text, Upload } from 'tea-component';
import { FilePasteIcon, UploadIcon } from 'tea-icons-react';
import { type AgentOption } from './types';

/** 与 docs/api/chat-memory.md §4.10 import 接口对齐 */
interface ImportMessage {
  role: 'user' | 'assistant';
  content: string;
}

const MAX_MESSAGES = 100;
const SAMPLE_JSON = `[
  { "role": "user", "content": "帮我 review 一下这段代码" },
  { "role": "assistant", "content": "好的，请贴出来。" }
]`;

type ParseResult =
  | { ok: true; messages: ImportMessage[] }
  | { ok: false; error: string };

function parseMessages(text: string): ParseResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: '内容为空，请粘贴或上传 JSON。' };

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return { ok: false, error: 'JSON 解析失败，请检查格式。' }; }

  if (!Array.isArray(parsed)) return { ok: false, error: '根节点必须是 JSON 数组。' };
  if (parsed.length === 0) return { ok: false, error: '消息数组不能为空。' };
  if (parsed.length > MAX_MESSAGES) return { ok: false, error: `单次最多导入 ${MAX_MESSAGES} 条消息，当前 ${parsed.length} 条。` };

  const messages: ImportMessage[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const m = parsed[i] as any;
    if (!m || typeof m !== 'object') return { ok: false, error: `第 ${i + 1} 项不是对象。` };
    const role = m.role;
    if (role !== 'user' && role !== 'assistant') {
      return { ok: false, error: `第 ${i + 1} 项 role 必须是 "user" 或 "assistant"，当前为 "${role}"。` };
    }
    const content = m.content;
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, error: `第 ${i + 1} 项 content 必须是非空字符串。` };
    }
    messages.push({ role, content });
  }
  return { ok: true, messages };
}

export function ImportBlockDialog({
  onClose,
  onImported,
  agents,
  defaultAgentId,
}: {
  onClose: () => void;
  onImported: (params: { agent_id: string; messages: ImportMessage[] }) => void | Promise<void>;
  agents: AgentOption[];
  defaultAgentId: string;
}) {
  const [scopeAgentId, setScopeAgentId] = useState<string>(
    defaultAgentId || agents[0]?.agent_id || ''
  );
  const [importMode, setImportMode] = useState<'paste' | 'file'>('paste');
  const [sessionPayload, setSessionPayload] = useState('');
  const [fileName, setFileName] = useState('');

  const [submitting, setSubmitting] = useState(false);
  // 组件卸载后不再 setState（导入成功时父组件会关闭本弹窗）
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const parsed = useMemo(() => parseMessages(sessionPayload), [sessionPayload]);
  const canSubmit = !!scopeAgentId && parsed.ok && !submitting;

  function handleFilePicked(file: File): boolean {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setSessionPayload(reader.result as string);
    reader.onerror = () => setSessionPayload('');
    reader.readAsText(file);
    return false;
  }

  async function submit() {
    // in-flight 锁：提交进行中直接忽略后续点击，避免高延迟下重复导入同一份数据
    if (!parsed.ok || !scopeAgentId || submitting) return;
    setSubmitting(true);
    try {
      await onImported({ agent_id: scopeAgentId, messages: parsed.messages });
    } finally {
      // 成功时父组件已关闭弹窗（组件卸载）；失败时恢复可点，允许重试
      if (mountedRef.current) setSubmitting(false);
    }
  }

  return (
    <Modal visible caption="导入记忆" size="l" onClose={onClose} disableEscape={submitting}>
      <Modal.Body>
        <Alert type="info">把一段历史对话（JSON 消息数组）作为 L0 导入到指定 agent，由系统自动蒸馏 L1/L2/L3。</Alert>
      {/* 归属 agent */}
      <Form layout="vertical" style={{ width: '100%' }}>
        <Form.Item label="归属 Agent（必选）" extra="记忆将作为该 agent 的固定资产 —— 仅当 task 关联了该 agent 时才会被加载。">
          {agents.length === 0 ? (
            <Alert type="warning">当前 team 暂无 agent，无法导入。请先到团队管理中创建至少一个 agent。</Alert>
          ) : (
            <Select size="full" value={scopeAgentId} onChange={setScopeAgentId}
              options={agents.map((a) => ({ value: a.agent_id, text: `${a.name}（${a.agent_id}）` }))} />
          )}
        </Form.Item>
      </Form>

      {/* 格式说明 */}
      <Alert type="info" style={{ marginTop: 12 }}>
        <div className="space-y-1">
          <div>支持 <code className="px-1 rounded text-[11px]" style={{ background: 'var(--tea-color-bg-secondary-default)' }}>[{`{role, content}`}]</code> 格式的 JSON 数组：</div>
          <ul className="list-disc pl-5 text-[11px] space-y-0.5">
            <li><code className="text-[11px]">role</code> 取值：<code className="text-[11px]">"user"</code> 或 <code className="text-[11px]">"assistant"</code></li>
            <li><code className="text-[11px]">content</code>：消息正文（字符串，非空）</li>
            <li>单次最多 <strong>{MAX_MESSAGES}</strong> 条</li>
          </ul>
        </div>
      </Alert>

      {/* 导入方式切换 */}
      <div style={{ marginTop: 12 }}>
        <Segment value={importMode} onChange={(v) => setImportMode(v as 'paste' | 'file')}
          options={[{ value: 'paste', text: (<><FilePasteIcon size={12} /> 粘贴文本</>) }, { value: 'file', text: (<><UploadIcon size={12} /> 导入 JSON 文件</>) }]} />
      </div>

      <Form layout="vertical" style={{ width: '100%', marginTop: 12 }}>
        {importMode === 'paste' ? (
          <Form.Item label="Messages（JSON 数组）">
            <Input.TextArea
              size="full"
              value={sessionPayload}
              onChange={(v) => setSessionPayload(v)}
              rows={8}
              placeholder={SAMPLE_JSON}
              className="font-mono text-[12px]"
              style={{ maxHeight: 240, overflowY: 'auto' }}
            />
          </Form.Item>
        ) : (
          <Form.Item label="选择 JSON 文件">
            <Upload accept=".json,.txt,.md" beforeUpload={handleFilePicked}><Button>选择文件</Button></Upload>
            {fileName && <Text theme="text" parent="div" style={{ marginTop: 6 }}>已选择：<Text parent="code">{fileName}</Text></Text>}
            {sessionPayload && (
              <Form.Item label="文件内容预览" style={{ marginTop: 8 }}>
                <pre className="w-full max-h-48 overflow-y-auto rounded-lg border bg-muted/50 px-2 py-1.5 text-[10px] font-mono text-foreground/70 whitespace-pre-wrap">
                  {sessionPayload.slice(0, 2000)}{sessionPayload.length > 2000 ? '\n…（已截断）' : ''}
                </pre>
              </Form.Item>
            )}
          </Form.Item>
        )}
      </Form>

      {/* 解析结果反馈 */}
      {sessionPayload.trim() && parsed.ok && (
        <Alert type="success" style={{ marginTop: 12 }}>
          解析成功 · 共 {parsed.messages.length} 条消息（{parsed.messages.filter(m => m.role === 'user').length} user / {parsed.messages.filter(m => m.role === 'assistant').length} assistant）
        </Alert>
      )}
      {sessionPayload.trim() && !parsed.ok && (
        <Alert type="error" style={{ marginTop: 12 }}>{parsed.error}</Alert>
      )}
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          disabled={!canSubmit}
          loading={submitting}
          onClick={submit}
          title={!scopeAgentId ? '请先选择归属 agent' : !parsed.ok ? parsed.error : ''}
        >
          {submitting ? '导入中…' : '导入记忆'}
        </Button>
        <Button onClick={onClose} disabled={submitting}>取消</Button>
      </Modal.Footer>
    </Modal>
  );
}
