import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Result,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet } from '../api/client';
import type {
  StudentStats,
  StudentTagStat,
  StudentWrongProblem,
  StudentWrongProblems,
  WrongProblemMode,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { VerdictBadge } from '../components/VerdictBadge';
import { formatDateTime } from '../utils/format';
import {
  formatPercent,
  parseClassId,
  sortTagsByMastery,
  studentStatsPath,
  studentWrongProblemsPath,
  tagMasteryRate,
} from '../utils/learning';
import { difficultyLabel } from '../utils/status';
import '../styles/learning.css';

type SubmitScope = 'all' | 'practice';

const SCOPE_OPTIONS = [
  { label: '全部（练习 + 比赛）', value: 'all' },
  { label: '仅练习', value: 'practice' },
] as const;

const MODE_OPTIONS = [
  { label: '从未 AC', value: 'never-ac' },
  { label: '最近一次未 AC', value: 'latest-wrong' },
] as const;

function tagColumnRender(tags: string[]): ReactNode {
  if (tags.length === 0) return <span className="muted">—</span>;
  const visible = tags.slice(0, 3);
  const rest = tags.length - visible.length;
  return (
    <span className="learning-tag-list">
      {visible.map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
      {rest > 0 ? <Tag>+{rest}</Tag> : null}
    </span>
  );
}

export function StudentLearningPage() {
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const [scope, setScope] = useState<SubmitScope>('all');
  const [mode, setMode] = useState<WrongProblemMode>('never-ac');

  const userId = Number(params.id);
  const validUserId = Number.isInteger(userId) && userId > 0;
  const classId = parseClassId(searchParams.get('classId'));
  const includeContest = scope === 'all';

  const statsQuery = useQuery({
    queryKey: ['student-learning-stats', userId, classId ?? null, includeContest],
    queryFn: () => apiGet<StudentStats>(studentStatsPath(userId, { classId, includeContest })),
    enabled: validUserId,
  });

  const wrongQuery = useQuery({
    queryKey: ['student-wrong-problems', userId, classId ?? null, includeContest, mode],
    queryFn: () =>
      apiGet<StudentWrongProblems>(
        studentWrongProblemsPath(userId, { classId, includeContest, mode }),
      ),
    enabled: validUserId,
  });

  const stats = statsQuery.data;
  const tagRows = useMemo(() => sortTagsByMastery(stats?.tags ?? []), [stats?.tags]);

  const retry = () => {
    void statsQuery.refetch();
    void wrongQuery.refetch();
  };

  if (!validUserId) {
    return (
      <Result
        status="404"
        title="未找到学生"
        subTitle="学生编号无效。"
        extra={
          <Link to="/classes">
            <Button type="primary">返回班级列表</Button>
          </Link>
        }
      />
    );
  }

  if (statsQuery.isPending) {
    return <PageLoading tip="正在加载学习统计…" />;
  }

  if (statsQuery.isError) {
    const apiError = statsQuery.error instanceof ApiError ? statsQuery.error : null;
    if (apiError?.status === 403) {
      return (
        <Result
          status="403"
          title="无权查看学习统计"
          subTitle="只有学生本人、班级教练或管理员可以查看学习统计。"
          extra={
            classId ? (
              <Link to={`/classes/${classId}`}>
                <Button type="primary">返回班级</Button>
              </Link>
            ) : (
              <Link to="/contests">
                <Button type="primary">返回首页</Button>
              </Link>
            )
          }
        />
      );
    }
    return <ErrorResult error={statsQuery.error} onRetry={retry} />;
  }

  if (!stats) {
    return <ErrorResult error={new Error('学习统计数据为空')} onRetry={retry} />;
  }

  const isSelf = user?.id === userId;
  const totalSubmissions = stats.summary.totalSubmissions;
  const acRate = totalSubmissions === 0 ? 0 : stats.summary.acSubmissions / totalSubmissions;

  const wrongColumns: TableColumnsType<StudentWrongProblem> = [
    {
      title: '题目',
      dataIndex: 'title',
      render: (value: string, row) => (
        <span>
          <Link to={`/problem/${row.problemId}`} className="learning-problem-link">
            {value}
          </Link>
          <span className="muted mono learning-problem-id">#{row.problemId}</span>
        </span>
      ),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 80,
      render: (value: number | null) => (
        <span className={`difficulty difficulty-${value ?? 0}`}>{difficultyLabel(value)}</span>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 220,
      render: (tags: string[]) => tagColumnRender(tags),
    },
    {
      title: '尝试',
      dataIndex: 'attempts',
      width: 120,
      render: (value: number, row) => (
        <span className="mono">
          {value}
          <span className="muted">（错 {row.wrongAttempts}）</span>
        </span>
      ),
    },
    {
      title: '最佳得分',
      dataIndex: 'bestScore',
      width: 90,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '最近评测',
      dataIndex: 'lastVerdict',
      width: 100,
      render: (value: StudentWrongProblem['lastVerdict']) => <VerdictBadge verdict={value} />,
    },
    {
      title: '最近提交',
      dataIndex: 'lastSubmitAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
  ];

  const tagColumns: TableColumnsType<StudentTagStat> = [
    {
      title: '标签',
      dataIndex: 'tag',
      width: 180,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    {
      title: '掌握度',
      width: 240,
      render: (_value, row) => {
        const rate = tagMasteryRate(row);
        return (
          <Progress
            percent={Math.round(rate * 100)}
            size="small"
            status={rate >= 1 ? 'success' : 'normal'}
            strokeColor={rate < 0.5 ? '#ff4d4f' : rate < 1 ? '#faad14' : '#52c41a'}
          />
        );
      },
    },
    {
      title: '已掌握',
      width: 110,
      render: (_value, row) => (
        <span className="mono">
          {row.solved} / {row.totalProblems}
        </span>
      ),
    },
    {
      title: '尝试次数',
      dataIndex: 'attempts',
      width: 100,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '最近提交',
      dataIndex: 'lastAttemptAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
  ];

  const wrongRows = wrongQuery.data?.problems ?? [];

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '首页', to: '/contests' },
          ...(classId
            ? [
                { label: '班级', to: '/classes' },
                { label: `班级 #${classId}`, to: `/classes/${classId}` },
              ]
            : []),
          { label: '学习统计' },
        ]}
        title={`${stats.username} 的学习统计`}
        tags={
          <>
            {isSelf ? <Tag color="blue">我</Tag> : null}
            {classId ? <Tag>班级 #{classId}</Tag> : null}
            {includeContest ? <Tag color="cyan">含比赛提交</Tag> : <Tag>仅练习</Tag>}
          </>
        }
        subtitle="统计仅包含已完成且未被 Hack 的提交，隐藏题目不会出现在明细中。学生本人、班级教练与管理员可以查看。"
        extra={
          <Space wrap>
            <Space size={6}>
              <span className="muted learning-filter-label">提交范围</span>
              <Segmented
                options={[...SCOPE_OPTIONS]}
                value={scope}
                onChange={(value) => setScope(value as SubmitScope)}
              />
            </Space>
            <Button
              icon={<ReloadOutlined />}
              loading={statsQuery.isFetching || wrongQuery.isFetching}
              onClick={retry}
            >
              刷新
            </Button>
          </Space>
        }
      />

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card className="oij-card" title="学习概览">
          <Row gutter={[16, 16]}>
            <Col xs={12} md={6}>
              <Statistic title="提交次数" value={stats.summary.totalSubmissions} />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="AC 提交"
                value={stats.summary.acSubmissions}
                suffix={<span className="learning-stat-suffix">AC 率 {formatPercent(acRate)}</span>}
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic
                title="完成题数"
                value={stats.summary.solvedProblems}
                suffix={
                  <span className="learning-stat-suffix">/ {stats.summary.attemptedProblems} 题</span>
                }
              />
            </Col>
            <Col xs={12} md={6}>
              <Statistic title="标签数" value={stats.tags.length} />
            </Col>
          </Row>
          <div className="learning-meta">
            <span>最近活跃：{formatDateTime(stats.summary.lastActiveAt)}</span>
            <span>首次 AC：{formatDateTime(stats.summary.firstAcAt)}</span>
          </div>
        </Card>

        <Card
          className="oij-card"
          title="错题列表"
          extra={
            <Space wrap>
              <Segmented
                options={[...MODE_OPTIONS]}
                value={mode}
                onChange={(value) => setMode(value as WrongProblemMode)}
              />
              <Tag>{wrongRows.length} 题</Tag>
            </Space>
          }
        >
          <div className="learning-note">
            {mode === 'never-ac'
              ? '从未 AC：练习过但还没有任何一次 AC 的题目。'
              : '最近一次未 AC：最新一次提交不是 AC 的题目，包含 AC 之后又提交错误的回归题。'}
          </div>
          {wrongQuery.isPending ? (
            <PageLoading tip="正在加载错题…" />
          ) : wrongQuery.isError ? (
            <Alert
              type="error"
              showIcon
              message="错题列表加载失败"
              description="请确认后端服务正常后重试。"
              action={
                <Button size="small" onClick={() => void wrongQuery.refetch()}>
                  重试
                </Button>
              }
            />
          ) : (
            <Table<StudentWrongProblem>
              className="oij-table"
              rowKey="problemId"
              size="small"
              columns={wrongColumns}
              dataSource={wrongRows}
              scroll={{ x: 900 }}
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
              locale={{
                emptyText: (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description={
                      mode === 'never-ac' ? '没有从未 AC 的题目' : '最近一次提交均为 AC'
                    }
                  />
                ),
              }}
            />
          )}
        </Card>

        <Card
          className="oij-card"
          title="标签掌握度"
          extra={<span className="muted">按掌握度升序，最薄弱的标签在前</span>}
        >
          <Table<StudentTagStat>
            className="oij-table"
            rowKey="tag"
            size="small"
            columns={tagColumns}
            dataSource={tagRows}
            scroll={{ x: 800 }}
            pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="还没有可用于统计标签的提交"
                />
              ),
            }}
          />
        </Card>
      </Space>
    </div>
  );
}
