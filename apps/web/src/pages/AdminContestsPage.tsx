import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type {
  AdminProblemSummary,
  AdminUser,
  Contest,
  CreateContestRequest,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import {
  contestModeLabel,
  contestStatusLabel,
} from '../utils/status';
import {
  defaultContestTimes,
  fromLocalDateTimeInput,
  toLocalDateTimeInput,
} from '../utils/datetime';
import '../styles/admin.css';
import '../styles/contest-admin.css';

interface CreateContestFormValues {
  name: string;
  mode: string;
  startAt: string;
  endAt: string;
  freezeAt?: string;
  problemIds?: number[];
  participantIds?: number[];
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

function userOption(user: AdminUser): string {
  return `${user.realName ?? user.username} (${user.username}${
    user.className ? ` · ${user.className}` : ''
  })`;
}

export function AdminContestsPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateContestFormValues>();

  const contestsQuery = useQuery({
    queryKey: ['contests'],
    queryFn: () => apiGet<Contest[]>('/api/contests'),
    staleTime: 15_000,
  });
  const problemsQuery = useQuery({
    queryKey: ['admin-problems'],
    queryFn: () => apiGet<AdminProblemSummary[]>('/api/admin/problems'),
    staleTime: 30_000,
  });
  const usersQuery = useQuery({
    queryKey: ['admin-users', 'contest-create'],
    queryFn: () => apiGet<AdminUser[]>('/api/admin/users?limit=500'),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateContestFormValues) => {
      const startAt = fromLocalDateTimeInput(values.startAt);
      const endAt = fromLocalDateTimeInput(values.endAt);
      if (startAt === null || endAt === null) {
        throw new Error('请填写有效的开始/结束时间');
      }
      const freezeAt = fromLocalDateTimeInput(values.freezeAt ?? '');
      const payload: CreateContestRequest = {
        name: values.name.trim(),
        mode: values.mode,
        startAt,
        endAt,
        ...(freezeAt !== null ? { freezeAt } : {}),
        problemIds: values.problemIds ?? [],
        participantIds: values.participantIds ?? [],
      };
      return apiPost<{ id: number }>('/api/admin/contests', payload);
    },
    onSuccess: (data) => {
      message.success(`比赛 #${data.id} 已创建`);
      void queryClient.invalidateQueries({ queryKey: ['contests'] });
      setDrawerOpen(false);
      form.resetFields();
      navigate(`/admin/contests/${data.id}`);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '创建比赛失败');
    },
  });

  const openCreate = () => {
    const times = defaultContestTimes();
    form.setFieldsValue({
      name: '',
      mode: 'oi',
      startAt: toLocalDateTimeInput(times.startAt),
      endAt: toLocalDateTimeInput(times.endAt),
      freezeAt: '',
      problemIds: [],
      participantIds: [],
    });
    setDrawerOpen(true);
  };

  const problemOptions = (problemsQuery.data ?? []).map((problem) => ({
    value: problem.id,
    label: `#${problem.id} ${problem.title}`,
  }));
  const userOptions = (usersQuery.data ?? []).map((user) => ({
    value: user.id,
    label: userOption(user),
  }));

  const columns: TableColumnsType<Contest> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 64,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '比赛名称',
      dataIndex: 'name',
      render: (_value, record) => (
        <Link className="contest-link" to={`/admin/contests/${record.id}`}>
          {record.name}
        </Link>
      ),
    },
    {
      title: '赛制',
      dataIndex: 'mode',
      width: 80,
      render: (value: string) => contestModeLabel(value),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 96,
      render: (value: string) => (
        <Tag color={STATUS_COLOR[value] ?? 'default'}>{contestStatusLabel(value)}</Tag>
      ),
    },
    {
      title: '开始时间',
      dataIndex: 'start_at',
      width: 158,
      render: (value: number | null) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '结束时间',
      dataIndex: 'end_at',
      width: 158,
      render: (value: number | null) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '封榜时间',
      dataIndex: 'freeze_at',
      width: 158,
      render: (value: number | null) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '',
      width: 82,
      align: 'center',
      render: (_value, record) => (
        <Link to={`/admin/contests/${record.id}`}>
          <Button size="small">管理</Button>
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理' }, { label: '比赛管理' }]}
        title="比赛管理"
        subtitle="创建比赛、配置题目与参赛者，并在控制台管理状态与班级统计。"
        extra={
          <Space>
            <Button
              onClick={() => void contestsQuery.refetch()}
              loading={contestsQuery.isFetching}
            >
              刷新
            </Button>
            <Button type="primary" onClick={openCreate}>
              新建比赛
            </Button>
          </Space>
        }
      />

      <Card className="oij-card">
        {contestsQuery.isPending ? (
          <PageLoading tip="正在加载比赛…" />
        ) : contestsQuery.isError ? (
          <ErrorResult error={contestsQuery.error} onRetry={() => void contestsQuery.refetch()} />
        ) : (
          <Table<Contest>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={contestsQuery.data ?? []}
            pagination={false}
            locale={{ emptyText: '还没有比赛' }}
          />
        )}
      </Card>

      <Drawer
        title="新建比赛"
        width={580}
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
        <Form<CreateContestFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            label="比赛名称"
            name="name"
            rules={[{ required: true, message: '请输入比赛名称' }]}
          >
            <Input maxLength={120} showCount />
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item label="赛制" name="mode" rules={[{ required: true }]}>
                <Select
                  options={[
                    { value: 'oi', label: 'OI' },
                    { value: 'acm', label: 'ACM' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="开始时间"
                name="startAt"
                rules={[{ required: true, message: '请选择开始时间' }]}
              >
                <Input type="datetime-local" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item
                label="结束时间"
                name="endAt"
                rules={[{ required: true, message: '请选择结束时间' }]}
              >
                <Input type="datetime-local" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="封榜时间（可空）" name="freezeAt">
            <Input type="datetime-local" />
          </Form.Item>
          <Form.Item label="题目" name="problemIds">
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="选择比赛题目"
              options={problemOptions}
              loading={problemsQuery.isPending}
            />
          </Form.Item>
          <Form.Item label="参赛者" name="participantIds">
            <Select
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="按用户选择参赛者"
              options={userOptions}
              loading={usersQuery.isPending}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
