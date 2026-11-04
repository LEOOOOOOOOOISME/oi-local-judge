import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type {
  OfficialRanking,
  OfficialRankingRow,
  TeamRankingRow,
  Verdict,
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
import {
  buildOfficialRankingCsv,
  fetchOfficialRanking,
  presetLabel,
} from '../utils/officialRanking';
import { downloadCsv } from '../utils/ranking';
import {
  buildTeamRankingCsv,
  resolveTeamMode,
  teamModeLabel,
} from '../utils/teamContest';

const PHASE_COLOR: Record<ContestPhase, string> = {
  upcoming: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

type RankingView = 'individual' | 'team';

interface RankCellData {
  score: number;
  verdict: Verdict | null;
  attempts: number;
}

function RankCell({ cell }: { cell: RankCellData | undefined }) {
  if (!cell || (cell.score === 0 && cell.verdict === null)) {
    return <span className="official-cell official-cell-empty">—</span>;
  }
  const kind = cell.verdict === 'AC' ? 'ac' : cell.verdict ? 'partial' : 'empty';
  return (
    <span
      className={`official-cell official-cell-${kind}`}
      title={`${cell.verdict ? verdictTitle(cell.verdict) : '未通过'} · ${cell.score} 分${
        cell.attempts > 0 ? ` · ${cell.attempts} 次提交` : ''
      }`}
    >
      <span className="official-cell-score">{cell.score}</span>
      <span className="official-cell-verdict">{cell.verdict ?? '—'}</span>
    </span>
  );
}

export function ContestRankingPage() {
  const { contestId: contestIdParam } = useParams();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const now = useNow(1000);
  const { message } = App.useApp();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<RankingView>(
    searchParams.get('view') === 'team' ? 'team' : 'individual',
  );

  useEffect(() => {
    if (searchParams.get('view') === 'team') setView('team');
  }, [searchParams]);

  const rankingQuery = useQuery({
    queryKey: ['official-ranking', contestId],
    queryFn: () => fetchOfficialRanking(contestId),
    enabled: validId,
    staleTime: 5_000,
    retry: false,
  });

  const data: OfficialRanking | undefined = rankingQuery.data;
  const contest = data?.contest ?? null;
  const teamMode = resolveTeamMode(contest);
  const teamEnabled = teamMode !== 'individual';
  const activeView: RankingView = teamEnabled ? view : 'individual';

  // 团队榜只在团队模式且切换到团队视图时请求，个人榜保持默认行为不变。
  const teamRankingQuery = useQuery({
    queryKey: ['team-ranking', contestId],
    queryFn: () => apiGet<TeamRankingRow[]>(`/api/contests/${contestId}/team-ranking`),
    enabled: validId && teamEnabled && activeView === 'team',
    staleTime: 5_000,
    retry: false,
  });

  const rows = data?.rows ?? [];
  const problems = data?.problems ?? [];
  const archived = data?.archived ?? false;
  const preset = data?.preset ?? 'oi';
  const phase = contest ? contestPhase(contest, now) : 'ended';
  const isAcm = preset === 'acm' || preset === 'cf-like';
  const freezeAt = data?.config.freezeAt ?? null;
  const frozen = phase === 'frozen' || freezeAt !== null;
  const officialFrozenUntil = data?.officialFrozenUntil ?? null;
  const officialFrozen = officialFrozenUntil !== null && officialFrozenUntil > now;
  const officialFrozenText =
    officialFrozenUntil !== null
      ? new Date(officialFrozenUntil).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
      : null;
  const teamRows = teamRankingQuery.data ?? [];

  if (!validId) {
    return <ErrorResult error={new Error('无效的比赛编号')} />;
  }
  if (rankingQuery.isPending) {
    return <PageLoading tip="正在加载正式榜…" />;
  }
  if (rankingQuery.isError) {
    return (
      <ErrorResult
        error={rankingQuery.error}
        onRetry={() => void rankingQuery.refetch()}
      />
    );
  }
  if (!data || !contest) {
    return <ErrorResult error={new Error('比赛不存在')} />;
  }

  const handleViewChange = (next: RankingView) => {
    setView(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'team') params.set('view', 'team');
    else params.delete('view');
    setSearchParams(params, { replace: true });
  };

  const baseColumns: TableColumnsType<OfficialRankingRow> = [
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
          <span className="rank-user-name">
            {row.realName ?? row.username}
            {row.hackedCount > 0 ? (
              <Tooltip title={`被 Hack 提交数：${row.hackedCount}`}>
                <Tag color="red" className="rank-hacked-tag">
                  HACKED×{row.hackedCount}
                </Tag>
              </Tooltip>
            ) : null}
          </span>
          <span className="rank-user-meta muted">@{row.username}</span>
        </div>
      ),
    },
    {
      title: '班级',
      dataIndex: 'className',
      width: 120,
      render: (value: string | null) =>
        value ? <span>{value}</span> : <span className="muted">未分班</span>,
    },
    {
      title: '总分',
      dataIndex: 'totalScore',
      width: 84,
      align: 'right',
      render: (value: number) => <strong className="rank-total">{value}</strong>,
    },
  ];

  const problemColumns: TableColumnsType<OfficialRankingRow> = problems.map((problem, index) => ({
    title: (
      <div className="rank-problem-head">
        <span>{problemLetter(index)}</span>
        <span className="muted rank-problem-title">{problem.title}</span>
        <span className="rank-problem-points">{problem.points} 分</span>
      </div>
    ),
    width: 108,
    align: 'center',
    render: (_value, row) => (
      <RankCell cell={row.cells.find((cell) => cell.problemId === problem.id)} />
    ),
  }));

  const trailingColumns: TableColumnsType<OfficialRankingRow> = [
    {
      title: '成功 Hack',
      dataIndex: 'successfulHacks',
      width: 96,
      align: 'right',
      render: (value: number) =>
        value > 0 ? (
          <span className="mono hack-success-count">{value}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    ...(preset === 'cf-like'
      ? [
          {
            title: 'Hack 分',
            dataIndex: 'hackScore' as const,
            width: 86,
            align: 'right' as const,
            render: (value: number | undefined) =>
              value === undefined ? (
                <span className="muted">—</span>
              ) : (
                <span className={value < 0 ? 'correction-total-changed mono' : 'mono'}>
                  {value > 0 ? `+${value}` : value}
                </span>
              ),
          },
        ]
      : []),
    {
      title: isAcm ? '罚时' : 'AC 数',
      width: 82,
      align: 'right',
      render: (_value, row) => (
        <span className="mono">{isAcm ? row.penalty : row.solved}</span>
      ),
    },
    {
      title: '最后 AC',
      dataIndex: 'lastAcAt',
      width: 156,
      render: (value: number | null) =>
        value === null ? (
          <span className="muted">—</span>
        ) : (
          <span className="mono">{formatDateTime(value)}</span>
        ),
    },
  ];

  const teamBaseColumns: TableColumnsType<TeamRankingRow> = [
    {
      title: '排名',
      dataIndex: 'rank',
      width: 64,
      align: 'center',
      render: (rank: number) => <span className={`rank-no rank-no-${rank}`}>{rank}</span>,
    },
    {
      title: '团队',
      dataIndex: 'teamName',
      width: 220,
      render: (value: string, row) => (
        <div className="rank-user">
          <span className="rank-user-name">{value}</span>
          <span className="rank-user-meta muted">团队 #{row.teamId}</span>
        </div>
      ),
    },
    {
      title: '成员数',
      dataIndex: 'memberCount',
      width: 90,
      align: 'right',
      render: (value: number) => <span className="mono">{value}</span>,
    },
  ];

  // ACM/CF-like 团队榜按过题数与罚时排序；OI/IOI 仍看每题最高分求和。
  const teamScoreColumns: TableColumnsType<TeamRankingRow> = isAcm
    ? [
        {
          title: '通过题数',
          dataIndex: 'solved',
          width: 82,
          align: 'right',
          render: (value: number) => <span className="mono">{value}</span>,
        },
        {
          title: '罚时',
          dataIndex: 'penalty',
          width: 82,
          align: 'right',
          render: (value: number) => <span className="mono">{value}</span>,
        },
      ]
    : [
        {
          title: '总分',
          dataIndex: 'totalScore',
          width: 84,
          align: 'right',
          render: (value: number) => <strong className="rank-total">{value}</strong>,
        },
        {
          title: 'AC 数',
          dataIndex: 'solved',
          width: 82,
          align: 'right',
          render: (value: number) => <span className="mono">{value}</span>,
        },
      ];

  const teamProblemColumns: TableColumnsType<TeamRankingRow> = problems.map(
    (problem, index) => ({
      title: (
        <div className="rank-problem-head">
          <span>{problemLetter(index)}</span>
          <span className="muted rank-problem-title">{problem.title}</span>
          <span className="rank-problem-points">{problem.points} 分</span>
        </div>
      ),
      width: 108,
      align: 'center',
      render: (_value, row) => (
        <RankCell cell={row.cells.find((cell) => cell.problemId === problem.id)} />
      ),
    }),
  );

  const teamTrailingColumns: TableColumnsType<TeamRankingRow> = [
    ...(preset === 'cf-like'
      ? [
          {
            title: 'Hack 分',
            dataIndex: 'hackScore' as const,
            width: 86,
            align: 'right' as const,
            render: (value: number | undefined) =>
              value === undefined ? (
                <span className="muted">—</span>
              ) : (
                <span className={value < 0 ? 'correction-total-changed mono' : 'mono'}>
                  {value > 0 ? `+${value}` : value}
                </span>
              ),
          },
        ]
      : []),
    {
      title: '最后 AC',
      dataIndex: 'lastAcAt',
      width: 156,
      render: (value: number | null) =>
        value === null ? (
          <span className="muted">—</span>
        ) : (
          <span className="mono">{formatDateTime(value)}</span>
        ),
    },
  ];

  const exportCsv = () => {
    if (activeView === 'team') {
      if (teamRows.length === 0) {
        message.warning('暂无团队榜单数据可导出');
        return;
      }
      downloadCsv(
        `contest-${contestId}-team-ranking.csv`,
        buildTeamRankingCsv(problems, teamRows, isAcm),
      );
      message.success('团队榜 CSV 已导出');
      return;
    }
    if (rows.length === 0) {
      message.warning('暂无榜单数据可导出');
      return;
    }
    downloadCsv(
      `contest-${contestId}-official-ranking.csv`,
      buildOfficialRankingCsv(data),
    );
    message.success('正式榜 CSV 已导出');
  };

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '比赛', to: '/contests' },
          { label: contest.name, to: `/contest/${contestId}` },
          { label: activeView === 'team' ? '团队榜' : '正式榜' },
        ]}
        title={`${contest.name} · ${activeView === 'team' ? '团队榜' : '正式榜'}`}
        tags={
          <>
            <Tag color="geekblue">{presetLabel(preset)}</Tag>
            <Tag>{contestModeLabel(contest.mode)}</Tag>
            {teamEnabled ? <Tag color="purple">{teamModeLabel(teamMode)}</Tag> : null}
            <Tag color={PHASE_COLOR[phase]}>{CONTEST_PHASE_LABEL[phase]}</Tag>
            {archived ? <Tag color="red">已归档 · 只读</Tag> : null}
            {frozen ? <Tag color="gold">封榜中</Tag> : null}
          </>
        }
        subtitle={
          activeView === 'team'
            ? isAcm
              ? `${presetLabel(preset)}：团队榜按通过题数与罚时排序，仅统计已报名团队。`
              : '团队榜：每题取团队成员最佳得分后求和，仅统计已报名团队。'
            : isAcm
              ? `${presetLabel(preset)}：按通过题数与罚时排序，正式榜数据只读。`
              : `${presetLabel(preset)}：每题取正式得分，总分降序；正式榜数据只读。`
        }
        extra={
          <Space wrap>
            {teamEnabled ? (
              <Segmented<RankingView>
                value={activeView}
                onChange={handleViewChange}
                options={[
                  { value: 'individual', label: '个人榜' },
                  { value: 'team', label: '团队榜' },
                ]}
              />
            ) : null}
            <Button icon={<DownloadOutlined />} onClick={exportCsv}>
              导出 CSV
            </Button>
            <Link to={`/contest/${contestId}/screen`}>
              <Button>大屏</Button>
            </Link>
            <Link to={`/contest/${contestId}/correction`}>
              <Button>订正榜</Button>
            </Link>
            <Link to={`/contest/${contestId}`}>
              <Button>返回比赛</Button>
            </Link>
          </Space>
        }
      />

      {archived ? (
        <Alert
          className="ranking-freeze"
          type="warning"
          showIcon
          message="比赛已归档，当前为只读榜单快照。"
          description="归档后不接受榜单订正；如需修改请联系管理员解除归档。"
        />
      ) : null}
      {frozen ? (
        <Alert
          className="ranking-freeze"
          type="info"
          showIcon
          message={`榜单已按封榜时间 ${
            freezeAt !== null
              ? formatDateTime(freezeAt)
              : contest.freeze_at !== null
                ? formatDateTime(contest.freeze_at)
                : '—'
          } 过滤，封榜后的提交暂不计入。`}
        />
      ) : null}
      {officialFrozen ? (
        <Alert
          className="ranking-freeze"
          type="warning"
          showIcon
          message={`官方分冻结至 ${officialFrozenText}（Hack 审核窗口）`}
          description="冻结期间正式分不更新，批量发布会被拒绝；窗口结束后恢复。"
        />
      ) : null}

      {activeView === 'team' ? (
        <Card className="oij-card">
          {teamRankingQuery.isPending ? (
            <div className="inline-loading">
              <Spin />
            </div>
          ) : teamRankingQuery.isError ? (
            <ErrorResult
              error={teamRankingQuery.error}
              onRetry={() => void teamRankingQuery.refetch()}
            />
          ) : teamRows.length === 0 ? (
            <Empty description="暂无已报名团队" />
          ) : (
            <Table<TeamRankingRow>
              className="oij-table rank-table"
              rowKey="teamId"
              size="small"
              columns={[
                ...teamBaseColumns,
                ...teamProblemColumns,
                ...teamScoreColumns,
                ...teamTrailingColumns,
              ]}
              dataSource={teamRows}
              pagination={false}
              scroll={{ x: 'max-content' }}
            />
          )}
        </Card>
      ) : (
        <Card className="oij-card">
          {rows.length === 0 ? (
            <Empty description="暂无参赛者" />
          ) : (
            <Table<OfficialRankingRow>
              className="oij-table rank-table"
              rowKey="userId"
              size="small"
              columns={[...baseColumns, ...problemColumns, ...trailingColumns]}
              dataSource={rows}
              pagination={false}
              scroll={{ x: 'max-content' }}
            />
          )}
        </Card>
      )}
    </div>
  );
}
