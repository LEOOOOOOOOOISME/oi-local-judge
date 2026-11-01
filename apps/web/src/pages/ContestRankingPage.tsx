import { Alert, App, Button, Card, Empty, Space, Table, Tag, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { OfficialRanking, OfficialRankingCell, OfficialRankingRow } from '../api/types';
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

const PHASE_COLOR: Record<ContestPhase, string> = {
  upcoming: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

function OfficialCell({ cell }: { cell: OfficialRankingCell | undefined }) {
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

  const rankingQuery = useQuery({
    queryKey: ['official-ranking', contestId],
    queryFn: () => fetchOfficialRanking(contestId),
    enabled: validId,
    staleTime: 5_000,
    retry: false,
  });

  const data: OfficialRanking | undefined = rankingQuery.data;
  const contest = data?.contest ?? null;
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
      <OfficialCell cell={row.cells.find((cell) => cell.problemId === problem.id)} />
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

  const exportCsv = () => {
    if (!data || rows.length === 0) {
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
          { label: '正式榜' },
        ]}
        title={`${contest.name} · 正式榜`}
        tags={
          <>
            <Tag color="geekblue">{presetLabel(preset)}</Tag>
            <Tag>{contestModeLabel(contest.mode)}</Tag>
            <Tag color={PHASE_COLOR[phase]}>{CONTEST_PHASE_LABEL[phase]}</Tag>
            {archived ? <Tag color="red">已归档 · 只读</Tag> : null}
            {frozen ? <Tag color="gold">封榜中</Tag> : null}
          </>
        }
        subtitle={
          isAcm
            ? `${presetLabel(preset)}：按通过题数与罚时排序，正式榜数据只读。`
            : `${presetLabel(preset)}：每题取正式得分，总分降序；正式榜数据只读。`
        }
        extra={
          <Space>
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
          message="比赛已归档，当前为只读正式榜快照。"
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
    </div>
  );
}
