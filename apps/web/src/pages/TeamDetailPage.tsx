import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPost } from '../api/client';
import type { TeamDetail, TeamMember, TeamRole } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { TeamProblemSetsPanel } from '../components/TeamProblemSetsPanel';
import { TeamProblemsPanel } from '../components/TeamProblemsPanel';
import { formatDateTime } from '../utils/format';
import '../styles/teams.css';

interface AddMemberFormValues {
  username: string;
}

function RoleTag({ role }: { role: TeamRole }) {
  return role === 'captain' ? <Tag color="gold">队长</Tag> : <Tag color="blue">成员</Tag>;
}

function describeTeamError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'TEAM_NOT_FOUND':
        return '团队不存在或已被解散';
      case 'TEAM_FORBIDDEN':
        return '没有权限执行该操作';
      case 'TEAM_MEMBER_EXISTS':
        return '该用户已经是团队成员';
      case 'TEAM_MEMBER_NOT_FOUND':
        return '该用户不在团队中';
      case 'TEAM_CAPTAIN_LAST':
        return '团队必须保留至少一名队长，请先转让队长';
      case 'TEAM_TRANSFER_SELF':
        return '你已经是队长';
      case 'TEAM_ALREADY_CAPTAIN':
        return '对方已经是队长';
      case 'USER_NOT_FOUND':
        return '用户名不存在';
      case 'USER_INACTIVE':
        return '该用户已被停用，无法加入团队';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

