import { useState } from 'react';
import {
  Button,
  Card,
  Col,
  Empty,
  Progress,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type {
  ClassInactiveMember,
  ClassLearningStats,
  ClassWeakTag,
  ClassWrongProblem,
} from '../api/types';
import { ErrorResult, PageLoading } from './PageStates';
import { StatisticsChart } from './StatisticsChart';
import {
  INACTIVE_DAYS,
  describeInactive,
  formatPercent,
  studentLearningPath,
  trainingPlansPath,
} from '../utils/learning';
import '../styles/learning.css';

const weakTagColumns: TableColumnsType<ClassWeakTag> = [
  {
    title: '标签',
    dataIndex: 'tag',
    width: 140,
    render: (value: string) => <Tag>{value}</Tag>,
  },
  {
    title: '掌握率',
    dataIndex: 'solveRate',
    width: 200,
    render: (value: number) => (
      <Progress
        percent={Math.round(value * 100)}
        size="small"
        status={value >= 1 ? 'success' : 'normal'}
        strokeColor={value < 0.5 ? '#ff4d4f' : value < 1 ? '#faad14' : '#52c41a'}
      />
    ),
  },
  {
    title: '已解决 / 尝试',
    width: 120,
    render: (_value, row) => (
      <span className="mono">
        {row.solved} / {row.attempts}
      </span>
    ),
  },
  {
    title: '掌握率数值',
    dataIndex: 'solveRate',
    width: 100,
    align: 'right',
    render: (value: number) => <span className="mono">{formatPercent(value)}</span>,
  },
];

function buildInactiveColumns(classId: number): TableColumnsType<ClassInactiveMember> {
  return [
    {
      title: '成员',
      dataIndex: 'username',
      render: (value: string) => <span className="class-member-name">{value}</span>,
    },
    {
      title: '最近活跃',
      dataIndex: 'lastActiveAt',
      width: 140,
      render: (value: number | null) => (
        <span className={value === null ? 'muted' : undefined}>{describeInactive(value)}</span>
      ),
    },
    {
      title: '操作',
      width: 90,
      render: (_value, row) => (
        <Link to={studentLearningPath(row.userId, classId)}>
          <Button size="small" type="link">
            学习
          </Button>
        </Link>
      ),
    },
  ];
}

function WrongProblemTable({ rows }: { rows: ClassWrongProblem[] }) {
  const columns: TableColumnsType<ClassWrongProblem> = [
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
      title: '涉及学生',
      dataIndex: 'studentCount',
      width: 110,
      render: (value: number) => (
        <span>
          <span className="mono">{value}</span>
          <span className="muted"> 人</span>
        </span>
      ),
    },
    {
      title: '尝试次数',
      dataIndex: 'attempts',
      width: 110,
      render: (value: number) => <span className="mono">{value}</span>,
    },
  ];

  return (
    <Table<ClassWrongProblem>
      className="oij-table"
      rowKey="problemId"
      size="small"
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ x: 600 }}
      locale={{
        emptyText: (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="班级暂时没有从未 AC 的题目"
          />
        ),
      }}
    />
  );
}

/**
 * 班级教练工作台：学习统计 / 训练入口 / 错题本。
 *
 * 由班级详情页在教练或管理员身份下渲染；数据来自
 * `GET /api/classes/:id/learning-stats`。
 */
