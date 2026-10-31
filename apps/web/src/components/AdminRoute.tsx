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

/**
 * 比赛/用户管理路由守卫：admin / contestmanager 可进；其余角色 403。
 */
export function ContestAdminRoute({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <PageLoading tip="正在校验管理权限…" />;
  }
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (user.role !== 'admin' && user.role !== 'contestmanager') {
    return (
      <Result
        status="403"
        title="无权访问"
        subTitle="比赛与用户管理仅对管理员和比赛管理员开放。"
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

/**
 * 社区审核路由守卫：admin / setter / contestmanager 可进。
 */
export function CommunityAdminRoute({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <PageLoading tip="正在校验管理权限…" />;
  }
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (!['admin', 'setter', 'contestmanager'].includes(user.role)) {
    return (
      <Result
        status="403"
        title="无权访问"
        subTitle="社区审核仅对管理员、出题人和比赛管理员开放。"
        extra={
          <Link to="/discuss">
            <Button type="primary">返回讨论区</Button>
          </Link>
        }
      />
    );
  }
  return <>{children}</>;
}

/**
 * 系统审计路由守卫：仅 admin。
 */
export function AdminOnlyRoute({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return <PageLoading tip="正在校验管理权限…" />;
  }
  if (!user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  if (user.role !== 'admin') {
    return (
      <Result
        status="403"
        title="无权访问"
        subTitle="审计日志仅对管理员开放。"
        extra={
          <Link to="/admin/problems">
            <Button type="primary">返回管理后台</Button>
          </Link>
        }
      />
    );
  }
  return <>{children}</>;
}
