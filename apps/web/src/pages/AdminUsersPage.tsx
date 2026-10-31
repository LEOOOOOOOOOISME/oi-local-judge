import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, apiPut } from '../api/client';
import type {
  AdminUser,
  CreateUserRequest,
  CreateUserResult,
  ImportUsersResult,
  Role,
  UpdateUserRequest,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import { ROLE_LABEL } from '../utils/status';
import '../styles/admin.css';
import '../styles/contest-admin.css';

interface CreateUserFormValues {
  username: string;
  password: string;
  realName?: string;
  className?: string;
  role: Role;
}

interface EditUserFormValues {
  realName?: string;
  className?: string;
  role?: Role;
  status?: string;
}

interface PasswordFormValues {
  password: string;
}

const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as Role[]).map((role) => ({
  value: role,
  label: ROLE_LABEL[role],
}));

const STATUS_OPTIONS = [
  { value: 'active', label: '正常' },
  { value: 'disabled', label: '停用' },
];

export function AdminUsersPage() {
  const { message } = App.useApp();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin = currentUser?.role === 'admin';
  const [queryInput, setQueryInput] = useState('');
  const [classInput, setClassInput] = useState('');
  const [query, setQuery] = useState('');
  const [className, setClassName] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateUserFormValues>();
  const [editUser, setEditUser] = useState<AdminUser | null>(null);
  const [editForm] = Form.useForm<EditUserFormValues>();
  const [savingEdit, setSavingEdit] = useState(false);
  const [passwordUser, setPasswordUser] = useState<AdminUser | null>(null);
  const [passwordForm] = Form.useForm<PasswordFormValues>();
  const [resettingPassword, setResettingPassword] = useState(false);
  const [statusLoading, setStatusLoading] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCsv, setImportCsv] = useState('');
  const [defaultPassword, setDefaultPassword] = useState('123456');
  const [importResult, setImportResult] = useState<ImportUsersResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const usersQuery = useQuery({
    queryKey: ['admin-users', { query, class: className }],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '200' });
      if (query) params.set('query', query);
      if (className) params.set('class', className);
      return apiGet<AdminUser[]>(`/api/admin/users?${params.toString()}`);
    },
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateUserFormValues) => {
      const payload: CreateUserRequest = {
        username: values.username.trim(),
        password: values.password,
        realName: values.realName?.trim() || undefined,
        className: values.className?.trim() || undefined,
        role: values.role,
      };
      return apiPost<CreateUserResult>('/api/admin/users', payload);
    },
    onSuccess: (data) => {
      message.success(`用户已创建（#${data.id}）`);
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setDrawerOpen(false);
      form.resetFields();
    },
    onError: (error) => {
      message.error(
        error instanceof ApiError && error.code === 'USER_EXISTS'
          ? '用户名已存在'
          : error instanceof Error
            ? error.message
            : '创建用户失败',
      );
    },
  });

  const openEdit = (row: AdminUser) => {
    setEditUser(row);
    editForm.setFieldsValue({
      realName: row.realName ?? '',
      className: row.className ?? '',
      role: row.role,
      status: row.status,
    });
  };

  const saveEdit = async (values: EditUserFormValues) => {
    if (!editUser) return;
    setSavingEdit(true);
    try {
      const payload: UpdateUserRequest = {
        realName: values.realName?.trim() || null,
        className: values.className?.trim() || null,
        ...(isAdmin
          ? {
              role: values.role,
              status: values.status,
            }
          : {}),
      };
      await apiPut<null>(`/api/admin/users/${editUser.id}`, payload);
      message.success('用户资料已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      setEditUser(null);
    } catch (error) {
      const text =
        error instanceof ApiError && error.code === 'SELF_LOCKOUT'
          ? '不能修改自己的角色或停用自己'
          : error instanceof Error
            ? error.message
            : '保存失败';
      message.error(text);
    } finally {
      setSavingEdit(false);
    }
  };

  const openResetPassword = (row: AdminUser) => {
    setPasswordUser(row);
    passwordForm.resetFields();
  };

  const resetPassword = async (values: PasswordFormValues) => {
    if (!passwordUser) return;
    setResettingPassword(true);
    try {
      await apiPost<null>(`/api/admin/users/${passwordUser.id}/reset-password`, {
        password: values.password,
      });
      message.success(`已重置 ${passwordUser.username} 的密码`);
      setPasswordUser(null);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重置密码失败');
    } finally {
      setResettingPassword(false);
    }
  };

  const toggleStatus = async (row: AdminUser) => {
    setStatusLoading(row.id);
    try {
      await apiPut<null>(`/api/admin/users/${row.id}`, {
        status: row.status === 'disabled' ? 'active' : 'disabled',
      });
      message.success(row.status === 'disabled' ? '用户已启用' : '用户已停用');
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '状态更新失败');
    } finally {
      setStatusLoading(null);
    }
  };

  const openImport = () => {
    setImportCsv('');
    setDefaultPassword('123456');
    setImportResult(null);
    setImportError(null);
    setImportOpen(true);
  };

  const submitImport = async () => {
    if (!importCsv.trim()) {
      message.warning('请粘贴 CSV 内容');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const result = await apiPost<ImportUsersResult>('/api/admin/users/import', {
        csv: importCsv,
        defaultPassword,
      });
      setImportResult(result);
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '导入失败');
    } finally {
      setImporting(false);
    }
  };

  const columns: TableColumnsType<AdminUser> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 64,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    { title: '用户名', dataIndex: 'username', width: 160 },
    {
      title: '姓名',
      dataIndex: 'realName',
      width: 140,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '班级',
      dataIndex: 'className',
      width: 150,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 120,
      render: (value: Role) => ROLE_LABEL[value] ?? value,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) =>
        value === 'disabled' ? (
          <Tag color="red">停用</Tag>
        ) : (
          <Tag color="green">正常</Tag>
        ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      width: 270,
      render: (_value, row) => (
        <Space size={6} wrap>
          <Button size="small" onClick={() => openEdit(row)}>
            编辑
          </Button>
          <Button size="small" onClick={() => openResetPassword(row)}>
            重置密码
          </Button>
          {isAdmin ? (
            <Popconfirm
              title={row.status === 'disabled' ? '启用该用户？' : '停用该用户？'}
              okText={row.status === 'disabled' ? '启用' : '停用'}
              cancelText="取消"
              onConfirm={() => void toggleStatus(row)}
              disabled={row.id === currentUser?.id}
            >
              <Button
                size="small"
                danger={row.status !== 'disabled'}
                disabled={row.id === currentUser?.id}
                loading={statusLoading === row.id}
              >
                {row.status === 'disabled' ? '启用' : '停用'}
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  const applyFilters = () => {
    setQuery(queryInput.trim());
    setClassName(classInput.trim());
  };

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理' }, { label: '用户管理' }]}
        title="用户管理"
        subtitle="维护选手/出题人/比赛管理员账号；班级字段用于比赛班级统计。"
        extra={
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="搜索用户名/姓名"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              onSearch={(value) => {
                setQueryInput(value);
                setQuery(value.trim());
              }}
              style={{ width: 220 }}
            />
            <Input
              allowClear
              placeholder="班级筛选（回车）"
              value={classInput}
              onChange={(event) => {
                setClassInput(event.target.value);
                if (event.target.value === '') setClassName('');
              }}
              onPressEnter={applyFilters}
              style={{ width: 180 }}
            />
            <Button onClick={applyFilters}>查询</Button>
            <Button
              icon={<ReloadOutlined />}
              loading={usersQuery.isFetching}
              onClick={() => void usersQuery.refetch()}
            >
              刷新
            </Button>
            <Button icon={<UploadOutlined />} onClick={openImport}>
              批量导入
            </Button>
            <Button
              type="primary"
              onClick={() => {
                form.resetFields();
                setDrawerOpen(true);
              }}
            >
              新建用户
            </Button>
          </Space>
        }
      />

      <Card className="oij-card">
        {usersQuery.isPending ? (
          <PageLoading tip="正在加载用户…" />
        ) : usersQuery.isError ? (
          <ErrorResult error={usersQuery.error} onRetry={() => void usersQuery.refetch()} />
        ) : (
          <Table<AdminUser>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={usersQuery.data ?? []}
            pagination={false}
            locale={{ emptyText: '没有匹配的用户' }}
          />
        )}
      </Card>

      <Drawer
        title="新建用户"
        width={480}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button
              type="primary"
              loading={createMutation.isPending}
              onClick={() => form.submit()}
            >
              创建
            </Button>
          </Space>
        }
      >
        <Form<CreateUserFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ role: 'contestant' }}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input placeholder="登录用户名" maxLength={64} />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 4, message: '密码至少 4 位' },
            ]}
          >
            <Input.Password placeholder="至少 4 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item label="姓名" name="realName">
            <Input placeholder="真实姓名（用于展示/班级统计）" />
          </Form.Item>
          <Form.Item label="班级" name="className">
            <Input placeholder="例如 高一(1)班" />
          </Form.Item>
          <Form.Item label="角色" name="role" rules={[{ required: true }]}>
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
        </Form>
      </Drawer>

      <Modal
        title={`编辑用户 · ${editUser?.username ?? ''}`}
        open={editUser !== null}
        onCancel={() => setEditUser(null)}
        onOk={() => editForm.submit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingEdit}
        destroyOnHidden
      >
        <Form<EditUserFormValues>
          form={editForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => void saveEdit(values)}
        >
          <Form.Item label="用户名">
            <Input value={editUser?.username ?? ''} disabled />
          </Form.Item>
          <Form.Item label="真实姓名" name="realName">
            <Input placeholder="真实姓名" />
          </Form.Item>
          <Form.Item label="班级" name="className">
            <Input placeholder="例如 高一(1)班" />
          </Form.Item>
          {isAdmin ? (
            <>
              <Form.Item label="角色" name="role">
                <Select
                  options={ROLE_OPTIONS}
                  disabled={editUser?.id === currentUser?.id}
                />
              </Form.Item>
              <Form.Item label="状态" name="status">
                <Select
                  options={STATUS_OPTIONS}
                  disabled={editUser?.id === currentUser?.id}
                />
              </Form.Item>
              {editUser?.id === currentUser?.id ? (
                <Alert
                  type="info"
                  showIcon
                  message="不能修改自己的角色或停用自己。"
                />
              ) : null}
            </>
          ) : (
            <Alert
              type="info"
              showIcon
              message="比赛管理员只能编辑真实姓名与班级。"
            />
          )}
        </Form>
      </Modal>

      <Modal
        title={`重置密码 · ${passwordUser?.username ?? ''}`}
        open={passwordUser !== null}
        onCancel={() => setPasswordUser(null)}
        onOk={() => passwordForm.submit()}
        okText="重置"
        cancelText="取消"
        confirmLoading={resettingPassword}
        destroyOnHidden
      >
        <Form<PasswordFormValues>
          form={passwordForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => void resetPassword(values)}
        >
          <Form.Item
            label="新密码"
            name="password"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 4, message: '密码至少 4 位' },
            ]}
          >
            <Input.Password placeholder="新密码（至少 4 位）" autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="批量导入用户"
        width={720}
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setImportOpen(false)}>关闭</Button>
            <Button type="primary" loading={importing} onClick={() => void submitImport()}>
              导入
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <span className="muted">
            CSV 列：username,password,realName,className,role；首行表头可省略。
            密码为空时使用默认密码；重复用户名会被跳过，错误行会显示行号。
          </span>
          <Input.Password
            addonBefore="默认密码"
            value={defaultPassword}
            onChange={(event) => setDefaultPassword(event.target.value)}
            placeholder="123456"
          />
          <Input.TextArea
            rows={10}
            value={importCsv}
            onChange={(event) => setImportCsv(event.target.value)}
            placeholder={
              'username,password,realName,className,role\nzhangsan,,张三,高一(1)班,contestant\nlisi,pass1234,李四,高一(2)班,contestant'
            }
            spellCheck={false}
          />
          {importError ? <Alert type="error" showIcon message={importError} /> : null}
          {importResult ? (
            <Alert
              type={importResult.errors.length > 0 ? 'warning' : 'success'}
              showIcon
              message={`导入完成：新建 ${importResult.created.length} · 跳过 ${importResult.skipped.length} · 错误 ${importResult.errors.length}`}
              description={
                <div className="user-import-summary">
                  {importResult.created.length > 0 ? (
                    <div>
                      新建：
                      {importResult.created.map((name) => (
                        <Tag key={name} color="green">
                          {name}
                        </Tag>
                      ))}
                    </div>
                  ) : null}
                  {importResult.skipped.length > 0 ? (
                    <div>
                      跳过（已存在）：
                      {importResult.skipped.map((name) => (
                        <Tag key={name} color="gold">
                          {name}
                        </Tag>
                      ))}
                    </div>
                  ) : null}
                  {importResult.errors.length > 0 ? (
                    <div>
                      错误：
                      {importResult.errors.map((error) => (
                        <div key={`${error.line}-${error.message}`} className="muted">
                          第 {error.line} 行：{error.message}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              }
            />
          ) : null}
        </Space>
      </Modal>
    </div>
  );
}
