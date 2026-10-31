import { useMemo } from 'react';
import { Button, Card, Empty, Result, Spin, Tag } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { Contest, ProblemSummary, RankingRow, Submission } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ContestCountdown } from '../components/Countdown';
import { MetaList } from '../components/MetaList';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { ProblemListTable, type ProblemScore } from '../components/ProblemListTable';
import { SubmissionTable } from '../components/SubmissionTable';
import { useNow } from '../hooks/useNow';
import { formatDateTime } from '../utils/format';
import {
  CONTEST_PHASE_LABEL,
  contestModeLabel,
  contestPhase,
  problemLetter,
  type ContestPhase,
} from '../utils/status';

const PHASE_COLOR: Record<ContestPhase, string> = {
  upcoming: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

export function ContestOverviewPage() {
  const { contestId: contestIdParam } = useParams();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const { user } = useAuth();
  const navigate = useNavigate();
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
  const submissionsQuery = useQuery({
    queryKey: ['submissions', { scope: 'mine', contestId }],
    queryFn: () => apiGet<Submission[]>(`/api/submissions?userId=me&contestId=${contestId}&limit=8`),
    enabled: validId && Boolean(user),
  });

  const contest = contestsQuery.data?.find((item) => item.id === contestId) ?? null;
  const ranking = rankingQuery.data ?? [];
  const myRow = user ? ranking.find((row) => row.userId === user.id) : undefined;
  const problemMap = useMemo(
    () => new Map((problemsQuery.data ?? []).map((problem) => [problem.id, problem])),
    [problemsQuery.data],
  );

  const contestProblems = useMemo<ProblemSummary[]>(() => {
    const first = ranking[0];
    if (!first) return [];
    return first.problems
      .map((cell) => problemMap.get(cell.problemId))
      .filter((problem): problem is ProblemSummary => problem !== undefined);
  }, [ranking, problemMap]);

  const letters = useMemo(() => {
    const map = new Map<number, string>();
    const first = ranking[0];
    if (first) {
      first.problems.forEach((cell, index) => map.set(cell.problemId, problemLetter(index)));
    }
    return map;
  }, [ranking]);

  const scores = useMemo(() => {
    const map = new Map<number, ProblemScore>();
    for (const cell of myRow?.problems ?? []) {
      map.set(cell.problemId, { score: cell.score, verdict: cell.verdict });
    }
    return map;
  }, [myRow]);

  const problemTitles = useMemo(
    () => new Map((problemsQuery.data ?? []).map((problem) => [problem.id, problem.title])),
    [problemsQuery.data],
  );

  if (contestsQuery.isPending) return <PageLoading tip="正在加载比赛…" />;
  if (contestsQuery.isError) {
    return <ErrorResult error={contestsQuery.error} onRetry={() => void contestsQuery.refetch()} />;
  }
  if (!contest) {
    return (
      <Result
        status="404"
        title="比赛不存在"
        subTitle={`没有找到 #${contestIdParam} 对应的比赛。`}
        extra={
          <Link to="/contests">
            <Button type="primary">返回比赛列表</Button>
          </Link>
        }
      />
    );
  }

  const phase = contestPhase(contest, now);
  const contestPath = `/contest/${contest.id}`;
  const loginHref = `/login?next=${encodeURIComponent(contestPath)}`;

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '比赛', to: '/contests' }, { label: contest.name }]}
        title={contest.name}
        tags={
          <>
            <Tag color="blue">{contestModeLabel(contest.mode)}</Tag>
            <Tag color={PHASE_COLOR[phase]}>{CONTEST_PHASE_LABEL[phase]}</Tag>
            {contest.freeze_at !== null ? <Tag>已设置封榜</Tag> : null}
          </>
        }
        subtitle={
          <span>
            {formatDateTime(contest.start_at)} 至 {formatDateTime(contest.end_at)}
            {myRow ? ` · 我的排名 第 ${myRow.rank} 名，总分 ${myRow.totalScore}` : null}
          </span>
        }
      />

      <div className="content-grid">
        <div className="stack">
          <Card
            className="oij-card"
            title="题目列表"
            extra={<span className="muted">共 {contestProblems.length} 题</span>}
          >
            {rankingQuery.isPending ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : rankingQuery.isError ? (
              <ErrorResult
                error={rankingQuery.error}
                onRetry={() => void rankingQuery.refetch()}
              />
            ) : contestProblems.length === 0 ? (
              <Empty description="题目列表暂不可用" />
            ) : (
              <ProblemListTable
                problems={contestProblems}
                problemPath={(problemId) => `${contestPath}/problem/${problemId}`}
                letters={letters}
                scores={scores}
                showScore={Boolean(user)}
              />
            )}
          </Card>

          <Card
            className="oij-card"
            title="我的提交"
            extra={
              user ? (
                <Link to="/records">全部记录</Link>
              ) : (
                <Link to={loginHref}>登录</Link>
              )
            }
          >
            {!user ? (
              <Empty description="登录后查看本场比赛的提交" />
            ) : submissionsQuery.isPending ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : submissionsQuery.isError ? (
              <ErrorResult
                error={submissionsQuery.error}
                onRetry={() => void submissionsQuery.refetch()}
              />
            ) : (
              <SubmissionTable
                submissions={submissionsQuery.data ?? []}
                problemTitles={problemTitles}
                problemPath={(problemId) => `${contestPath}/problem/${problemId}`}
                emptyText="本场比赛还没有提交"
              />
            )}
          </Card>
        </div>

        <div className="stack">
          <Card className="oij-card" title="比赛信息" size="small">
            <ContestCountdown contest={contest} />
            <MetaList
              items={[
                { label: '赛制', value: contestModeLabel(contest.mode) },
                { label: '开始', value: formatDateTime(contest.start_at) },
                { label: '结束', value: formatDateTime(contest.end_at) },
                {
                  label: '封榜',
                  value: contest.freeze_at === null ? '未设置' : formatDateTime(contest.freeze_at),
                },
                { label: '参赛人数', value: ranking.length },
              ]}
            />
          </Card>

          <Card
            className="oij-card"
            title="榜单"
            size="small"
            extra={<Link to={`${contestPath}/ranking`}>完整榜单</Link>}
          >
            {ranking.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无参赛者" />
            ) : (
              <div className="top3-list">
                {ranking.slice(0, 3).map((row) => (
                  <div className="top3-row" key={row.userId}>
                    <span className={`top3-rank top3-rank-${row.rank}`}>{row.rank}</span>
                    <span className="top3-name">{row.realName ?? row.username}</span>
                    <span className="top3-score">{row.totalScore}</span>
                  </div>
                ))}
              </div>
            )}
            <Button
              type="primary"
              block
              className="side-action"
              onClick={() => navigate(`${contestPath}/ranking`)}
            >
              查看完整榜单
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
