/**
 * TeamSwitcher — 全局顶栏内嵌的 Team 切换器
 *
 * 从侧边栏迁移到顶栏后的行内 pill 样式版本：使用 Tea `Dropdown` 承载弹出面板
 * （自带定位、遮罩点击关闭、滚动关闭等能力），面板内部用 `List`/`Input`/`Button` 组装。
 */
import { useState } from 'react';
import { Dropdown, List, Input, Button } from 'tea-component';
import { ChevronDownIcon, CheckIcon, AddIcon } from 'tea-icons-react';
import { useTeams, writeActiveTeamId, invalidateBackendCache, invalidateTeamCache } from '@/services';
import { type TeamRole } from '@/services/useCurrentRole';
import { teamsApi } from '@/lib/teamApi';
import { teamColor } from '@/utils/color';
import { tea } from '@/lib/tea-bridge';
import './team-switcher.css';

export function TeamSwitcher({ userRole }: { userRole: TeamRole | null }) {
  const { teams, activeTeamId } = useTeams();
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [newTeamName, setNewTeamName] = useState('');
  const [newTeamDesc, setNewTeamDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // teamsApi.list() 已经处理好过滤：普通成员按 user_id 过滤（只返回自己所属 team），
  // system_admin 则省略 user_id 做实例级列举（返回全部 team，不受"是否是该 team 成员"限制），
  // 前端这里无需再做任何二次筛选。
  const myTeams = teams;
  const active = myTeams.find((t) => t.team_id === activeTeamId) ?? null;

  function resetCreateForm() {
    setShowCreateTeam(false);
    setNewTeamName('');
    setNewTeamDesc('');
  }

  function pick(team_id: string, close: () => void) {
    writeActiveTeamId(team_id);
    // 切 team 时只清当前 team 的 agents/tasks 缓存，不清 teams 列表
    invalidateTeamCache(team_id);
    close();
  }

  async function handleCreate() {
    const name = newTeamName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await teamsApi.create({ name, description: newTeamDesc.trim() });
      invalidateBackendCache();
      writeActiveTeamId(created.team_id);
      resetCreateForm();
    } catch (err) {
      tea.notify.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dropdown
      appearance="pure"
      clickClose={false}
      matchButtonWidth={false}
      className="_memory-team-switcher-dropdown"
      boxClassName="_memory-team-switcher-box"
      onClose={resetCreateForm}
      button={
        <button
          type="button"
          className="_memory-team-switcher-trigger"
          title={active?.name ?? '选择 team'}
        >
          <span className={`_memory-team-switcher-avatar ${active ? teamColor(active.team_id) : 'bg-primary'}`}>
            {(active?.name ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <span className="_memory-team-switcher-meta">
            <span className="_memory-team-switcher-name">{active?.name ?? '选择 team'}</span>
            <span className="_memory-team-switcher-id">{active?.team_id ?? '未选择'}</span>
          </span>
          <ChevronDownIcon size={12} className="_memory-team-switcher-chevron" />
        </button>
      }
    >
      {(close) => (
        <div className="_memory-team-switcher-panel">
          <div className="_memory-team-switcher-panel-header">
            <div className="_memory-team-switcher-panel-title">切换团队</div>
            <div className="_memory-team-switcher-panel-desc">
              不同团队的资产相互独立。切换后会在当前页面显示对应团队的数据。
            </div>
          </div>

          <div className="_memory-team-switcher-panel-label">团队（{myTeams.length}）</div>

          <div className="_memory-team-switcher-list-wrap">
            {myTeams.length === 0 ? (
              <div className="_memory-team-switcher-empty">
                {userRole === 'admin'
                  ? '暂无 team。点击下方「新建团队」创建。'
                  : '你还没有被加入任何 team。请联系管理员将你加入团队。'}
              </div>
            ) : (
              <List type="plain" split="divide" className="_memory-team-switcher-list">
                {myTeams.map((t) => {
                  const isActive = t.team_id === activeTeamId;
                  return (
                    <List.Item
                      key={t.team_id}
                      selected={isActive}
                      className="_memory-team-switcher-item"
                      onClick={() => pick(t.team_id, close)}
                    >
                      <span className={`_memory-team-switcher-item-avatar ${teamColor(t.team_id)}`}>
                        {t.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="_memory-team-switcher-item-meta">
                        <span className="_memory-team-switcher-item-name">{t.name}</span>
                        <span className="_memory-team-switcher-item-count">{t.members.length} 名成员</span>
                      </span>
                      {isActive && <CheckIcon size={16} className="_memory-team-switcher-item-check" />}
                    </List.Item>
                  );
                })}
              </List>
            )}
          </div>

          <div className="_memory-team-switcher-footer">
            {userRole !== 'admin' ? null : showCreateTeam ? (
              <div className="_memory-team-switcher-create-form">
                <Input
                  autoFocus
                  size="full"
                  value={newTeamName}
                  onChange={setNewTeamName}
                  placeholder="团队名称（必填）"
                />
                <Input
                  size="full"
                  value={newTeamDesc}
                  onChange={setNewTeamDesc}
                  placeholder="团队描述（选填）"
                />
                <div className="_memory-team-switcher-create-actions">
                  <Button onClick={resetCreateForm}>取消</Button>
                  <Button type="primary"
                    loading={creating}
                    disabled={!newTeamName.trim() || creating}
                    onClick={handleCreate}
                  >
                    创建
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="text"
                className="_memory-team-switcher-create-trigger"
                onClick={() => setShowCreateTeam(true)}
              >
                <AddIcon size={14} />
                新建团队
              </Button>
            )}
          </div>
        </div>
      )}
    </Dropdown>
  );
}
