import { useState } from 'react';
import { App, Button, Card, Form, Input, Spin } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

interface LoginValues {
  username: string;
  password: string;
}

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rawNext = searchParams.get('next');
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/contests';

  if (status === 'authenticated') {
    return <Navigate to={next} replace />;
  }

  const handleFinish = async (values: LoginValues) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await login(values.username.trim(), values.password);
      message.success('登录成功');
      navigate(result.mustChangePassword ? '/change-password' : next, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-brand">
        Oi<span>Judge</span>
      </div>
      <div className="login-subtitle">本地 OI 评测系统</div>
      <Card className="login-card">
        {status === 'loading' ? (
          <div className="login-loading">
            <Spin />
          </div>
        ) : (
          <>
            <Form<LoginValues>
              layout="vertical"
              requiredMark={false}
              onFinish={(values) => {
                void handleFinish(values);
              }}
            >
              <Form.Item
                label="用户名"
                name="username"
                rules={[{ required: true, message: '请输入用户名' }]}
              >
                <Input
                  prefix={<UserOutlined />}
                  placeholder="用户名"
                  autoComplete="username"
                  autoFocus
                />
              </Form.Item>
              <Form.Item
                label="密码"
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  placeholder="密码"
                  autoComplete="current-password"
                />
              </Form.Item>
              {error ? <div className="login-error">{error}</div> : null}
              <Button
                type="primary"
                htmlType="submit"
                block
                loading={submitting}
                className="login-submit"
              >
                登录
              </Button>
            </Form>
            <div className="login-hint">
              首次安装的管理员密码由安装程序/启动日志提供，首次登录后必须修改。
            </div>
          </>
        )}
      </Card>
      <div className="login-footer">
        <Link to="/register">注册账号</Link>
        <span>·</span>
        <Link to="/contests">先浏览比赛</Link>
        <span>·</span>
        <span>数据保存在本机</span>
      </div>
    </div>
  );
}
