import { useState } from 'react';
import { App, Button, Card, Form, Input } from 'antd';
import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface RegisterValues {
  username: string;
  password: string;
  confirm: string;
}

function registerError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'USERNAME_TAKEN':
        return '该用户名已被使用，请换一个';
      case 'INVALID_USERNAME':
        return '用户名需为 3–32 位字母、数字、下划线、点或连字符';
      case 'INVALID_PASSWORD':
        return '密码长度需为 8–72 位';
      case 'TOO_MANY_REGISTRATIONS':
        return '注册过于频繁，请稍后再试';
      default:
        return err.message;
    }
  }
  return err instanceof Error ? err.message : '注册失败，请稍后重试';
}

export function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status === 'authenticated') {
    return <Navigate to="/contests" replace />;
  }

  const handleFinish = async (values: RegisterValues) => {
    setSubmitting(true);
    setError(null);
    try {
      await register(values.username.trim(), values.password);
      message.success('注册成功');
      navigate('/contests', { replace: true });
    } catch (err) {
      setError(registerError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-brand">
        Oi<span>Judge</span>
      </div>
      <div className="login-subtitle">注册参赛账号</div>
      <Card className="login-card">
        <Form<RegisterValues>
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            void handleFinish(values);
          }}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[
              { required: true, message: '请输入用户名' },
              {
                pattern: /^[A-Za-z0-9_.-]{3,32}$/,
                message: '3–32 位字母、数字、下划线、点或连字符',
              },
            ]}
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
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, max: 72, message: '密码长度需为 8–72 位' },
            ]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="至少 8 位"
              autoComplete="new-password"
            />
          </Form.Item>
          <Form.Item
            label="确认密码"
            name="confirm"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password
              prefix={<LockOutlined />}
              placeholder="再次输入密码"
              autoComplete="new-password"
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
            注册并登录
          </Button>
        </Form>
      </Card>
      <div className="login-footer">
        <Link to="/login">已有账号？登录</Link>
        <span>·</span>
        <Link to="/contests">先浏览比赛</Link>
      </div>
    </div>
  );
}
