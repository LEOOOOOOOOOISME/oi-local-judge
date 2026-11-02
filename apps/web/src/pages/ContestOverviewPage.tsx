import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Empty, Result, Space, Spin, Tabs, Tag } from 'antd';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type {
  Contest,
  ContestDetail,
  ProblemSummary,
  Submission,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ContestAnnouncements } from '../components/ContestAnnouncements';
import { ContestClarifications } from '../components/ContestClarifications';
import { ContestCountdown } from '../components/Countdown';
import { MetaList } from '../components/MetaList';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { ProblemListTable, type ProblemScore } from '../components/ProblemListTable';
import { SubmissionTable } from '../components/SubmissionTable';
import { useNow } from '../hooks/useNow';
import { formatDateTime } from '../utils/format';
import { fetchOfficialRanking } from '../utils/officialRanking';
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(
    searchParams.get('tab') === 'clarifications' ? 'clarifications' : 'overview',
  );

  useEffect(() => {
    if (searchParams.get('tab') === 'clarifications') setActiveTab('clarifications');
  }, [searchParams]);

  const handleTabChange = (key: string) => {
    setActiveTab(key);
    const next = new URLSearchParams(searchParams);
    if (key === 'clarifications') next.set('tab', 'clarifications');
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  };

  // 首选比赛详情接口（比赛元信息 + 题目/分值 + 参赛人数）。
  const detailQuery = useQuery({
    queryKey: ['contest-detail', contestId],
    queryFn: () => apiGet<ContestDetail>(`/api/contests/${contestId}`),
    enabled: validId,
    staleTime: 30_000,
  });
  const detail = detailQuery.data ?? null;
  // 详情接口失败时回退到旧逻辑：比赛列表 + 公开题库 + 榜单推导题目。
  const useFallback = detailQuery.isError;

  const contestsQuery = useQuery({
    queryKey: ['contests'],
    queryFn: () => apiGet<Contest[]>('/api/contests'),
    enabled: validId && useFallback,
    staleTime: 15_000,
  });
  // 比赛页与正式榜共用 official-ranking（计算规则一致，404 时内部回退旧 /ranking）。
  const rankingQuery = useQuery({
    queryKey: ['official-ranking', contestId],
    queryFn: () => fetchOfficialRanking(contestId),
    enabled: validId,
    staleTime: 5_000,
    retry: false,
  });
  const problemsQuery = useQuery({
    queryKey: ['problems'],
    queryFn: () => apiGet<ProblemSummary[]>('/api/problems'),
    enabled: validId && useFallback,
    staleTime: 60_000,
  });
  const submissionsQuery = useQuery({
    queryKey: ['submissions', { scope: 'mine', contestId }],
    queryFn: () => apiGet<Submission[]>(`/api/submissions?userId=me&contestId=${contestId}&limit=8`),
    enabled: validId && Boolean(user),
  });

  const contest =
    detail?.contest ?? contestsQuery.data?.find((item) => item.id === contestId) ?? null;
  // 正式榜：rows 用于 top3 / 我的排名，problems 用于题目顺序与题号。
  const official = rankingQuery.data;
  const rows = official?.rows ?? [];
  const officialProblems = official?.problems;
  const myRow = user ? rows.find((row) => row.userId === user.id) : undefined;

  const problemMap = useMemo(
    () => new Map((problemsQuery.data ?? []).map((problem) => [problem.id, problem])),
    [problemsQuery.data],
  );

  const contestProblems = useMemo<ProblemSummary[]>(() => {
    if (detail) {
      return detail.problems.map((problem) => ({
        id: problem.problemId,
        title: problem.title,
        type: problem.type,
        difficulty: problem.difficulty,
        tags: [],
        timeMs: problem.timeMs,
        memoryMb: problem.memoryMb,
      }));
    }
    return (officialProblems ?? [])
      .map((problem) => problemMap.get(problem.id))
      .filter((problem): problem is ProblemSummary => problem !== undefined);
  }, [detail, officialProblems, problemMap]);

  const letters = useMemo(() => {
    const map = new Map<number, string>();
    if (detail) {
      for (const problem of detail.problems) {
        map.set(problem.problemId, problemLetter(problem.ordinal - 1));
      }
      return map;
    }
    (officialProblems ?? []).forEach((problem, index) =>
      map.set(problem.id, problemLetter(index)),
    );
    return map;
  }, [detail, officialProblems]);

  const points = useMemo(() => {
    const map = new Map<number, number>();
    for (const problem of detail?.problems ?? []) {
      map.set(problem.problemId, problem.points);
    }
    return map;
  }, [detail]);

  const totalPoints = useMemo(() => {
    if (!detail) return null;
    return detail.problems.reduce((sum, problem) => sum + problem.points, 0);
  }, [detail]);

  const scores = useMemo(() => {
    const map = new Map<number, ProblemScore>();
    for (const cell of myRow?.cells ?? []) {
      map.set(cell.problemId, { score: cell.score, verdict: cell.verdict });
    }
    return map;
  }, [myRow]);

  const problemTitles = useMemo(() => {
    if (detail) {
      return new Map(detail.problems.map((problem) => [problem.problemId, problem.title]));
    }
    return new Map((problemsQuery.data ?? []).map((problem) => [problem.id, problem.title]));
  }, [detail, problemsQuery.data]);

  if (!validId) {
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
  if (detailQuery.isPending) {
    return <PageLoading tip="正在加载比赛…" />;
  }
  if (detailQuery.isError) {
    if (contestsQuery.isPending) {
      return <PageLoading tip="正在加载比赛…" />;
    }
    if (contestsQuery.isError) {
      return (
        <ErrorResult
          error={contestsQuery.error}
          onRetry={() => {
            void detailQuery.refetch();
            void contestsQuery.refetch();
          }}
        />
      );
    }
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
  const listPending = !detail && rankingQuery.isPending;
  const listError = !detail ? rankingQuery.error : null;
  const participantCount = detail?.participantCount ?? rows.length;

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
        extra={
          <Space>
            <Link to={`${contestPath}/screen`} target="_blank" rel="noreferrer">
              <Button>大屏</Button>
            </Link>
            <Link to={`${contestPath}/correction`}>
              <Button>订正榜</Button>
            </Link>
          </Space>
        }
      />

      <Tabs
        className="problem-tabs contest-tabs"
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'overview',
            label: '比赛信息',
            children: (
              <div className="stack">
                <ContestAnnouncements contestId={contest.id} />
                <div className="content-grid">
        <div className="stack">
          <Card
            className="oij-card"
            title="题目列表"
            extra={
              <span className="muted">
                共 {contestProblems.length} 题
                {totalPoints !== null ? ` · 满分 ${totalPoints}` : ''}
              </span>
            }
          >
            {listPending ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : listError ? (
              <ErrorResult
                error={listError}
                onRetry={() => void rankingQuery.refetch()}
              />
            ) : contestProblems.length === 0 ? (
              <Empty description={detail ? '本场比赛暂无题目' : '题目列表暂不可用'} />
            ) : (
              <ProblemListTable
                problems={contestProblems}
                problemPath={(problemId) => `${contestPath}/problem/${problemId}`}
                letters={letters}
                scores={scores}
                points={detail ? points : undefined}
                showScore={Boolean(user)}
                showTags={!detail}
              />
            )}
          </Card>

          <Card
            className="oij-card"
            title="我的提交"
            extra={user ? <Link to="/records">全部记录</Link> : <Link to={loginHref}>登录</Link>}
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
                { label: '题目数', value: contestProblems.length },
                { label: '参赛人数', value: participantCount },
              ]}
            />
          </Card>

          <Card
            className="oij-card"
            title="榜单"
            size="small"
            extra={<Link to={`${contestPath}/ranking`}>完整榜单</Link>}
          >
            {rankingQuery.isError ? (
              <div className="side-error">
                <span className="muted">榜单加载失败</span>
                <Button size="small" onClick={() => void rankingQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : rows.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无参赛者" />
            ) : (
              <div className="top3-list">
                {rows.slice(0, 3).map((row) => (
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
            ),
          },
          {
            key: 'clarifications',
            label: '答疑',
            children: <ContestClarifications contestId={contest.id} />,
          },
        ]}
      />
    </div>
  );
}
