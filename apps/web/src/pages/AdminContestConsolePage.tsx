import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, apiPut } from '../api/client';
import type {
  AdminUser,
  ClassStatRow,
  ContestDetail,
  ContestDetailProblem,
  ContestParticipant,
  UpdateContestRequest,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import {
  contestModeLabel,
  contestStatusLabel,
} from '../utils/status';
import {
  fromLocalDateTimeInput,
  toLocalDateTimeInput,
} from '../utils/datetime';
import '../styles/admin.css';
import '../styles/contest-admin.css';

interface ContestFormValues {
  name: string;
  mode: string;
  startAt: string;
  endAt: string;
  freezeAt?: string;
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

function userLabel(user: AdminUser): string {
  return `${user.realName ?? user.username} (${user.username}${
    user.className ? ` · ${user.className}` : ''
  })`;
}

export function AdminContestConsolePage() {
  const { contestId: contestIdParam } = useParams<{ contestId: string }>();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<ContestFormValues>();
  const [savingBasic, setSavingBasic] = useState(false);
  const [basicError, setBasicError] = useState<string | null>(null);
  const [pointsDraft, setPointsDraft] = useState<Record<number, number>>({});
  const [savingPoints, setSavingPoints] = useState(false);
  const [statusLoading, setStatusLoading] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [removingUserId, setRemovingUserId] = useState<number | null>(null);

  const detailQuery = useQuery({
    queryKey: ['contest-detail', contestId],
    queryFn: () => apiGet<ContestDetail>(`/api/contests/${contestId}`),
    enabled: validId,
    staleTime: 5_000,
  });
  const participantsQuery = useQuery({
    queryKey: ['admin-participants', contestId],
    queryFn: () => apiGet<ContestParticipant[]>(`/api/admin/contests/${contestId}/participants`),
    enabled: validId,
  });
  const classStatsQuery = useQuery({
    queryKey: ['admin-class-stats', contestId],
    queryFn: () => apiGet<ClassStatRow[]>(`/api/admin/contests/${contestId}/class-stats`),
    enabled: validId,
  });
  const usersQuery = useQuery({
    queryKey: ['admin-users', 'contest-console'],
    queryFn: () => apiGet<AdminUser[]>('/api/admin/users?limit=500'),
    staleTime: 30_000,
  });

  const detail = detailQuery.data ?? null;
  const contest = detail?.contest ?? null;
  const problems = detail?.problems ?? [];
  const participants = participantsQuery.data ?? [];

  useEffect(() => {
    if (!contest) return;
    form.setFieldsValue({
      name: contest.name,
      mode: contest.mode,
      startAt: toLocalDateTimeInput(contest.start_at),
      endAt: toLocalDateTimeInput(contest.end_at),
      freezeAt: toLocalDateTimeInput(contest.freeze_at),
    });
  }, [contest, form]);

  useEffect(() => {
    if (!detail) return;
    setPointsDraft(
      Object.fromEntries(detail.problems.map((problem) => [problem.problemId, problem.points])),
    );
  }, [detail]);

  const invalidateContest = () => {
    void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['contests'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-class-stats', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
  };

  const saveBasic = async (values: ContestFormValues) => {
    const startAt = fromLocalDateTimeInput(values.startAt);
    const endAt = fromLocalDateTimeInput(values.endAt);
    if (startAt === null || endAt === null) {
      message.error('请填写有效的开始/结束时间');
      return;
    }
    setSavingBasic(true);
    setBasicError(null);
    try {
      const payload: UpdateContestRequest = {
        name: values.name.trim(),
        mode: values.mode,
        startAt,
        endAt,
        freezeAt: fromLocalDateTimeInput(values.freezeAt ?? ''),
      };
      await apiPut<{ id: number }>(`/api/admin/contests/${contestId}`, payload);
      message.success('比赛基本信息已保存');
      invalidateContest();
    } catch (error) {
      const text = error instanceof Error ? error.message : '保存失败';
      setBasicError(text);
      message.error(text);
    } finally {
      setSavingBasic(false);
    }
  };

  const pointsDirty = problems.some(
    (problem) => (pointsDraft[problem.problemId] ?? problem.points) !== problem.points,
  );

  const savePoints = async () => {
    setSavingPoints(true);
    try {
      await apiPut<{ id: number }>(`/api/admin/contests/${contestId}`, {
        problems: problems.map((problem) => ({
          problemId: problem.problemId,
          points: Number(pointsDraft[problem.problemId] ?? problem.points),
        })),
      });
      message.success('题目分值已保存');
      invalidateContest();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存分值失败');
    } finally {
      setSavingPoints(false);
    }
  };

  const runStatusAction = async (action: 'start' | 'freeze' | 'unfreeze' | 'end') => {
    setStatusLoading(action);
    try {
      await apiPost<null>(`/api/admin/contests/${contestId}/${action}`);
      message.success('比赛状态已更新');
      invalidateContest();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '状态更新失败');
    } finally {
      setStatusLoading(null);
    }
  };

  const currentParticipantIds = new Set(participants.map((row) => row.user_id));
  const candidateOptions = (usersQuery.data ?? [])
    .filter((user) => !currentParticipantIds.has(user.id))
    .map((user) => ({ value: user.id, label: userLabel(user) }));

  const addParticipants = async () => {
    if (selectedUserIds.length === 0) return;
    setAddingParticipants(true);
    try {
      const result = await apiPost<{ added: number[]; missing: string[] }>(
        `/api/admin/contests/${contestId}/participants`,
        { userIds: selectedUserIds },
      );
      if (result.missing.length > 0) {
        message.warning(`未找到用户：${result.missing.join('、')}`);
      } else {
        message.success('参赛者已添加');
      }
      setSelectedUserIds([]);
      void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-class-stats', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '添加参赛者失败');
    } finally {
      setAddingParticipants(false);
    }
  };

  const removeParticipant = async (userId: number) => {
    setRemovingUserId(userId);
    try {
      await apiDelete<null>(`/api/admin/contests/${contestId}/participants/${userId}`);
      message.success('参赛者已移除');
      void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['admin-class-stats', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '移除参赛者失败');
    } finally {
      setRemovingUserId(null);
    }
  };

  const problemColumns: TableColumnsType<ContestDetailProblem> = [
    {
      title: '编号',
      dataIndex: 'ordinal',
      width: 64,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '题目',
      dataIndex: 'title',
      render: (_value, row) => (
        <Link to={`/problem/${row.problemId}`}>{row.title}</Link>
      ),
    },
    {
      title: '分值',
      width: 130,
      render: (_value, row) => (
        <InputNumber
          size="small"
          min={0}
          max={10000}
          precision={0}
          value={pointsDraft[row.problemId] ?? row.points}
          onChange={(value) =>
            setPointsDraft((previous) => ({
              ...previous,
              [row.problemId]: typeof value === 'number' ? value : 0,
            }))
          }
          style={{ width: 96 }}
        />
      ),
    },
  ];

  const participantColumns: TableColumnsType<ContestParticipant> = [
    { title: '用户名', dataIndex: 'username', width: 150 },
    {
      title: '姓名',
      dataIndex: 'real_name',
      width: 140,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '班级',
      dataIndex: 'class_name',
      width: 150,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: '',
      width: 76,
      align: 'center',
      render: (_value, row) => (
        <Popconfirm
          title={`移除参赛者 ${row.username}？`}
          okText="移除"
          cancelText="取消"
          onConfirm={() => void removeParticipant(row.user_id)}
        >
          <Button size="small" danger loading={removingUserId === row.user_id}>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const classColumns: TableColumnsType<ClassStatRow> = [
    { title: '班级', dataIndex: 'className' },
    { title: '人数', dataIndex: 'participants', width: 80, align: 'right' },
    { title: '总分', dataIndex: 'totalScore', width: 90, align: 'right' },
    {
      title: '均分',
      dataIndex: 'averageScore',
      width: 90,
      align: 'right',
      render: (value: number) => value.toFixed(1),
    },
    { title: 'AC 人数', dataIndex: 'acParticipants', width: 96, align: 'right' },
    { title: '最好名次', dataIndex: 'bestRank', width: 90, align: 'right' },
  ];

  if (!validId) {
    return <ErrorResult error={new Error('无效的比赛编号')} />;
  }
  if (detailQuery.isPending) {
    return <PageLoading tip="正在加载比赛…" />;
  }
  if (detailQuery.isError) {
    return (
      <ErrorResult error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
    );
  }
  if (!contest) {
    return <ErrorResult error={new Error('比赛不存在')} />;
  }

  const status = contest.status;
  const statusColor = STATUS_COLOR[status] ?? 'default';

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '管理', to: '/admin/problems' },
          { label: '比赛管理', to: '/admin/contests' },
          { label: contest.name },
        ]}
        title={contest.name}
        tags={
          <>
            <Tag className="mono">#{contest.id}</Tag>
            <Tag color={statusColor}>{contestStatusLabel(status)}</Tag>
            <Tag color="blue">{contestModeLabel(contest.mode)}</Tag>
          </>
        }
        subtitle={`开始 ${formatDateTime(contest.start_at)} · 结束 ${formatDateTime(
          contest.end_at,
        )} · 参赛人数 ${detail?.participantCount ?? participants.length}`}
        extra={
          <Space>
            <Link to={`/contest/${contest.id}`}>
              <Button>公开比赛页</Button>
            </Link>
            <Link to={`/contest/${contest.id}/ranking`}>
              <Button>榜单</Button>
            </Link>
            <Link to="/admin/contests">
              <Button>返回列表</Button>
            </Link>
          </Space>
        }
      />

      <div className="stack">
        <Card
          className="oij-card"
          title="基本信息"
          extra={
            <Button
              type="primary"
              loading={savingBasic}
              onClick={() => form.submit()}
            >
              保存
            </Button>
          }
        >
          <Form<ContestFormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => void saveBasic(values)}
          >
            <Row gutter={12}>
              <Col span={10}>
                <Form.Item
                  label="比赛名称"
                  name="name"
                  rules={[{ required: true, message: '请输入比赛名称' }]}
                >
                  <Input maxLength={120} showCount />
                </Form.Item>
              </Col>
              <Col span={4}>
                <Form.Item label="赛制" name="mode" rules={[{ required: true }]}>
                  <Select
                    options={[
                      { value: 'oi', label: 'OI' },
                      { value: 'acm', label: 'ACM' },
                    ]}
                  />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item
                  label="开始时间"
                  name="startAt"
                  rules={[{ required: true, message: '请选择开始时间' }]}
                >
                  <Input type="datetime-local" />
                </Form.Item>
              </Col>
              <Col span={5}>
                <Form.Item
                  label="结束时间"
                  name="endAt"
                  rules={[{ required: true, message: '请选择结束时间' }]}
                >
                  <Input type="datetime-local" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item label="封榜时间（可空）" name="freezeAt">
                  <Input type="datetime-local" />
                </Form.Item>
              </Col>
            </Row>
          </Form>
          {basicError ? (
            <Alert type="error" showIcon message={basicError} />
          ) : null}
        </Card>

        <Card
          className="oij-card"
          title="题目与分值"
          extra={
            <Button
              type="primary"
              disabled={!pointsDirty}
              loading={savingPoints}
              onClick={() => void savePoints()}
            >
              保存分值
            </Button>
          }
        >
          {problems.length === 0 ? (
            <Empty description="尚未配置比赛题目" />
          ) : (
            <Table<ContestDetailProblem>
              className="oij-table"
              rowKey="problemId"
              size="small"
              columns={problemColumns}
              dataSource={problems}
              pagination={false}
            />
          )}
        </Card>

        <Card className="oij-card" title="状态控制">
          <div className="contest-status-row">
            <span className="muted">当前状态</span>
            <Tag color={statusColor}>{contestStatusLabel(status)}</Tag>
            <Space wrap>
              <Button
                type="primary"
                disabled={status !== 'draft'}
                loading={statusLoading === 'start'}
                onClick={() => void runStatusAction('start')}
              >
                开始
              </Button>
              <Button
                disabled={status !== 'running'}
                loading={statusLoading === 'freeze'}
                onClick={() => void runStatusAction('freeze')}
              >
                封榜
              </Button>
              <Button
                disabled={status !== 'frozen'}
                loading={statusLoading === 'unfreeze'}
                onClick={() => void runStatusAction('unfreeze')}
              >
                解封
              </Button>
              <Button
                danger
                disabled={status === 'ended'}
                loading={statusLoading === 'end'}
                onClick={() => void runStatusAction('end')}
              >
                结束
              </Button>
            </Space>
          </div>
        </Card>

        <Card
          className="oij-card"
          title="参赛者"
          extra={<span className="muted">共 {participants.length} 人</span>}
        >
          <div className="participants-add">
            <Select<number[]>
              mode="multiple"
              showSearch
              optionFilterProp="label"
              placeholder="按用户选择参赛者"
              value={selectedUserIds}
              options={candidateOptions}
              onChange={(value) => setSelectedUserIds(value)}
              loading={usersQuery.isPending}
              style={{ flex: 1, minWidth: 260 }}
            />
            <Button
              type="primary"
              disabled={selectedUserIds.length === 0}
              loading={addingParticipants}
              onClick={() => void addParticipants()}
            >
              添加参赛者
            </Button>
          </div>
          <Table<ContestParticipant>
            className="oij-table"
            rowKey="user_id"
            size="small"
            columns={participantColumns}
            dataSource={participants}
            pagination={false}
            locale={{ emptyText: '还没有参赛者' }}
          />
        </Card>

        <Card
          className="oij-card"
          title="班级统计"
          extra={
            <span className="muted">
              {classStatsQuery.isFetching ? '更新中…' : '按班级汇总比赛成绩'}
            </span>
          }
        >
          {classStatsQuery.isPending ? (
            <PageLoading tip="正在加载班级统计…" />
          ) : classStatsQuery.isError ? (
            <ErrorResult
              error={classStatsQuery.error}
              onRetry={() => void classStatsQuery.refetch()}
            />
          ) : (
            <Table<ClassStatRow>
              className="oij-table"
              rowKey="className"
              size="small"
              columns={classColumns}
              dataSource={classStatsQuery.data ?? []}
              pagination={false}
              locale={{ emptyText: '还没有班级统计数据' }}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
