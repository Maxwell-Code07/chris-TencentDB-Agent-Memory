import { ShareIcon, LockOnIcon, UserIcon } from 'tea-icons-react';
import { Card, List, Tag, Button, Text } from 'tea-component';
import { useUserDisplayName } from '@/services/user-profile-store';
import { type MemoryBlock } from './types';

/**
 * 「我的资产分配」tab 列表。
 *
 * 视觉与交互对齐 Memory 项目 —— Memory 的 ChatMemory 直接复用 SkillsPanel 的
 * PersonalAssetTab，因此本组件也采用同款呈现：
 *   - Tea Card + List（非自绘 div 卡片），选中态用左 border + 品牌浅底
 *   - owner 用 Tag（display_name 优先，避免长 user_id 撑宽）
 *   - 共享/私密用 Tea Button 组（品牌单色，与 Skill 一致），不再用内联 style
 *   - 点击行选中 / 再点取消；共享/私密按钮组 stopPropagation 不触发行选中
 *
 * 与「固定资产」tab 左侧 list 的交互一致：
 *   点击行 → 切换 selectedId → 顶部「分配到 Agent」按钮据此 enable / disable
 */

/** owner 用户徽章：优先展示 display_name，回退 user_id；独立组件以满足 Rules of Hooks。 */
function MemoryOwnerTag({ userId, isCurrentUser }: { userId: string; isCurrentUser: boolean }) {
  const displayName = useUserDisplayName(userId);
  return (
    <Tag theme="primary" variant="soft" size="sm" shapeType="rectangle" className="_cm-personal-owner-tag">
      <span className="_cm-personal-tag-content" title={`owner user: ${displayName || userId}（${userId}）`}>
        <UserIcon size={10} /> {displayName || userId}
        {isCurrentUser && '（你）'}
      </span>
    </Tag>
  );
}

export function PersonalAssetsTable({
  blocks,
  loading,
  onToggleScope,
  selectedId,
  onSelect,
  currentUserId,
}: {
  blocks: MemoryBlock[];
  loading: boolean;
  onToggleScope: (block: MemoryBlock, newScope: 'team' | 'private') => void;
  /** 当前选中行的 block.id（单值）。null 表示未选中 —— 顶部按钮 disabled。 */
  selectedId: string | null;
  /** 选中某行 / 取消选中（传 null）。再点同一行也应触发 null。 */
  onSelect: (id: string | null) => void;
  /** 当前登录用户 id，用于 owner 徽章的「（你）」标记。 */
  currentUserId: string;
}) {
  return (
    <Card>
      <Card.Body>
        {/* 顶部 */}
        <div className="_cm-personal-header">
          <Text theme="strong" parent="div">我的资产分配</Text>
          <Text theme="weak" parent="div" className="_cm-personal-header-desc">
            新建 Agent 时自动生成的记忆默认私密，切换为「共享」后团队内其他成员可见（只读）
          </Text>
        </div>

        {loading ? (
          <div className="_cm-personal-empty">
            <Text theme="weak">加载中…</Text>
          </div>
        ) : blocks.length === 0 ? (
          <div className="_cm-personal-empty">
            <Text theme="weak" parent="div">
              暂无记忆资产 · 创建一个 Agent 后会自动生成一条属于它的私密记忆
            </Text>
          </div>
        ) : (
          <List split="divide" className="_cm-personal-items">
            {blocks.map((block) => {
              const isSelected = selectedId === block.id;
              const isTeam = block.scope === 'team';
              const isPrivate = !isTeam;
              const ownerIsMe = !!block.uploaded_by_user_id && block.uploaded_by_user_id === currentUserId;
              return (
                <List.Item
                  key={block.id}
                  selected={isSelected}
                  // 与 Skill PersonalAssetTab 一致的切换逻辑：再点同一行 → 取消选中
                  onClick={() => onSelect(isSelected ? null : block.id)}
                  className="_cm-personal-asset"
                >
                  {/* 主信息：标题 + 更新时间 + block.id + owner 徽章 */}
                  <div className="_cm-personal-asset-main">
                    <div className="_cm-personal-asset-name" title={block.title}>{block.title}</div>
                    <div className="_cm-personal-asset-meta">
                      更新时间：{new Date(block.updated_at_ms).toLocaleString()}
                    </div>
                    <div className="_cm-personal-asset-id" title={block.id}>{block.id}</div>
                    {block.uploaded_by_user_id && (
                      <div className="_cm-personal-asset-badges">
                        <MemoryOwnerTag userId={block.uploaded_by_user_id} isCurrentUser={ownerIsMe} />
                        {isTeam ? (
                          <Tag theme="success" variant="soft" size="sm" shapeType="rectangle" className="_cm-personal-state-tag">
                            <span className="_cm-personal-tag-content"><ShareIcon size={10} /> 共享</span>
                          </Tag>
                        ) : (
                          <Tag theme="default" variant="soft" size="sm" shapeType="rectangle" className="_cm-personal-state-tag">
                            <span className="_cm-personal-tag-content"><LockOnIcon size={10} /> 私密</span>
                          </Tag>
                        )}
                      </div>
                    )}
                  </div>

                  {/* 操作行：共享 / 私密切换。stopPropagation 避免触发行选中。
                      与 Skill PersonalAssetTab 完全一致：type=primary(选中)/weak(未选中)。 */}
                  <div className="_cm-personal-asset-controls" onClick={(e) => e.stopPropagation()}>
                    <div className="_cm-personal-scope-switch">
                      <Button
                        type={isTeam ? 'primary' : 'weak'}
                        onClick={() => onToggleScope(block, 'team')}
                        tooltip="team 内成员可读；owner 和 admin 可写"
                      >
                        <ShareIcon size={12} /> 共享
                      </Button>
                      <Button
                        type={isPrivate ? 'primary' : 'weak'}
                        onClick={() => onToggleScope(block, 'private')}
                        tooltip="只有 owner 和 team admin 能看到"
                      >
                        <LockOnIcon size={12} /> 私密
                      </Button>
                    </div>
                  </div>
                </List.Item>
              );
            })}
          </List>
        )}
      </Card.Body>
    </Card>
  );
}
