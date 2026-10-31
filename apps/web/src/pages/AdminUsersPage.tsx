import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../api/client';
import type {
  AdminUser,
  CreateUserRequest,
  CreateUserResult,
  Role,
} from '../api/types';
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

const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as Role[]).map((role) => ({
  value: role,
  label: ROLE_LABEL[role],
}));

export function AdminUsersPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [queryInput, setQueryInput] = useState('');
  const [classInput, setClassInput] = useState('');
  const [query, setQuery] = useState('');
  const [className, setClassName] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateUserFormValues>();

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
        value === 'active' ? <Tag color="green">正常</Tag> : <Tag>{value}</Tag>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
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
    </div>
  );
}
