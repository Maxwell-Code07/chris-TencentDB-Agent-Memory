/**
 * 资源管理页面通用壳 — Wiki / Code / Skills / Memory 共用
 *
 * Admin 角色显示锁定提示，member 角色正常显示内容。
 * 外层由 ConsoleLayout 的 Content.Body 包裹，这里作为直接子节点。
 */
import type { ReactNode } from 'react';
import { useCurrentRole } from '@/services/useCurrentRole';
import { AdminResourceLock } from './components/AdminResourceLock';
import './page-style.css';

export function ResourcePage({ children }: { children: ReactNode }) {
  const role = useCurrentRole();

  if (role === 'admin') {
    return <AdminResourceLock />;
  }

  return (
    <div className="_memory-page-body">
      {children}
    </div>
  );
}
