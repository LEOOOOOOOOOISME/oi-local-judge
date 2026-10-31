import type { ReactNode } from 'react';
import { Button, Result } from 'antd';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { PageLoading } from './PageStates';

/**
 * 管理端路由守卫：admin / setter 可进；未登录跳登录页；其余角色显示 403。
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <PageLoading tip="正在校验管理权限…" />;
  }
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (user.role !== 'admin' && user.role !== 'setter') {
    return (
      <Result
        status="403"
        title="无权访问"
        subTitle="管理后台仅对管理员和出题人开放。"
        extra={
          <Link to="/contests">
            <Button type="primary">返回比赛列表</Button>
          </Link>
        }
      />
    );
  }
  return <>{children}</>;
}
