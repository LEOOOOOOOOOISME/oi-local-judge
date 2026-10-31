import { Alert, Button, Card, Empty, Spin, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type {
  Contest,
  ProblemSummary,
  RankingCell,
  RankingRow,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { useNow } from '../hooks/useNow';
import { formatDateTime } from '../utils/format';
import {
  CONTEST_PHASE_LABEL,
  contestModeLabel,
  contestPhase,
  problemLetter,
  verdictTitle,
  type ContestPhase,
} from '../utils/status';

const PHASE_COLOR: Record<ContestPhase, string> = {
  upcoming: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

function RankCell({ cell }: { cell: RankingCell | undefined }) {
  if (!cell || (cell.score === 0 && cell.verdict === null)) {
    return <span className="rank-cell rank-cell-empty">—</span>;
  }
  const kind = cell.verdict === 'AC' ? 'ac' : cell.verdict ? 'partial' : 'empty';
  return (
    <span
      className={`rank-cell rank-cell-${kind}`}
      title={`${cell.verdict ? verdictTitle(cell.verdict) : '未通过'} · ${cell.score} 分`}
    >
      {cell.score}
    </span>
  );
}

export function ContestRankingPage() {
  const { contestId: contestIdParam } = useParams();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const now = useNow(1000);

  const contestsQuery = useQuery({
    queryKey: ['contests'],
    queryFn: () => apiGet<Contest[]>('/api/contests'),
    staleTime: 15_000,
  });
  const rankingQuery = useQuery({
    queryKey: ['ranking', contestId],
    queryFn: () => apiGet<RankingRow[]>(`/api/contests/${contestId}/ranking`),
    enabled: validId,
    staleTime: 5_000,
  });
  const problemsQuery = useQuery({
    queryKey: ['problems'],
    queryFn: () => apiGet<ProblemSummary[]>('/api/problems'),
    staleTime: 60_000,
  });

  const contest = contestsQuery.data?.find((item) => item.id === contestId) ?? null;
  const ranking = rankingQuery.data ?? [];
  const firstRow = ranking[0];
  const problemIds = firstRow ? firstRow.problems.map((cell) => cell.problemId) : [];
  const problemMap = new Map((problemsQuery.data ?? []).map((problem) => [problem.id, problem]));

  if (!validId) {
    return <ErrorResult error={new Error('无效的比赛编号')} />;
  }
  if (contestsQuery.isPending) {
    return <PageLoading tip="正在加载榜单…" />;
  }
  if (contestsQuery.isError) {
    return <ErrorResult error={contestsQuery.error} onRetry={() => void contestsQuery.refetch()} />;
  }

  const phase = contest ? contestPhase(contest, now) : 'ended';

  const baseColumns: TableColumnsType<RankingRow> = [
    {
      title: '排名',
      dataIndex: 'rank',
      width: 64,
      align: 'center',
      render: (rank: number) => <span className={`rank-no rank-no-${rank}`}>{rank}</span>,
    },
    {
      title: '选手',
      dataIndex: 'username',
      width: 190,
      render: (_value, row) => (
        <div className="rank-user">
          <span className="rank-user-name">{row.realName ?? row.username}</span>
          <span className="rank-user-meta muted">
            @{row.username}
            {row.className ? ` · ${row.className}` : ''}
          </span>
        </div>
      ),
    },
    {
      title: '总分',
      dataIndex: 'totalScore',
      width: 84,
      align: 'right',
      render: (value: number) => <strong className="rank-total">{value}</strong>,
    },
    {
      title: '通过',
      dataIndex: 'solved',
      width: 70,
      align: 'right',
    },
  ];

  const problemColumns: TableColumnsType<RankingRow> = problemIds.map((problemId, index) => ({
    title: (
      <div className="rank-problem-head">
        <span>{problemLetter(index)}</span>
        <span className="muted rank-problem-title">
          {problemMap.get(problemId)?.title ?? `#${problemId}`}
        </span>
      </div>
    ),
    width: 118,
    align: 'center',
    render: (_value, row) => (
      <RankCell cell={row.problems.find((cell) => cell.problemId === problemId)} />
    ),
  }));

  const trailingColumns: TableColumnsType<RankingRow> = [
    {
      title: '最后通过',
      dataIndex: 'lastAcAt',
      width: 156,
      render: (value: number | null) =>
        value === null ? <span className="muted">—</span> : <span className="mono">{formatDateTime(value)}</span>,
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '比赛', to: '/contests' },
          { label: contest?.name ?? `比赛 #${contestId}`, to: `/contest/${contestId}` },
          { label: '榜单' },
        ]}
        title={`${contest?.name ?? `比赛 #${contestId}`} · 榜单`}
        tags={
          <>
            <Tag color="blue">{contestModeLabel(contest?.mode ?? 'oi')}</Tag>
            <Tag color={PHASE_COLOR[phase]}>{CONTEST_PHASE_LABEL[phase]}</Tag>
            {contest?.freeze_at !== null && contest?.freeze_at !== undefined ? (
              <Tag>封榜 {formatDateTime(contest.freeze_at)}</Tag>
            ) : null}
          </>
        }
        subtitle="OI 赛制：每题取最高分，总分降序，同分按最后一次 AC 时间升序。"
        extra={
          <Link to={`/contest/${contestId}`}>
            <Button>返回比赛</Button>
          </Link>
        }
      />

      {contest?.freeze_at !== null && contest?.freeze_at !== undefined ? (
        <Alert
          className="ranking-freeze"
          type="info"
          showIcon
          message={`榜单已按封榜时间 ${formatDateTime(contest.freeze_at)} 过滤，之后的提交暂不计入。`}
        />
      ) : null}

      <Card className="oij-card">
        {rankingQuery.isPending ? (
          <div className="inline-loading">
            <Spin />
          </div>
        ) : rankingQuery.isError ? (
          <ErrorResult error={rankingQuery.error} onRetry={() => void rankingQuery.refetch()} />
        ) : ranking.length === 0 ? (
          <Empty description="暂无参赛者" />
        ) : (
          <Table<RankingRow>
            className="oij-table rank-table"
            rowKey="userId"
            size="small"
            columns={[...baseColumns, ...problemColumns, ...trailingColumns]}
            dataSource={ranking}
            pagination={false}
            scroll={{ x: 'max-content' }}
          />
        )}
      </Card>
    </div>
  );
}