export function ClassWorkbench({ classId }: { classId: number }) {
  const [includeContest, setIncludeContest] = useState(true);
  const statsQuery = useQuery({
    queryKey: ['class-learning-stats', classId, includeContest],
    queryFn: () =>
      apiGet<ClassLearningStats>(
        `/api/classes/${classId}/learning-stats?includeContest=${includeContest}`,
      ),
  });

  const data = statsQuery.data;
  const retry = () => {
    void statsQuery.refetch();
  };

  const statsTab = (() => {
    if (statsQuery.isPending) return <PageLoading tip="正在加载班级学习统计…" />;
    if (statsQuery.isError) {
      return <ErrorResult error={statsQuery.error} onRetry={retry} />;
    }
    if (!data) {
      return <ErrorResult error={new Error('班级学习统计数据为空')} onRetry={retry} />;
    }
    return (
      <>
        <div className="class-workbench-stats">
          <Statistic title="学生数" value={data.studentCount} />
          <Statistic
            title="近 14 天活跃"
            value={data.activeStudentCount}
            suffix={<span className="learning-stat-suffix">/ {data.studentCount} 人</span>}
          />
          <Statistic title="完成题次" value={data.completedProblems} />
          <Statistic title="提交次数" value={data.totalSubmissions} />
        </div>
        <Card
          size="small"
          title="薄弱标签掌握率"
          className="class-workbench-row"
          extra={<span className="muted">越低越薄弱</span>}
        >
          {data.weakTags.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有可用于统计的标签" />
          ) : (
            <StatisticsChart
              height={Math.max(220, data.weakTags.length * 32)}
              option={{
                grid: { left: 96, right: 56, top: 12, bottom: 24 },
                tooltip: {
                  trigger: 'axis',
                  axisPointer: { type: 'shadow' },
                  formatter: (params: unknown) => {
                    const item = Array.isArray(params) ? params[0] : params;
                    const row = item as { name?: string; value?: number };
                    return `${row.name ?? ''}<br/>掌握率 ${row.value ?? 0}%`;
                  },
                },
                xAxis: {
                  type: 'value',
                  max: 100,
                  axisLabel: { formatter: '{value}%' },
                  splitLine: { lineStyle: { color: '#f0f0f0' } },
                },
                yAxis: {
                  type: 'category',
                  data: [...data.weakTags].reverse().map((item) => item.tag),
                },
                series: [
                  {
                    type: 'bar',
                    data: [...data.weakTags].reverse().map((item) =>
                      Math.round(item.solveRate * 100),
                    ),
                    itemStyle: { color: '#faad14', borderRadius: [0, 4, 4, 0] },
                    label: {
                      show: true,
                      position: 'right',
                      formatter: '{c}%',
                      color: '#8c8c8c',
                    },
                  },
                ],
              }}
            />
          )}
        </Card>
        <Row gutter={[16, 16]} className="class-workbench-row">
          <Col xs={24} lg={12}>
            <Card
              size="small"
              title="薄弱标签 Top10"
              extra={<span className="muted">按掌握率升序</span>}
            >
              <Table<ClassWeakTag>
                className="oij-table"
                rowKey="tag"
                size="small"
                columns={weakTagColumns}
                dataSource={data.weakTags}
                pagination={false}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="还没有可用于统计的标签"
                    />
                  ),
                }}
              />
            </Card>
          </Col>
          <Col xs={24} lg={12}>
            <Card
              size="small"
              title={`${INACTIVE_DAYS} 天未活跃成员`}
              extra={<Tag>{data.inactiveMembers.length} 人</Tag>}
            >
              <Table<ClassInactiveMember>
                className="oij-table"
                rowKey="userId"
                size="small"
                columns={buildInactiveColumns(classId)}
                dataSource={data.inactiveMembers}
                pagination={false}
                scroll={{ y: 300 }}
                locale={{
                  emptyText: (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="所有学生最近 14 天都有提交"
                    />
                  ),
                }}
              />
            </Card>
          </Col>
        </Row>
        <Card size="small" title="错题 Top10" className="class-workbench-row">
          <div className="learning-note">
            按从未 AC 的题目聚合，按涉及学生数与尝试次数排序；点击题目查看详情。
          </div>
          <WrongProblemTable rows={data.topWrongProblems} />
        </Card>
      </>
    );
  })();

  const trainingTab = (
    <Empty
      image={Empty.PRESENTED_IMAGE_SIMPLE}
      description={
        <div className="class-workbench-empty">
          <div>训练计划页面由训练计划模块提供。</div>
          <div className="muted">
            可以在这里跳转到训练计划，查看本班练习进度与完成情况。
          </div>
        </div>
      }
    >
      <Link to={trainingPlansPath(classId)}>
        <Button type="primary">打开训练计划</Button>
      </Link>
    </Empty>
  );

  const mistakesTab = (() => {
    if (statsQuery.isPending) return <PageLoading tip="正在加载错题本…" />;
    if (statsQuery.isError) {
      return <ErrorResult error={statsQuery.error} onRetry={retry} />;
    }
    if (!data) {
      return <ErrorResult error={new Error('班级学习统计数据为空')} onRetry={retry} />;
    }
    return (
      <>
        <div className="learning-note">
          班级错题本：统计本班学生从未 AC 的题目（最多 10 题），可据此安排针对性练习。
        </div>
        <WrongProblemTable rows={data.topWrongProblems} />
      </>
    );
  })();

  return (
    <Card
      className="oij-card"
      title="教练工作台"
      extra={
        <Space wrap size={12}>
          <Space size={6}>
            <span className="muted">包含比赛提交</span>
            <Switch size="small" checked={includeContest} onChange={setIncludeContest} />
          </Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={statsQuery.isFetching}
            onClick={retry}
          >
            刷新
          </Button>
        </Space>
      }
    >
      <Tabs
        className="class-workbench-tabs"
        items={[
          { key: 'stats', label: '学习统计', children: statsTab },
          { key: 'training', label: '训练', children: trainingTab },
          { key: 'mistakes', label: '错题本', children: mistakesTab },
        ]}
      />
    </Card>
  );
}
