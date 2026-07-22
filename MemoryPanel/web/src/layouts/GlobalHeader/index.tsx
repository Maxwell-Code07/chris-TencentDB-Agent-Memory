/**
 * GlobalHeader — 全局顶栏（跨越侧边栏 + 内容区，最外层通栏）
 *
 *   左侧：品牌 Logo「Memory Hub」 + 分隔线 + 团队切换器（TeamSwitcher）
 *   右侧：同步状态指示 + 用户头像菜单
 */
import { useState } from 'react';
import { Button, Copy, Dropdown, List, Modal } from 'tea-component';
import { SettingIcon } from 'tea-icons-react';
import { SettingsDialog } from '@/components/SettingsDialog';
import { type TeamRole } from '@/services/useCurrentRole';
import { TeamSwitcher } from './TeamSwitcher';
import './style.css';

export function GlobalHeader({
  userRole,
  currentUser,
  currentUserId,
  onLogout,
}: {
  userRole: TeamRole | null;
  currentUser: string;
  currentUserId?: string;
  onLogout: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <header className="_memory-global-header">
      {/* 左侧：品牌 + 团队切换器 */}
      <div className="_memory-global-header-left">
        <div className="_memory-global-header-brand">
          <img src="/logo.png" alt="Memory Hub" className="_memory-global-header-logo" />
          <span className="_memory-global-header-brand-text">Memory Hub</span>
        </div>
        <TeamSwitcher userRole={userRole} />
      </div>

      {/* 右侧：同步状态 + 用户菜单 */}
      <div className="_memory-global-header-right">
        <span className="_memory-global-header-sync" title="实时同步已连接">
          <span className="_memory-global-header-sync-dot" />
          实时同步
        </span>

        <button
          type="button"
          className="_memory-global-header-icon-btn"
          title="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <SettingIcon size={16} />
        </button>

        <Dropdown
          appearance="pure"
          button={
            <button type="button" className="_memory-global-header-user-btn">
              <span className="_memory-global-header-avatar">
                {currentUser.slice(0, 1).toUpperCase()}
              </span>
              <span className="_memory-global-header-username">{currentUser}</span>
            </button>
          }
        >
          {(close) => (
            <List type="option">
              <List.Item
                onClick={() => {
                  close();
                  setProfileOpen(true);
                }}
              >
                我的资料
              </List.Item>
              <List.Item
                onClick={() => {
                  close();
                  onLogout();
                }}
              >
                退出登录
              </List.Item>
            </List>
          )}
        </Dropdown>
      </div>

      {profileOpen && currentUserId && (
        <Modal visible caption="我的资料" size="s" onClose={() => setProfileOpen(false)}>
          <Modal.Body>
            <dl className="_memory-profile-details">
              <div><dt>用户名</dt><dd>{currentUser}</dd></div>
              <div>
                <dt>User ID</dt>
                <dd><code>{currentUserId}</code> <Copy text={currentUserId} /></dd>
                <small>发给团队管理员用于邀请你加入 Team</small>
              </div>
            </dl>
          </Modal.Body>
          <Modal.Footer><Button onClick={() => setProfileOpen(false)}>关闭</Button></Modal.Footer>
        </Modal>
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}
