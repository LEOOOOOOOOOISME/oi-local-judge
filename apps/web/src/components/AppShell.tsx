import { Suspense } from 'react';
import { Avatar, Button, Dropdown, type MenuProps } from 'antd';
import { DownOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { useRealtime } from '../hooks/useRealtime';
import { ROLE_LABEL } from '../utils/status';
import { NotificationBell } from './NotificationBell';
import { PageLoading } from './PageStates';

function navClass({ isActive }: { isActive: boolean }): string {
  return `oij-nav-link${isActive ? ' active' : ''}`;
}

export function AppShell() {
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();
  useRealtime(status === 'authenticated');
  const canManage = user?.role === 'admin' || user?.role === 'setter';
  const canManageContests =
    user?.role === 'admin' || user?.role === 'contestmanager';
  const canAudit = user?.role === 'admin';

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const menuItems: MenuProps['items'] = user
    ? [
        {
          key: 'identity',
          disabled: true,
          label: (
            <div className="dropdown-identity">
              <div className="dropdown-identity-name">{user.realName ?? user.username}</div>
              <div className="dropdown-identity-meta">
                @{user.username} · {ROLE_LABEL[user.role] ?? user.role}
              </div>
            </div>
          ),
        },
        { type: 'divider' },
        { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
      ]
    : [];

  const onMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'logout') {
      void handleLogout();
    }
  };

  return (
    <div className="app-shell">
      <header className="oij-header">
        <div className="oij-header-inner">
          <Link to="/contests" className="oij-logo">
            Oi<span>Judge</span>
          </Link>
          <nav className="oij-nav">
            <NavLink to="/contests" className={navClass}>
              比赛
            </NavLink>
            <NavLink to="/problems" className={navClass}>
              题目
            </NavLink>
            <NavLink to="/discuss" className={navClass}>
              讨论
            </NavLink>
            {user ? (
              <>
                <NavLink to="/records" className={navClass}>
                  我的记录
                </NavLink>
                <NavLink to="/messages" className={navClass}>
                  消息
                </NavLink>
              </>
            ) : null}
            {canManage ? (
              <>
                <NavLink to="/admin/problems" className={navClass}>
                  管理
                </NavLink>
                <NavLink to="/admin/batch" className={navClass}>
                  批量评测
                </NavLink>
              </>
            ) : null}
            {canManageContests ? (
              <>
                <NavLink to="/admin/contests" className={navClass}>
                  比赛管理
                </NavLink>
                <NavLink to="/admin/users" className={navClass}>
                  用户管理
                </NavLink>
              </>
            ) : null}
            {canAudit ? (
              <NavLink to="/admin/audit" className={navClass}>
                审计日志
              </NavLink>
            ) : null}
          </nav>
          <div className="oij-header-right">
            {status === 'loading' ? (
              <span className="oij-header-muted">…</span>
            ) : user ? (
              <>
                <NotificationBell />
                <Dropdown menu={{ items: menuItems, onClick: onMenuClick }} trigger={['click']}>
                  <button type="button" className="oij-user-button">
                    <Avatar size={22} icon={<UserOutlined />} />
                    <span className="oij-user-name">{user.realName ?? user.username}</span>
                    <DownOutlined className="oij-user-caret" />
                  </button>
                </Dropdown>
              </>
            ) : (
              <Link to={`/login?next=${encodeURIComponent('/contests')}`}>
                <Button size="small" type="primary" ghost>
                  登录
                </Button>
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="oij-main">
        <Suspense fallback={<PageLoading tip="正在加载页面…" />}>
          <Outlet />
        </Suspense>
      </main>
      <footer className="oij-footer">OiJudge · 本地 OI 评测系统 · Phase 3I</footer>
    </div>
  );
}
