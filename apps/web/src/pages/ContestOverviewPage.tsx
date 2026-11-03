import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Empty,
  Result,
  Space,
  Spin,
  Tabs,
  Tag,
} from 'antd';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPost } from '../api/client';
import type {
  Contest,
  ContestDetail,
  MyContestRegistration,
  ProblemSummary,
  Submission,
  TeamRegistration,
  TeamSummary,
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
  captainTeams,
  resolveTeamMode,
  teamModeLabel,
} from '../utils/teamContest';
import {
  allowsSelfRegistration,
  describeRegistrationError,
  registrationModeLabel,
  registrationStatusColor,
  registrationStatusLabel,
  resolveRegistrationMode,
} from '../utils/registration';
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
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const now = useNow(1000);
  const [registeringTeamId, setRegisteringTeamId] = useState<number | null>(null);
  const [registrationBusy, setRegistrationBusy] = useState(false);
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

  const contestSource =
    detail?.contest ??
    contestsQuery.data?.find((item) => item.id === contestId) ??
    null;
  const teamMode = resolveTeamMode(contestSource);
  const teamEnabled = teamMode !== 'individual';
  const registrationMode = resolveRegistrationMode(contestSource);
  const registrationEnabled = allowsSelfRegistration(registrationMode);
  const isManager = user?.role === 'admin' || user?.role === 'contestmanager';

  const myTeamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
    enabled: validId && Boolean(user) && teamEnabled,
    staleTime: 15_000,
  });
  const contestTeamsQuery = useQuery({
    queryKey: ['contest-teams', contestId],
    queryFn: () => apiGet<TeamRegistration[]>(`/api/contests/${contestId}/teams`),
    enabled: validId && Boolean(user) && teamEnabled,
    staleTime: 10_000,
    retry: false,
  });
  // manual 模式下后端只允许管理员导入，选手侧不显示自助报名入口。
  const myRegistrationQuery = useQuery({
    queryKey: ['my-registration', contestId],
    queryFn: () => apiGet<MyContestRegistration>(`/api/contests/${contestId}/registration`),
    enabled: validId && Boolean(user) && registrationEnabled,
    staleTime: 5_000,
    retry: false,
  });
  const myRegistration = myRegistrationQuery.data?.registration ?? null;

  const myCaptainTeams = useMemo(
    () => captainTeams(myTeamsQuery.data ?? []),
    [myTeamsQuery.data],
  );
  const registeredTeamIds = useMemo(
    () => new Set((contestTeamsQuery.data ?? []).map((team) => team.teamId)),
    [contestTeamsQuery.data],
  );

  const registerTeam = async (teamId: number) => {
    setRegisteringTeamId(teamId);
    try {
      await apiPost<null>(`/api/contests/${contestId}/teams`, { teamId });
      message.success('团队报名成功');
      void queryClient.invalidateQueries({ queryKey: ['contest-teams', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['team-ranking', contestId] });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'TEAM_ALREADY_REGISTERED') {
        message.warning('该团队已经报名本场比赛');
        void queryClient.invalidateQueries({ queryKey: ['contest-teams', contestId] });
      } else if (error instanceof ApiError && error.code === 'TEAM_MEMBER_CONFLICT') {
        message.error(error.message);
      } else {
        message.error(error instanceof Error ? error.message : '团队报名失败');
      }
    } finally {
      setRegisteringTeamId(null);
    }
  };

  const contest = contestSource;
  const registrationClosed =
    contest !== null &&
    (contest.status === 'ended' ||
      contest.status === 'archived' ||
      Boolean(contest.archived_at) ||
      (contest.end_at !== null && now >= contest.end_at));

  const invalidateRegistration = () => {
    void queryClient.invalidateQueries({ queryKey: ['my-registration', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['contests'] });
    void queryClient.invalidateQueries({ queryKey: ['admin-registrations', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['admin-participants', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
    void queryClient.invalidateQueries({ queryKey: ['ranking', contestId] });
  };

  const selfRegister = async () => {
    setRegistrationBusy(true);
    try {
      const result = await apiPost<{ status: 'accepted' | 'pending' }>(
        `/api/contests/${contestId}/register`,
      );
      message.success(
        result.status === 'pending'
          ? '报名已提交，等待管理员审核'
          : '报名成功，已加入参赛名单',
      );
      invalidateRegistration();
    } catch (error) {
      message.error(describeRegistrationError(error));
    } finally {
      setRegistrationBusy(false);
    }
  };

  const cancelRegistration = async () => {
    setRegistrationBusy(true);
    try {
      await apiDelete<null>(`/api/contests/${contestId}/register`);
      message.success('已取消报名');
      invalidateRegistration();
    } catch (error) {
      message.error(describeRegistrationError(error));
    } finally {
      setRegistrationBusy(false);
    }
  };

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
  // 奖项在比赛结束/归档后公开；管理员可提前预览（与后端 403 判定一致）。
  const awardsReady =
    phase === 'ended' ||
    contest.status === 'archived' ||
    Boolean(contest.archived_at);
  const showAwardsEntry = awardsReady || isManager;
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
            {teamEnabled ? <Tag color="purple">{teamModeLabel(teamMode)}</Tag> : null}
            <Tag color={registrationMode === 'manual' ? 'default' : 'geekblue'}>
              {registrationModeLabel(registrationMode)}
            </Tag>
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
          <Space wrap>
            {teamEnabled ? (
              <Link to={`${contestPath}/ranking?view=team`}>
                <Button>团队榜</Button>
              </Link>
            ) : null}
            <Link to={`${contestPath}/screen`} target="_blank" rel="noreferrer">
              <Button>大屏</Button>
            </Link>
            <Link to={`${contestPath}/correction`}>
              <Button>订正榜</Button>
            </Link>
            {showAwardsEntry ? (
              <Link to={`${contestPath}/awards`}>
                <Button>{awardsReady ? '奖项/证书' : '奖项预览'}</Button>
              </Link>
            ) : null}
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
                { label: '报名方式', value: registrationModeLabel(registrationMode) },
                ...(teamEnabled
                  ? [{ label: '团队报名', value: teamModeLabel(teamMode) }]
                  : []),
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
            title="我的报名"
            size="small"
            extra={
              isManager ? <Link to={`/admin/contests/${contest.id}`}>报名管理</Link> : null
            }
          >
            {registrationMode === 'manual' ? (
              <div className="stack">
                <Space wrap>
                  <Tag>{registrationModeLabel(registrationMode)}</Tag>
                </Space>
                <span className="muted">本场比赛由管理员导入参赛名单，无需自助报名。</span>
                {isManager ? (
                  <span className="muted">可在管理控制台的“参赛者”中添加名单。</span>
                ) : null}
              </div>
            ) : !user ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={<Link to={loginHref}>登录后报名</Link>}
              />
            ) : myRegistrationQuery.isPending ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : myRegistrationQuery.isError ? (
              <div className="side-error">
                <span className="muted">报名状态加载失败</span>
                <Button size="small" onClick={() => void myRegistrationQuery.refetch()}>
                  重试
                </Button>
              </div>
            ) : myRegistration ? (
              <div className="stack">
                <Space wrap>
                  <Tag color={registrationStatusColor(myRegistration.status)}>
                    {myRegistration.status === 'accepted'
                      ? '已报名'
                      : registrationStatusLabel(myRegistration.status)}
                  </Tag>
                  {myRegistration.checkedInAt !== null ? (
                    <Tag color="blue">已签到</Tag>
                  ) : null}
                </Space>
                {myRegistration.status === 'pending' ? (
                  <span className="muted">报名已提交，等待管理员审核。</span>
                ) : null}
                {myRegistration.status === 'accepted' ? (
                  <span className="muted">
                    {myRegistration.checkedInAt !== null
                      ? '你已报名并完成签到。'
                      : '你已报名本场比赛，签到状态以管理员记录为准。'}
                  </span>
                ) : null}
                {myRegistration.status === 'rejected' ? (
                  <span className="muted">报名未通过，可在比赛结束前重新报名。</span>
                ) : null}
                {registrationClosed ? (
                  <span className="muted">报名已截止。</span>
                ) : myRegistration.status === 'pending' ? (
                  <Button
                    size="small"
                    danger
                    loading={registrationBusy}
                    onClick={() => void cancelRegistration()}
                  >
                    取消报名
                  </Button>
                ) : myRegistration.status === 'rejected' ? (
                  <Button
                    size="small"
                    type="primary"
                    loading={registrationBusy}
                    onClick={() => void selfRegister()}
                  >
                    重新报名
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="stack">
                <span className="muted">
                  {registrationMode === 'approval'
                    ? '本场比赛需要管理员审核报名。'
                    : '本场比赛开放自助报名。'}
                </span>
                <Button
                  type="primary"
                  size="small"
                  disabled={registrationClosed}
                  loading={registrationBusy}
                  onClick={() => void selfRegister()}
                >
                  {registrationClosed ? '报名已截止' : '报名'}
                </Button>
              </div>
            )}
          </Card>

          {teamEnabled ? (
            <Card
              className="oij-card"
              title="团队报名"
              size="small"
              extra={<Link to={`${contestPath}/ranking?view=team`}>团队榜</Link>}
            >
              {!user ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={<Link to={loginHref}>登录后报名团队</Link>}
                />
              ) : (
                <div className="stack">
                  {myTeamsQuery.isPending ? (
                    <div className="inline-loading">
                      <Spin />
                    </div>
                  ) : myCaptainTeams.length === 0 ? (
                    <div className="muted">
                      只有队长可以为本团队报名；管理员可以在管理控制台代报名。
                    </div>
                  ) : (
                    <div className="stack">
                      {myCaptainTeams.map((team) => {
                        const registered = registeredTeamIds.has(team.id);
                        return (
                          <Space key={team.id} wrap>
                            <span>{team.name}</span>
                            <span className="muted">{team.memberCount} 人</span>
                            {registered ? (
                              <Tag color="green">已报名</Tag>
                            ) : (
                              <Button
                                size="small"
                                type="primary"
                                loading={registeringTeamId === team.id}
                                onClick={() => void registerTeam(team.id)}
                              >
                                报名
                              </Button>
                            )}
                          </Space>
                        );
                      })}
                    </div>
                  )}

                  {isManager ? (
                    <Link to={`/admin/contests/${contest.id}`}>
                      <Button size="small" block>
                        管理员代报名 / 移除团队
                      </Button>
                    </Link>
                  ) : null}

                  <div className="muted">已报名团队</div>
                  {contestTeamsQuery.isPending ? (
                    <div className="inline-loading">
                      <Spin />
                    </div>
                  ) : contestTeamsQuery.isError ? (
                    contestTeamsQuery.error instanceof ApiError &&
                    contestTeamsQuery.error.status === 403 ? (
                      <div className="muted">
                        仅已报名团队成员与管理员可查看已报名团队。
                      </div>
                    ) : (
                      <div className="side-error">
                        <span className="muted">团队报名列表加载失败</span>
                        <Button
                          size="small"
                          onClick={() => void contestTeamsQuery.refetch()}
                        >
                          重试
                        </Button>
                      </div>
                    )
                  ) : (contestTeamsQuery.data ?? []).length === 0 ? (
                    <div className="muted">还没有团队报名</div>
                  ) : (
                    <div className="stack">
                      {(contestTeamsQuery.data ?? []).map((team) => (
                        <Space key={team.teamId} wrap>
                          <span>{team.name}</span>
                          <span className="muted">{team.members.length} 人</span>
                          <span className="muted">
                            {formatDateTime(team.registeredAt)}
                          </span>
                        </Space>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ) : null}

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
            {showAwardsEntry ? (
              <Button
                block
                className="side-action"
                onClick={() => navigate(`${contestPath}/awards`)}
              >
                {awardsReady ? '奖项/证书' : '奖项预览（管理员）'}
              </Button>
            ) : null}
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
