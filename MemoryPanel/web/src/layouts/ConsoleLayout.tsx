/**
 * ConsoleLayout — 主布局壳（Tea 组件重构版）
 *
 * 使用外部版 tea-component@2.8.0 的 `Layout` + `Menu` 组件替换手写布局。
 * 保留 TabBar、路由、菜单过滤等所有业务逻辑。
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Menu } from 'tea-component';
import { useAuthStore } from '@/stores/auth';
import { useCurrentRole, type TeamRole } from '@/services/useCurrentRole';
import { GlobalHeader } from '@/layouts/GlobalHeader';
import { TabBar } from '@/layouts/TabBar';
import { PAGE_META, GROUP_ORDER, ITEM_ICON, type PageId, type PageMeta } from '@/constants/menu';

const { Body, Sider, Content } = Layout;

/** 路由 path → PageId */
const PATH_TO_PAGE: Record<string, PageId> = {
  '/': 'workbench_board',
  '/wiki': 'wiki',
  '/code': 'code',
  '/skills': 'skills',
  '/memory': 'chat_memory',
  '/team/members': 'team_members',
  '/team/agents': 'team_agents',
  '/team/api-keys': 'api_keys',
};

/** PageId → 路由 path */
const PAGE_TO_PATH: Record<PageId, string> = Object.fromEntries(
  Object.entries(PATH_TO_PAGE).map(([path, id]) => [id, path])
) as Record<PageId, string>;

function legacyHashToPath(): string | null {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const leaf = raw.split('/').filter(Boolean).pop();
  if (!leaf) return null;
  if (leaf === 'wiki') return '/wiki';
  if (leaf === 'code') return '/code';
  if (leaf === 'skills' || leaf === 'skill') return '/skills';
  if (leaf === 'chat_memory' || leaf === 'memory' || leaf === 'chat-memory') return '/memory';
  if (leaf === 'agents' || leaf === 'team_agents') return '/team/agents';
  if (leaf === 'team' || leaf === 'members' || leaf === 'team_members') return '/team/members';
  if (leaf === 'api_keys' || leaf === 'apikey' || leaf === 'api-keys') return '/team/api-keys';
  return null;
}

export function ConsoleLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { auth, logout } = useAuthStore();
  const userRole: TeamRole | null = useCurrentRole();

  const activePage: PageId = useMemo(() => {
    const match = Object.entries(PATH_TO_PAGE).find(
      ([path]) => path !== '/' && location.pathname.startsWith(path)
    );
    return match ? match[1] : 'workbench_board';
  }, [location.pathname]);

  useEffect(() => {
    const legacyPath = legacyHashToPath();
    if (legacyPath && legacyPath !== location.pathname) {
      navigate(legacyPath, { replace: true });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [openPages, setOpenPages] = useState<PageId[]>(() => [activePage]);

  useEffect(() => {
    setOpenPages((prev) => (prev.includes(activePage) ? prev : [...prev, activePage]));
  }, [activePage]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const navigateTo = useCallback(
    (id: PageId) => {
      const path = PAGE_TO_PATH[id];
      if (path) navigate(path);
    },
    [navigate]
  );

  const closePage = useCallback(
    (id: PageId) => {
      setOpenPages((prev) => {
        // 关的是点了 × 的那个 tab（id），不是当前 active 的那个。
        // 之前误写 `prev.filter((p) => p !== activePage)` —— 结果不管点哪个 tab
        // 的 × 都是删当前 active tab，视觉上表现为「点第 N 个 × 却删了当前所在 tab」。
        const next = prev.filter((p) => p !== id);
        // 只有关掉的正好是当前 active 那个 → 才需要切到剩下的最后一个
        if (id === activePage && next.length > 0) {
          navigateTo(next[next.length - 1]);
        }
        return next;
      });
    },
    [activePage, navigateTo]
  );

  // ===== 基于 team role 的菜单过滤 =====
  // 「资源管理」分组：admin 不可见
  // 「成员管理」项：member / reviewer 不可见
  const menuGroups = useMemo(() => {
    const byGroup = new Map<string, PageMeta[]>();

    for (const meta of Object.values(PAGE_META)) {
      // admin 角色 → 跳过所有「资源管理」分组下的项
      if (userRole === 'admin' && meta.group === '资源管理') continue;
      // reviewer → 跳过「成员管理」（member 可见，但新建/删除成员/Team 按钮在组件内按角色收敛）
      if (userRole === 'reviewer' && meta.id === 'team_members') continue;
      const list = byGroup.get(meta.group) ?? [];
      list.push(meta);
      byGroup.set(meta.group, list);
    }

    return GROUP_ORDER
      .filter((g) => byGroup.has(g))
      .map((g) => ({
        title: g,
        items: byGroup.get(g)!.sort((a, b) => a.order - b.order),
      }));
  }, [userRole]);

  // 「工作台」分组只有任务看板一项，置顶展示为独立入口，不显示分组标题
  const pinnedGroup = menuGroups.find((g) => g.title === '工作台');
  const restGroups = menuGroups.filter((g) => g.title !== '工作台');

  const renderMenuItem = (item: PageMeta) => {
    const isActive = activePage === item.id;
    return (
      <Menu.Item
        key={item.id}
        title={item.label}
        icon={ITEM_ICON[item.id]}
        selected={isActive}
        onClick={() => navigateTo(item.id)}
      />
    );
  };

  return (
    <div className="_memory-app-shell">
      <GlobalHeader
        userRole={userRole}
        currentUser={auth?.user ?? ''}
        currentUserId={auth?.user_id}
        onLogout={logout}
      />
      <Layout>
        <Body>
          <Sider>
            {/* 品牌已在全局 Header 展示，侧栏只承载导航（与 Memory项目公共壳层一致）。 */}
            <Menu
              collapsable
              collapsed={sidebarCollapsed}
              onCollapsedChange={setSidebarCollapsed}
            >
              {pinnedGroup?.items.map((item) => renderMenuItem(item))}
              {restGroups.map((group) => (
                <Menu.Group key={group.title} title={group.title}>
                  {group.items.map((item) => renderMenuItem(item))}
                </Menu.Group>
              ))}
            </Menu>
          </Sider>
          <Content>
            <TabBar
              pages={openPages}
              activePage={activePage}
              onNavigate={navigateTo}
              onClose={closePage}
            />
            <Content.Body className="_memory-content-body">
              <main className="_memory-page-frame">
                <Outlet />
              </main>
            </Content.Body>
          </Content>
        </Body>
      </Layout>
    </div>
  );
}
