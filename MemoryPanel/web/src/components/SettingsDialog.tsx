/**
 * SettingsDialog — 全局设置弹窗（从顶栏⚙图标触发）。
 *
 * 当前只有一个 Tab：「权限管理」— 控制资源管理模块的开关
 * （Wiki / Code / Skill / Chat_Memory），防止未稳定使用的模块
 * 被注入内核运行。
 *
 * 后续可在 TABS 数组里追加其他 Tab（如通知、偏好设置等）。
 *
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Switch,
  Text,
  Tag,
  Modal,
} from 'tea-component';
import {
  BooksIcon,
  CodeIcon,
  ToolsIcon,
  ChatIcon,
} from 'tea-icons-react';
import { userConfigApi, type AssetCapabilityKey } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';

// ===== 资源模块 =====

interface ResourceModule {
  id: string;
  paramKey: AssetCapabilityKey;
  label: string;
  desc: string;
  icon: JSX.Element;
}

// Wiki / Code_Graph 关闭 = 仅停止工具注入，不影响已有数据。
// Skill / Chat_Memory 关闭 = 工具注入 + 新数据写入都停（已有数据保留）。
const RESOURCE_MODULES: ResourceModule[] = [
  {
    id: 'wiki',
    paramKey: 'llm_wiki.enabled',
    label: 'Wiki 知识库',
    desc: '关闭后仅停止工具注入',
    icon: <BooksIcon size={16} />,
  },
  {
    id: 'code',
    paramKey: 'code_graph.enabled',
    label: 'Code_Graph',
    desc: '关闭后仅停止工具注入',
    icon: <CodeIcon size={16} />,
  },
  {
    id: 'skill',
    paramKey: 'skill.enabled',
    label: 'Skill 技能',
    desc: '关闭后工具注入与新技能抽取均停止',
    icon: <ToolsIcon size={16} />,
  },
  {
    id: 'chat_memory',
    paramKey: 'chat_memory.enabled',
    label: 'Chat_Memory',
    desc: '关闭后工具注入与新对话写入均停止',
    icon: <ChatIcon size={16} />,
  },
];

// ===== Tab 定义 =====
//
// 目前只有「权限管理」一个 tab；上一版删掉 <Tabs> 后 TABS / TabDef 变成
// unused declaration（tsc noUnusedLocals 直接 error）。这里保留 SettingsTab
// 类型给未来扩展，TABS 数组等真加了第二个 tab 再声明。

type SettingsTab = 'permissions';

// ===== Component =====

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  // 目前只有一个 tab；等未来加第二个再改回 useState 承载 activeTab。
  const activeTab: SettingsTab = 'permissions';

  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => ({
    wiki: true,
    code: true,
    skill: true,
    chat_memory: true,
  }));
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<AssetCapabilityKey | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    userConfigApi.getAssetCapabilities()
      .then((cfg) => {
        if (cancelled) return;
        setEnabled({
          wiki: cfg['llm_wiki.enabled'],
          code: cfg['code_graph.enabled'],
          skill: cfg['skill.enabled'],
          chat_memory: cfg['chat_memory.enabled'],
        });
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(mod: ResourceModule, next: boolean) {
    const previous = enabled[mod.id];
    setEnabled((prev) => ({ ...prev, [mod.id]: next }));
    setSavingKey(mod.paramKey);
    setError('');
    try {
      await userConfigApi.setAssetCapability(mod.paramKey, next);
      tea.notify.success(`${mod.label} 已${next ? '开启' : '关闭'}`);
    } catch (e) {
      setEnabled((prev) => ({ ...prev, [mod.id]: previous }));
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      tea.notify.error(`保存失败：${msg}`);
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <Modal visible caption="设置 · 权限管理" size="m" onClose={onClose}>
      <Modal.Body>
      {/*
        当前只有「权限管理」一个 tab，历史上用 <Tabs>+<TabPanel> 会渲染两条下划线
        （tab bar 底边 + 选中项 indicator）视觉上像 bug。直接铺开内容，等未来
        真的加了第二个 tab 再把 Tabs 加回来。activeTab / setActiveTab 保留作为
        未来扩展锚点。
      */}
      {activeTab === 'permissions' && (
        <div>
          <div style={{ paddingTop: 4 }}>
            <Text theme="label" style={{ display: 'block', marginBottom: 8 }}>
              资源管理模块开关
            </Text>
            <Text theme="weak" style={{ display: 'block', marginBottom: 16, fontSize: 12 }}>
              开关按当前登录用户保存。关闭后，proxy 不会为该用户注入对应原子能力；变更对新会话即时生效。
            </Text>
            {error && <Alert type="error" style={{ marginBottom: 12 }}>{error}</Alert>}
            {loading && <Alert type="info" style={{ marginBottom: 12 }}>正在读取当前用户资源配置…</Alert>}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {RESOURCE_MODULES.map((mod) => (
                <div
                  key={mod.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '10px 12px',
                    border: '1px solid var(--tea-color-border-primary-default)',
                    borderRadius: 6,
                    background: enabled[mod.id]
                      ? 'var(--tea-color-bg-brand-lighten-default)'
                      : 'var(--tea-color-bg-primary-default)',
                    transition: 'background-color 0.15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                    <span style={{ color: 'var(--tea-color-text-secondary)', flexShrink: 0 }}>
                      {mod.icon}
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <Text style={{ fontSize: 13, fontWeight: 500 }}>
                          {mod.label}
                        </Text>
                        {savingKey === mod.paramKey ? (
                          <Tag theme="warning" variant="soft" size="sm">保存中</Tag>
                        ) : enabled[mod.id] ? (
                          <Tag theme="success" variant="soft" size="sm">已开启</Tag>
                        ) : (
                          <Tag theme="default" variant="soft" size="sm">已关闭</Tag>
                        )}
                      </div>
                      <Text theme="weak" style={{ fontSize: 12, marginTop: 2, display: 'block' }}>
                        {mod.desc}
                      </Text>
                    </div>
                  </div>
                  <Switch
                    value={enabled[mod.id]}
                    disabled={loading || savingKey === mod.paramKey}
                    onChange={(v) => void handleToggle(mod, v)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      </Modal.Body>
    </Modal>
  );
}
