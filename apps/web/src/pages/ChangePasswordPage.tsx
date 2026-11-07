import { useState } from 'react';
import { Alert, App, Button, Card, Form, Input } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

interface ChangePasswordValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * Self-service password change. It is both the forced first-login step for a
 * randomly generated bootstrap password and a normal account-settings page.
 */
export function ChangePasswordPage() {
  const { user, changePassword } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forced = user?.mustChangePassword === true;

  const handleFinish = async (values: ChangePasswordValues) => {
    if (values.newPassword !== values.confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await changePassword(values.currentPassword, values.newPassword);
      message.success('密码已修改');
      navigate('/contests', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : '修改密码失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="stack" style={{ maxWidth: 520, margin: '48px auto' }}>
      <Card
        className="oij-card"
        title={forced ? '首次登录：修改管理员密码' : '修改密码'}
      >
        {forced ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="当前使用的是初始密码"
            description="为了账号安全，请先设置一个新密码，修改后才能继续使用其他功能。"
          />
        ) : null}
        <Form<ChangePasswordValues>
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => {
            void handleFinish(values);
          }}
        >
          <Form.Item
            label="当前密码"
            name="currentPassword"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="current-password" autoFocus />
          </Form.Item>
          <Form.Item
            label="新密码"
            name="newPassword"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 8, max: 72, message: '密码长度需为 8-72 个字符' },
            ]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            label="确认新密码"
            name="confirmPassword"
            rules={[{ required: true, message: '请再次输入新密码' }]}
          >
            <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
          </Form.Item>
          {error ? <div className="login-error">{error}</div> : null}
          <Button type="primary" htmlType="submit" block loading={submitting}>
            保存新密码
          </Button>
        </Form>
      </Card>
    </div>
  );
}
