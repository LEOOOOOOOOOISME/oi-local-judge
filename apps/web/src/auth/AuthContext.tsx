import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, onUnauthorized } from '../api/client';
import type { LoginResult, MeResult, User } from '../api/types';

type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  user: User | null;
  status: AuthStatus;
  login: (username: string, password: string) => Promise<{ mustChangePassword: boolean }>;
  register: (username: string, password: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;

  const redirectToLogin = useCallback(() => {
    const current = locationRef.current;
    if (current.pathname === '/login') return;
    const next = `${current.pathname}${current.search}`;
    navigate(`/login?next=${encodeURIComponent(next)}`, { replace: true });
  }, [navigate]);

  // 首屏探测登录态：401 属于正常匿名状态，不触发全局跳转。
  useEffect(() => {
    let cancelled = false;
    apiGet<MeResult>('/api/me', { skipAuthRedirect: true })
      .then((data) => {
        if (cancelled) return;
        setUser({ ...data.user, mustChangePassword: data.mustChangePassword });
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setStatus('anonymous');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 任意 API 返回 401：清空缓存、回到匿名态并跳转登录页。
  useEffect(
    () =>
      onUnauthorized(() => {
        setUser(null);
        setStatus('anonymous');
        queryClient.clear();
        redirectToLogin();
      }),
    [queryClient, redirectToLogin],
  );

  // 强制改密：除改密页外，任何已登录路由都先跳转到改密页。
  useEffect(() => {
    if (status !== 'authenticated' || !user?.mustChangePassword) return;
    if (locationRef.current.pathname !== '/change-password') {
      navigate('/change-password', { replace: true });
    }
  }, [status, user, navigate]);

  const login = useCallback(async (username: string, password: string) => {
    const data = await apiPost<LoginResult>(
      '/api/auth/login',
      { username, password },
      { skipAuthRedirect: true },
    );
    const mustChangePassword = data.mustChangePassword === true;
    setUser({ ...data.user, mustChangePassword });
    setStatus('authenticated');
    return { mustChangePassword };
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const data = await apiPost<LoginResult>(
      '/api/auth/register',
      { username, password },
      { skipAuthRedirect: true },
    );
    setUser({ ...data.user, mustChangePassword: false });
    setStatus('authenticated');
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const data = await apiPost<LoginResult>(
      '/api/auth/change-password',
      { currentPassword, newPassword },
      { skipAuthRedirect: true },
    );
    setUser({ ...data.user, mustChangePassword: false });
    setStatus('authenticated');
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiPost<{ loggedOut: boolean }>('/api/auth/logout');
    } catch {
      // 会话可能已过期；本地仍然按登出处理。
    }
    setUser(null);
    setStatus('anonymous');
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, status, login, register, changePassword, logout }),
    [user, status, login, register, changePassword, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return value;
}
