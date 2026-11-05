import { useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../api/client';
import type { CreateTeamRequest, CreateTeamResult, TeamRole, TeamSummary } from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/teams.css';

interface CreateTeamFormValues {
  name: string;
}

const ROLE_TAG: Record<TeamRole, { color: string; label: string }> = {
  captain: { color: 'gold', label: '队长' },
  member: { color: 'blue', label: '成员' },
};

function describeCreateError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'TEAM_NAME_TAKEN':
        return '团队名已被占用，请换一个';
      case 'TEAM_NAME_INVALID':
        return '团队名需为 2~40 个字符';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '创建团队失败';
}

export function TeamsPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<CreateTeamFormValues>();

  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateTeamFormValues) => {
      const payload: CreateTeamRequest = { name: values.name.trim() };
      return apiPost<CreateTeamResult>('/api/teams', payload);
    },
    onSuccess: (data) => {
      message.success('团队已创建');
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      setCreateOpen(false);
      form.resetFields();
      navigate(`/teams/${data.id}`);
    },
    onError: (error) => {
      message.error(describeCreateError(error));
    },
  });

  const columns: TableColumnsType<TeamSummary> = [
    {
      title: '团队名称',
      dataIndex: 'name',
      render: (value: string, row) => (
        <Link to={`/teams/${row.id}`} className="team-name-link">
          {value}
        </Link>
      ),
    },
    {
      title: '我的身份',
      dataIndex: 'role',
      width: 110,
      render: (value: TeamRole) => (
        <Tag color={ROLE_TAG[value].color}>{ROLE_TAG[value].label}</Tag>
      ),
    },
    {
      title: '成员数',
      dataIndex: 'memberCount',
      width: 90,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      width: 110,
      render: (_value, row) => (
        <Link to={`/teams/${row.id}`}>
          <Button size="small">查看详情</Button>
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '首页', to: '/contests' }, { label: '团队' }]}
        title="团队"
        subtitle="每个账号可加入多个团队；队长可以添加成员、转让队长，所有者或管理员可以解散团队。"
        extra={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={teamsQuery.isFetching}
              onClick={() => void teamsQuery.refetch()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                form.resetFields();
                setCreateOpen(true);
              }}
            >
              创建团队
            </Button>
          </Space>
        }
      />

      <Card className="oij-card">
        {teamsQuery.isPending ? (
          <PageLoading tip="正在加载我的团队…" />
        ) : teamsQuery.isError ? (
          <ErrorResult error={teamsQuery.error} onRetry={() => void teamsQuery.refetch()} />
        ) : (
          <Table<TeamSummary>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={teamsQuery.data ?? []}
            pagination={false}
            locale={{
              emptyText: (
                <div className="team-empty">
                  <div>你还没有加入任何团队。</div>
                  <div className="muted">
                    可以创建自己的团队，或让队长在团队详情页添加你的用户名。
                  </div>
                </div>
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title="创建团队"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        destroyOnHidden
      >
        <Form<CreateTeamFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            label="团队名称"
            name="name"
            rules={[
              { required: true, message: '请输入团队名称' },
              {
                validator: (_rule, value: string | undefined) => {
                  const length = Array.from((value ?? '').trim()).length;
                  if (length < 2 || length > 40) {
                    return Promise.reject(new Error('团队名长度为 2~40 个字符'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="例如：高一(1)班 A 队" maxLength={40} />
          </Form.Item>
          <div className="muted team-create-tip">
            创建后你将成为队长，并自动加入该团队。团队名唯一，长度为 2~40 个字符。
          </div>
        </Form>
      </Modal>
    </div>
  );
}
