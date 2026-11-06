import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Empty,
  Input,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { EChartsCoreOption } from 'echarts/core';
import type {
  ContestStatistics,
  ContestStatisticsMode,
  ContestStatisticsProblem,
  OfficialRankingRow,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { StatisticsChart } from '../components/StatisticsChart';
import { fetchContestStatistics } from '../utils/contestStatistics';
import {
  fetchOfficialRanking,
  fetchOfficialRankingPage,
  presetLabel,
} from '../utils/officialRanking';
import {
  buildKpiItems,
  buildRingData,
  cleanInsights,
  distributionCumulativeRatios,
  distributionLabel,
  formatMetric,
  statisticsModeLabel,
} from '../utils/statistics';
import { contestModeLabel, problemLetter } from '../utils/status';
import { formatDateTime } from '../utils/format';
import '../styles/statistics.css';

type PrintMode = 'analysis' | 'results' | null;

const SERIES_COLORS = ['#4f7cff', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

function parsePrintMode(raw: string | null): PrintMode {
  return raw === 'analysis' || raw === 'results' ? raw : null;
}

function percentText(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${formatMetric(value)}%`;
}

function categoryAxisLabel(problems: ContestStatisticsProblem[]): string[] {
  return problems.map((problem) => `${problem.ordinal}. ${problem.title}`);
}

function distributionOption(stats: ContestStatistics): EChartsCoreOption {
  const labels = stats.distribution.map(distributionLabel);
  const cumulative = distributionCumulativeRatios(stats.distribution).map(
    (ratio) => Math.round(ratio * 1000) / 10,
  );
  return {
    color: SERIES_COLORS,
    tooltip: { trigger: 'axis' },
    legend: { data: ['人数', '累计占比'] },
    grid: { left: 52, right: 56, top: 40, bottom: 40 },
    xAxis: {
      type: 'category',
      name: stats.mode === 'score' ? '总分' : '通过题数',
      data: labels,
      axisLabel: { interval: 0, rotate: labels.length > 8 ? 35 : 0 },
    },
    yAxis: [
      { type: 'value', name: '人数', minInterval: 1 },
      { type: 'value', name: '累计占比 %', min: 0, max: 100 },
    ],
    series: [
      {
        name: '人数',
        type: 'bar',
        data: stats.distribution.map((bin) => bin.count),
        barMaxWidth: 42,
      },
      {
        name: '累计占比',
        type: 'line',
        yAxisIndex: 1,
        smooth: true,
        symbol: 'circle',
        data: cumulative,
      },
    ],
  };
}

function ringOption(stats: ContestStatistics): EChartsCoreOption {
  return {
    color: SERIES_COLORS,
    tooltip: { trigger: 'item', formatter: '{b}: {c} 人 ({d}%)' },
    legend: { bottom: 0 },
    series: [
      {
        name: '分数段',
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '45%'],
        avoidLabelOverlap: true,
        label: { formatter: '{b}\n{c} 人' },
        data: buildRingData(stats.distribution).map((datum) => ({
          name: datum.name,
          value: datum.value,
        })),
      },
    ],
  };
}

function problemOption(
  problem: ContestStatisticsProblem,
  mode: ContestStatisticsMode,
): EChartsCoreOption {
  const labels =
    mode === 'solved'
      ? problem.distribution.map((bin) => (bin.from >= 1 ? '通过' : '未通过'))
      : problem.distribution.map(distributionLabel);
  return {
    color: SERIES_COLORS,
    tooltip: { trigger: 'axis' },
    grid: { left: 44, right: 16, top: 28, bottom: 30 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { interval: 0, rotate: labels.length > 6 ? 30 : 0 },
    },
    yAxis: { type: 'value', name: '人数', minInterval: 1 },
    series: [
      {
        name: mode === 'solved' ? '人数' : '得分人数',
        type: 'bar',
        data: problem.distribution.map((bin) => bin.count),
        barMaxWidth: 34,
      },
    ],
  };
}

function difficultyOption(stats: ContestStatistics): EChartsCoreOption {
  return {
    color: SERIES_COLORS,
    tooltip: { trigger: 'axis' },
    legend: { data: ['难度 %', '区分度'] },
    grid: { left: 48, right: 48, top: 40, bottom: 56 },
    xAxis: {
      type: 'category',
      data: categoryAxisLabel(stats.problems),
      axisLabel: {
        interval: 0,
        rotate: stats.problems.length > 6 ? 35 : 0,
        overflow: 'truncate',
        width: 96,
      },
    },
    yAxis: [
      { type: 'value', name: '难度 %', min: 0, max: 100 },
      { type: 'value', name: '区分度' },
    ],
    series: [
      {
        name: '难度 %',
        type: 'bar',
        barMaxWidth: 32,
        data: stats.problems.map((problem) =>
          problem.difficulty === null ? null : Math.round(problem.difficulty * 1000) / 10,
        ),
      },
      {
        name: '区分度',
        type: 'bar',
        yAxisIndex: 1,
        barMaxWidth: 32,
        data: stats.problems.map((problem) => problem.discrimination),
      },
    ],
  };
}

function groupsOption(stats: ContestStatistics): EChartsCoreOption {
  const groups = stats.groups;
  return {
    color: SERIES_COLORS,
    tooltip: { trigger: 'axis' },
    legend: { data: ['平均分', '满分率 %'] },
    grid: { left: 48, right: 52, top: 40, bottom: 56 },
    xAxis: {
      type: 'category',
      data: groups.map((group) =>
        group.kind === 'team' ? `[团队] ${group.name}` : group.name,
      ),
      axisLabel: { interval: 0, rotate: groups.length > 8 ? 35 : 0 },
    },
    yAxis: [
      { type: 'value', name: stats.mode === 'solved' ? '平均通过题数' : '平均分' },
      { type: 'value', name: '满分率 %', min: 0, max: 100 },
    ],
    series: [
      {
        name: '平均分',
        type: 'bar',
        barMaxWidth: 38,
        data: groups.map((group) => group.avgScore),
      },
      {
        name: '满分率 %',
        type: 'line',
        yAxisIndex: 1,
        symbol: 'circle',
        data: groups.map((group) => group.fullRate),
      },
    ],
  };
}

function PrintHeader({ stats }: { stats: ContestStatistics }) {
  return (
    <div className="statistics-print-header">
      <h1>{stats.contest.title} · 比赛统计</h1>
      <div className="statistics-print-meta">
        <span>赛制：{contestModeLabel(stats.contest.mode)}</span>
        <span>排名规则：{presetLabel(stats.contest.preset)}</span>
        <span>统计口径：{statisticsModeLabel(stats.mode)}</span>
        <span>{stats.contest.frozen ? '封榜口径（封榜后提交不计入）' : '正式榜口径'}</span>
        <span>统计范围：{stats.includeHidden ? '公开选手 + 隐藏选手' : '公开选手'}</span>
        <span>生成时间：{formatDateTime(stats.contest.generatedAt)}</span>
      </div>
    </div>
  );
}

function KpiCards({ stats }: { stats: ContestStatistics }) {
  const items = buildKpiItems(stats);
  return (
    <Row className="statistics-kpi-row" gutter={[12, 12]}>
      {items.map((item) => (
        <Col key={item.key} xs={12} sm={8} md={6} xl={3}>
          <Card className="oij-card statistics-kpi-card" size="small">
            <Statistic
              title={item.label}
              value={item.value}
              suffix={item.unit ? <span className="statistics-kpi-unit">{item.unit}</span> : null}
            />
          </Card>
        </Col>
      ))}
    </Row>
  );
}

function AnalysisBody({ stats, print }: { stats: ContestStatistics; print: boolean }) {
  const chartHeight = print ? 320 : 300;
  const problems = stats.problems;
  const groups = stats.groups;
  const insights = cleanInsights(stats.insights);
  const distribution = stats.distribution;
  const ring = buildRingData(distribution);

  return (
    <div className="statistics-analysis">
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={16}>
          <Card
            className="oij-card statistics-chart-card"
            title={stats.mode === 'score' ? '总分分布与累计' : '通过题数分布与累计'}
          >
            {distribution.length === 0 ? (
              <Empty description="暂无成绩数据" />
            ) : (
              <StatisticsChart option={distributionOption(stats)} height={chartHeight} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={8}>
          <Card
            className="oij-card statistics-chart-card"
            title={stats.mode === 'score' ? '分数段分布' : '通过题数占比'}
          >
            {ring.length === 0 ? (
              <Empty description="暂无成绩数据" />
            ) : (
              <StatisticsChart option={ringOption(stats)} height={chartHeight} />
            )}
          </Card>
        </Col>
      </Row>

      <Card className="oij-card" title="每题得分分布">
        {problems.length === 0 ? (
          <Empty description="暂无题目" />
        ) : (
          <div className="statistics-problem-grid">
            {problems.map((problem, index) => (
              <div className="statistics-problem-card" key={problem.problemId}>
                <div className="statistics-problem-head">
                  <strong>
                    {problemLetter(index)} · {problem.title || `#${problem.problemId}`}
                  </strong>
                  <span className="muted">
                    {problem.fullScore} 分 · AC {percentText(problem.acRate)}
                  </span>
                </div>
                {problem.distribution.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
                ) : (
                  <StatisticsChart
                    option={problemOption(problem, stats.mode)}
                    height={print ? 200 : 180}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card className="oij-card statistics-chart-card" title="难度与区分度">
            {problems.length === 0 ? (
              <Empty description="暂无题目" />
            ) : (
              <StatisticsChart option={difficultyOption(stats)} height={chartHeight} />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            className="oij-card statistics-chart-card"
            title={stats.mode === 'solved' ? '班级/团队平均通过题数' : '班级/团队平均分'}
          >
            {groups.length === 0 ? (
              <Empty description="暂无班级或团队数据" />
            ) : (
              <StatisticsChart option={groupsOption(stats)} height={chartHeight} />
            )}
          </Card>
        </Col>
      </Row>

      <Card className="oij-card" title="自动分析">
        {insights.length === 0 ? (
          <Empty description="暂无可分析数据" />
        ) : (
          <ul className="statistics-insights">
            {insights.map((insight) => (
              <li key={insight}>{insight}</li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function PrintResultsTable({
  rows,
  problems,
  mode,
}: {
  rows: OfficialRankingRow[];
  problems: ContestStatisticsProblem[];
  mode: ContestStatisticsMode;
}) {
  return (
    <table className="print-results-table">
      <thead>
        <tr>
          <th>排名</th>
          <th>选手</th>
          <th>班级</th>
          <th>{mode === 'score' ? '总分' : '通过题数'}</th>
          {problems.map((problem, index) => (
            <th key={problem.problemId} title={problem.title}>
              {problemLetter(index)}
            </th>
          ))}
          <th>罚时</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.userId}>
            <td>{row.rank}</td>
            <td>
              {row.realName ?? row.username}
              <span className="muted"> @{row.username}</span>
            </td>
            <td>{row.className ?? '未分班'}</td>
            <td>{mode === 'score' ? row.totalScore : row.solved}</td>
            {problems.map((problem) => {
              const cell = row.cells.find(
                (candidate) => candidate.problemId === problem.problemId,
              );
              return (
                <td
                  key={problem.problemId}
                  className={cell?.verdict === 'AC' ? 'print-cell-ac' : undefined}
                >
                  {cell?.score ?? 0}
                </td>
              );
            })}
            <td>{mode === 'solved' ? row.penalty : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResultsTable({
  rows,
  total,
  page,
  pageSize,
  search,
  problems,
  mode,
  loading,
  error,
  onRetry,
  onPageChange,
  onSearchChange,
}: {
  rows: OfficialRankingRow[];
  total: number;
  page: number;
  pageSize: number;
  search: string;
  problems: ContestStatisticsProblem[];
  mode: ContestStatisticsMode;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onPageChange: (page: number, pageSize: number) => void;
  onSearchChange: (query: string) => void;
}) {
  const [searchInput, setSearchInput] = useState(search);

  useEffect(() => {
    const timer = window.setTimeout(() => onSearchChange(searchInput), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput, onSearchChange]);

  // AntD 表格要求 scroll.x 是数字；按列宽估算总宽度。
  const scrollX = 70 + 180 + 110 + 96 + problems.length * 100 + (mode === 'solved' ? 84 : 0);

  const columns = useMemo<TableColumnsType<OfficialRankingRow>>(() => {
    const base: TableColumnsType<OfficialRankingRow> = [
      {
        title: '排名',
        dataIndex: 'rank',
        width: 70,
        align: 'center',
        render: (rank: number) => <span className={`rank-no rank-no-${rank}`}>{rank}</span>,
      },
      {
        title: '选手',
        dataIndex: 'username',
        width: 180,
        render: (_value, row) => (
          <div className="rank-user">
            <span className="rank-user-name">{row.realName ?? row.username}</span>
            <span className="rank-user-meta muted">@{row.username}</span>
          </div>
        ),
      },
      {
        title: '班级',
        dataIndex: 'className',
        width: 110,
        render: (value: string | null) =>
          value ? <span>{value}</span> : <span className="muted">未分班</span>,
      },
      {
        title: mode === 'score' ? '总分' : '通过题数',
        dataIndex: mode === 'score' ? 'totalScore' : 'solved',
        width: 96,
        align: 'right',
        render: (value: number) => <strong className="rank-total">{value}</strong>,
      },
    ];
    const problemColumns: TableColumnsType<OfficialRankingRow> = problems.map(
      (problem, index) => ({
        title: (
          <div className="rank-problem-head">
            <span>{problemLetter(index)}</span>
            <span className="muted rank-problem-title">{problem.title}</span>
            <span className="rank-problem-points">{problem.fullScore} 分</span>
          </div>
        ),
        width: 100,
        align: 'center',
        render: (_value, row) => {
          const cell = row.cells.find(
            (candidate) => candidate.problemId === problem.problemId,
          );
          if (!cell || (cell.score === 0 && cell.verdict === null)) {
            return <span className="muted">—</span>;
          }
          return (
            <span
              className={
                cell.verdict === 'AC'
                  ? 'statistics-cell statistics-cell-ac'
                  : 'statistics-cell'
              }
            >
              {cell.score}
            </span>
          );
        },
      }),
    );
    const trailing: TableColumnsType<OfficialRankingRow> =
      mode === 'solved'
        ? [
            {
              title: '罚时',
              dataIndex: 'penalty' as const,
              width: 84,
              align: 'right' as const,
              render: (value: number) => <span className="mono">{value}</span>,
            },
          ]
        : [];
    return [...base, ...problemColumns, ...trailing];
  }, [problems, mode]);

  return (
    <div>
      <div className="statistics-results-toolbar">
        <Input.Search
          allowClear
          placeholder="搜索选手 / 姓名 / 班级"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ width: 260 }}
        />
        <span className="muted">
          共 {total} 人{search ? `（搜索：${search}）` : ''}
        </span>
      </div>
      {error ? (
        <ErrorResult error={error} onRetry={onRetry} />
      ) : (
        <Table<OfficialRankingRow>
          className="oij-table rank-table statistics-results-table"
          rowKey="userId"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={rows}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: ['50', '100', '200', '500'],
            showTotal: (count, range) => `${range[0]}-${range[1]} / 共 ${count} 人`,
            onChange: (nextPage, nextPageSize) => onPageChange(nextPage, nextPageSize),
          }}
          scroll={{ x: scrollX }}
          locale={{ emptyText: search ? '没有匹配的选手' : '暂无参赛者' }}
        />
      )}
    </div>
  );
}

export function ContestStatisticsPage() {
  const { contestId: contestIdParam } = useParams();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, status: authStatus } = useAuth();
  const canManage = user?.role === 'admin' || user?.role === 'contestmanager';
  const printMode = parsePrintMode(searchParams.get('print'));
  const wantsHidden = searchParams.get('includeHidden') === '1';
  const authResolved = authStatus !== 'loading';
  const includeHidden = canManage && wantsHidden;
  const [rankingPage, setRankingPage] = useState(1);
  const [rankingPageSize, setRankingPageSize] = useState(100);
  const [rankingSearch, setRankingSearch] = useState('');
  const setIncludeHidden = (next: boolean) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('includeHidden', '1');
    else params.delete('includeHidden');
    setSearchParams(params, { replace: true });
    setRankingPage(1);
  };
  const handleRankingSearch = useCallback((query: string) => {
    setRankingSearch(query);
    setRankingPage(1);
  }, []);
  const handleRankingPage = useCallback(
    (nextPage: number, nextPageSize: number) => {
      if (nextPageSize !== rankingPageSize) {
        setRankingPageSize(nextPageSize);
        setRankingPage(1);
      } else {
        setRankingPage(nextPage);
      }
    },
    [rankingPageSize],
  );

  const statsQuery = useQuery({
    queryKey: ['contest-statistics', contestId, includeHidden],
    queryFn: () => fetchContestStatistics(contestId, includeHidden),
    // 打印页希望包含隐藏选手时，等登录态解析完再请求，避免先按公开口径打印。
    enabled: validId && (!wantsHidden || authResolved),
    staleTime: 5_000,
    retry: false,
  });
  // 打印个人成绩需要完整正式榜；屏幕成绩表走服务端分页，只取当前页。
  const completeRankingQuery = useQuery({
    queryKey: ['official-ranking', contestId, includeHidden],
    queryFn: () => fetchOfficialRanking(contestId, includeHidden),
    enabled:
      validId &&
      printMode === 'results' &&
      (!wantsHidden || authResolved),
    staleTime: 5_000,
    retry: false,
  });
  const rankingPageQuery = useQuery({
    queryKey: [
      'official-ranking-page',
      contestId,
      includeHidden,
      rankingPage,
      rankingPageSize,
      rankingSearch,
    ],
    queryFn: () =>
      fetchOfficialRankingPage(
        contestId,
        {
          offset: (rankingPage - 1) * rankingPageSize,
          limit: rankingPageSize,
          query: rankingSearch,
        },
        includeHidden,
      ),
    enabled: validId && printMode === null && (!wantsHidden || authResolved),
    staleTime: 5_000,
    retry: false,
    placeholderData: keepPreviousData,
  });

  const stats = statsQuery.data;
  const printRows = completeRankingQuery.data?.rows ?? [];
  const pageRows = rankingPageQuery.data?.items ?? [];
  const pageTotal = rankingPageQuery.data?.total ?? 0;
  const problems = stats?.problems ?? [];

  useEffect(() => {
    if (!printMode) return undefined;
    document.body.classList.add('statistics-print-mode');
    return () => document.body.classList.remove('statistics-print-mode');
  }, [printMode]);

  useEffect(() => {
    if (!stats) return undefined;
    const previous = document.title;
    document.title = `${stats.contest.title} · 比赛统计`;
    return () => {
      document.title = previous;
    };
  }, [stats]);

  // 打印分析报告：等查询完成与 ECharts 首帧后再调起浏览器打印。
  useEffect(() => {
    if (printMode !== 'analysis' || !statsQuery.isSuccess) return undefined;
    const timer = window.setTimeout(() => window.print(), 1200);
    return () => window.clearTimeout(timer);
  }, [printMode, statsQuery.isSuccess, statsQuery.dataUpdatedAt]);

  // 打印个人成绩：等完整正式榜（含隐藏选项）加载完成后打印。
  useEffect(() => {
    if (printMode !== 'results' || !completeRankingQuery.isSuccess) return undefined;
    const timer = window.setTimeout(() => window.print(), 400);
    return () => window.clearTimeout(timer);
  }, [printMode, completeRankingQuery.isSuccess, completeRankingQuery.dataUpdatedAt]);

  const openPrint = (kind: 'analysis' | 'results') => {
    const params = new URLSearchParams({ print: kind });
    if (includeHidden) params.set('includeHidden', '1');
    window.open(
      `/contest/${contestId}/statistics?${params.toString()}`,
      '_blank',
      'noopener,noreferrer',
    );
  };

  if (!validId) {
    return <ErrorResult error={new Error('无效的比赛编号')} />;
  }
  if (statsQuery.isPending) {
    return <PageLoading tip="正在计算比赛统计…" />;
  }
  if (statsQuery.isError) {
    return <ErrorResult error={statsQuery.error} onRetry={() => void statsQuery.refetch()} />;
  }
  if (!stats) {
    return <ErrorResult error={new Error('比赛不存在')} />;
  }

  if (printMode === 'results') {
    if (completeRankingQuery.isError) {
      return (
        <ErrorResult
          error={completeRankingQuery.error}
          onRetry={() => void completeRankingQuery.refetch()}
        />
      );
    }
    if (completeRankingQuery.isPending) {
      return <PageLoading tip="正在加载个人成绩…" />;
    }
    return (
      <div className="statistics-page statistics-print-page">
        <PrintHeader stats={stats} />
        <PrintResultsTable rows={printRows} problems={problems} mode={stats.mode} />
        <div className="statistics-print-footer">
          共 {printRows.length} 名{stats.includeHidden ? '可见及隐藏' : '可见'}参赛者 · 正式榜口径
        </div>
      </div>
    );
  }

  if (printMode === 'analysis') {
    return (
      <div className="statistics-page statistics-print-page">
        <PrintHeader stats={stats} />
        <KpiCards stats={stats} />
        <AnalysisBody stats={stats} print />
      </div>
    );
  }

  return (
    <div className="statistics-page">
      <PageHead
        breadcrumb={[
          { label: '比赛', to: '/contests' },
          { label: stats.contest.title, to: `/contest/${contestId}` },
          { label: '统计' },
        ]}
        title={`${stats.contest.title} · 比赛统计`}
        tags={
          <>
            <Tag color="geekblue">{presetLabel(stats.contest.preset)}</Tag>
            <Tag>{contestModeLabel(stats.contest.mode)}</Tag>
            <Tag color={stats.mode === 'score' ? 'green' : 'purple'}>
              {statisticsModeLabel(stats.mode)}
            </Tag>
            {stats.contest.frozen ? <Tag color="gold">封榜中</Tag> : null}
            {stats.includeHidden ? <Tag color="red">含隐藏选手</Tag> : null}
          </>
        }
        subtitle={
          stats.mode === 'score'
            ? '数据来自正式榜/封榜快照：总分分布、每题得分、难度与区分度、班级对比。'
            : 'ACM/CF 口径：按通过题数与罚时统计，不展示分数直方图。'
        }
        extra={
          <Space wrap>
            {canManage ? (
              <Checkbox
                checked={includeHidden}
                onChange={(event) => setIncludeHidden(event.target.checked)}
              >
                包含隐藏选手
              </Checkbox>
            ) : null}
            <Button
              icon={<ReloadOutlined />}
              loading={
                statsQuery.isFetching ||
                (printMode === 'results'
                  ? completeRankingQuery.isFetching
                  : rankingPageQuery.isFetching)
              }
              onClick={() => {
                void statsQuery.refetch();
                if (printMode === 'results') void completeRankingQuery.refetch();
                else if (printMode === null) void rankingPageQuery.refetch();
              }}
            >
              刷新
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => openPrint('analysis')}>
              导出分析 PDF
            </Button>
            <Button icon={<DownloadOutlined />} onClick={() => openPrint('results')}>
              导出个人成绩 PDF
            </Button>
            <Link to={`/contest/${contestId}/ranking`}>
              <Button>返回榜单</Button>
            </Link>
          </Space>
        }
      />

      {stats.contest.frozen ? (
        <Alert
          className="ranking-freeze"
          type="info"
          showIcon
          message="统计按封榜时间过滤，封榜后的提交暂不计入；解封后自动更新。"
        />
      ) : null}

      <KpiCards stats={stats} />
      <AnalysisBody stats={stats} print={false} />

      <Card className="oij-card statistics-results-card" title="个人成绩">
        <ResultsTable
          rows={pageRows}
          total={pageTotal}
          page={rankingPage}
          pageSize={rankingPageSize}
          search={rankingSearch}
          problems={problems}
          mode={stats.mode}
          loading={rankingPageQuery.isPending || rankingPageQuery.isFetching}
          error={rankingPageQuery.error}
          onRetry={() => void rankingPageQuery.refetch()}
          onPageChange={handleRankingPage}
          onSearchChange={handleRankingSearch}
        />
      </Card>
    </div>
  );
}