export function TeamDetailPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const teamId = Number(params.id);
  const validTeamId = Number.isInteger(teamId) && teamId > 0;
  const [addOpen, setAddOpen] = useState(false);
  const [addForm] = Form.useForm<AddMemberFormValues>();

  const detailQuery = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => apiGet<TeamDetail>(`/api/teams/${teamId}`),
    enabled: validTeamId,
  });

  const invalidateTeam = () => {
    void queryClient.invalidateQueries({ queryKey: ['team', teamId] });
    void queryClient.invalidateQueries({ queryKey: ['teams'] });
  };

  const addMemberMutation = useMutation({
    mutationFn: (values: AddMemberFormValues) =>
      apiPost<null>(`/api/teams/${teamId}/members`, { username: values.username.trim() }),
    onSuccess: () => {
      message.success('成员已添加');
      setAddOpen(false);
      addForm.resetFields();
      invalidateTeam();
    },
    onError: (error) => {
      message.error(describeTeamError(error, '添加成员失败'));
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: number) => apiDelete<null>(`/api/teams/${teamId}/members/${userId}`),
    onSuccess: () => {
      message.success('成员已移出团队');
      invalidateTeam();
    },
    onError: (error) => {
      message.error(describeTeamError(error, '移出成员失败'));
    },
  });

  const transferMutation = useMutation({
    mutationFn: (userId: number) =>
      apiPost<null>(`/api/teams/${teamId}/transfer`, { userId }),
    onSuccess: () => {
      message.success('已转让队长');
      invalidateTeam();
    },
    onError: (error) => {
      message.error(describeTeamError(error, '转让队长失败'));
    },
  });

  const leaveMutation = useMutation({
    mutationFn: () => apiPost<null>(`/api/teams/${teamId}/leave`),
    onSuccess: () => {
      message.success('已退出团队');
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      navigate('/teams');
    },
    onError: (error) => {
      message.error(describeTeamError(error, '退出团队失败'));
    },
  });

  const dissolveMutation = useMutation({
    mutationFn: () => apiDelete<null>(`/api/teams/${teamId}`),
    onSuccess: () => {
      message.success('团队已解散');
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      navigate('/teams');
    },
    onError: (error) => {
      message.error(describeTeamError(error, '解散团队失败'));
    },
  });

  const retry = () => void detailQuery.refetch();

  if (!validTeamId) {
    return (
      <Result
        status="404"
        title="未找到团队"
        subTitle="团队编号无效。"
        extra={
          <Link to="/teams">
            <Button type="primary">返回团队列表</Button>
          </Link>
        }
      />
    );
  }

  if (detailQuery.isPending) {
    return <PageLoading tip="正在加载团队…" />;
  }

  if (detailQuery.isError) {
    return <ErrorResult error={detailQuery.error} onRetry={retry} />;
  }

  const detail = detailQuery.data;
  if (!detail) {
    return <ErrorResult error={new Error('团队数据为空')} onRetry={retry} />;
  }

  const isAdmin = user?.role === 'admin';
  const viewerRole = detail.viewerRole;
  const canManageMembers = isAdmin || viewerRole === 'captain';
  const canLeave = viewerRole === 'member';
  const canDissolve = isAdmin || detail.ownerId === user?.id;
  const captain = detail.members?.find((member) => member.role === 'captain');
  const captainLabel = captain?.username ?? `用户 #${detail.ownerId}`;

  const memberColumns: TableColumnsType<TeamMember> = [
    {
      title: '用户名',
      dataIndex: 'username',
      render: (value: string, row) => (
        <span className="team-member-name">
          {value}
          {row.userId === user?.id ? <Tag className="team-self-tag">我</Tag> : null}
        </span>
      ),
    },
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
      title: '身份',
      dataIndex: 'role',
      width: 100,
      render: (value: TeamRole) => <RoleTag role={value} />,
    },
    {
      title: '加入时间',
      dataIndex: 'joinedAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
  ];

  if (canManageMembers) {
    memberColumns.push({
      title: '操作',
      width: 190,
      render: (_value, row) => {
        const isSelf = row.userId === user?.id;
        const isPlainMember = row.role === 'member';
        const canTransfer = isPlainMember && !isSelf;
        const canRemove = isPlainMember && !isSelf;
        if (!canTransfer && !canRemove) {
          return <span className="muted">—</span>;
        }
        return (
          <Space size={6} wrap>
            {canTransfer ? (
              <Popconfirm
                title={`将队长转让给 ${row.username}？`}
                description="转让后原队长将变为普通成员。"
                okText="转让"
                cancelText="取消"
                onConfirm={() => transferMutation.mutate(row.userId)}
              >
                <Button
                  size="small"
                  loading={
                    transferMutation.isPending && transferMutation.variables === row.userId
                  }
                >
                  转让队长
                </Button>
              </Popconfirm>
            ) : null}
            {canRemove ? (
              <Popconfirm
                title={`将 ${row.username} 移出团队？`}
                okText="移出"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => removeMemberMutation.mutate(row.userId)}
              >
                <Button
                  size="small"
                  danger
                  loading={
                    removeMemberMutation.isPending &&
                    removeMemberMutation.variables === row.userId
                  }
                >
                  移出
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        );
      },
    });
  }

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '首页', to: '/contests' },
          { label: '团队', to: '/teams' },
          { label: detail.name },
        ]}
        title={detail.name}
        tags={
          <>
            {viewerRole ? <RoleTag role={viewerRole} /> : <Tag>非成员</Tag>}
            {isAdmin ? <Tag color="red">管理员</Tag> : null}
          </>
        }
        subtitle="团队详情：队长可以添加成员、移出成员与转让队长；所有者或管理员可以解散团队。"
        extra={
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={detailQuery.isFetching} onClick={retry}>
              刷新
            </Button>
            {canManageMembers ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => {
                  addForm.resetFields();
                  setAddOpen(true);
                }}
              >
                添加成员
              </Button>
            ) : null}
            {canLeave ? (
              <Popconfirm
                title="退出团队？"
                description="退出后需要队长重新邀请才能加入。"
                okText="退出"
                cancelText="取消"
                onConfirm={() => leaveMutation.mutate()}
              >
                <Button loading={leaveMutation.isPending}>退出团队</Button>
              </Popconfirm>
            ) : null}
            {canDissolve ? (
              <Popconfirm
                title="解散团队？"
                description="解散后成员关系将被删除，且无法恢复。"
                okText="解散"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => dissolveMutation.mutate()}
              >
                <Button danger loading={dissolveMutation.isPending}>
                  解散团队
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        }
      />

      <Tabs
        className="team-tabs"
        items={[
          {
            key: 'overview',
            label: '概览',
            children: (
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <Card className="oij-card" title="基本信息">
                  <Descriptions
                    className="team-detail-descriptions"
                    size="small"
                    column={{ xs: 1, sm: 2, lg: 3 }}
                    items={[
                      {
                        key: 'id',
                        label: '团队编号',
                        children: <span className="mono">#{detail.id}</span>,
                      },
                      { key: 'captain', label: '队长', children: captainLabel },
                      {
                        key: 'createdAt',
                        label: '创建时间',
                        children: <span className="mono">{formatDateTime(detail.createdAt)}</span>,
                      },
                      {
                        key: 'memberCount',
                        label: '成员数',
                        children: detail.members ? (
                          <span className="mono">{detail.members.length}</span>
                        ) : (
                          <span className="muted">仅成员可见</span>
                        ),
                      },
                      {
                        key: 'viewerRole',
                        label: '我的身份',
                        children: viewerRole ? (
                          <RoleTag role={viewerRole} />
                        ) : (
                          <span className="muted">非成员</span>
                        ),
                      },
                    ]}
                  />
                </Card>

                <Card
                  className="oij-card"
                  title={detail.members ? `成员（${detail.members.length}）` : '成员'}
                >
                  {detail.members ? (
                    <Table<TeamMember>
                      className="oij-table"
                      rowKey="userId"
                      size="small"
                      columns={memberColumns}
                      dataSource={detail.members}
                      pagination={false}
                      locale={{ emptyText: '团队还没有成员' }}
                    />
                  ) : (
                    <Alert
                      type="info"
                      showIcon
                      message="成员列表仅对团队成员与管理员可见。"
                      description="你是该团队的访客，可以查看团队基础信息；如需加入，请联系队长添加你的用户名。"
                    />
                  )}
                </Card>
              </Space>
            ),
          },
          {
            key: 'problems',
            label: '题目',
            children: <TeamProblemsPanel teamId={teamId} />,
          },
          {
            key: 'problem-sets',
            label: '题单',
            children: (
              <TeamProblemSetsPanel
                teamId={teamId}
                teamName={detail.name}
                canCreate={viewerRole === 'captain'}
                currentUserId={user?.id}
              />
            ),
          },
        ]}
      />

      <Modal
        title="添加成员"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => addForm.submit()}
        okText="添加"
        cancelText="取消"
        confirmLoading={addMemberMutation.isPending}
        destroyOnHidden
      >
        <Form<AddMemberFormValues>
          form={addForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => addMemberMutation.mutate(values)}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: '请输入要添加的用户名' }]}
          >
            <Input placeholder="输入已注册用户的用户名" maxLength={64} />
          </Form.Item>
          <div className="muted team-create-tip">
            用户必须已注册且状态正常；同一用户不能重复加入同一团队。
          </div>
        </Form>
      </Modal>
    </div>
  );
}
