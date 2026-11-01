import { Alert, Button, Card, Empty, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { CorrectionCell, CorrectionRanking, CorrectionRankingRow } from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import { problemLetter, verdictTitle } from '../utils/status';
import { downloadCsv } from '../utils/ranking';

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function correctionCsv(data: CorrectionRanking): string {
  const header = [
    '排名',
    '用户名',
    '姓名',
    '班级',
    '官方总分',
    '订正总分',
    ...data.problems.flatMap((_problem, index) => [
      `${problemLetter(index)}官方`,
      `${problemLetter(index)}订正`,
    ]),
  ];
  const lines = data.rows.map((row) => [
    String(row.rank),
    row.username,
    row.realName ?? '',
    row.className ?? '未分班',
    String(row.officialTotal),
    String(row.correctedTotal),
    ...data.problems.flatMap((problem) => {
      const cell = row.cells.find((item) => item.problemId === problem.id);
      return [String(cell?.officialScore ?? 0), String(cell?.correctionScore ?? 0)];
    }),
  ]);
  return [header, ...lines]
    .map((line) => line.map((cell) => csvCell(cell)).join(','))
    .join('\r\n');
}

function CorrectionPair({ cell }: { cell: CorrectionCell | undefined }) {
  if (!cell) return <span className="correction-pair muted">— | —</span>;
  const official =
    cell.officialScore !== 0 || cell.officialVerdict !== null
      ? `${cell.officialScore}${cell.officialVerdict ? ` ${cell.officialVerdict}` : ''}`
      : '—';
  const correction =
    cell.correctionScore !== 0 || cell.correctionVerdict !== null
      ? `${cell.correctionScore}${cell.correctionVerdict ? ` ${cell.correctionVerdict}` : ''}`
      : '—';
  return (
    <span
      className={`correction-pair${
        cell.correctedScore > cell.officialScore ? ' correction-pair-changed' : ''
      }`}
      title={`官方 ${official}；订正 ${correction}；取较高 ${cell.correctedScore} 分${
        cell.correctedVerdict ? `（${verdictTitle(cell.correctedVerdict)}）` : ''
      }`}
    >
      <span className="correction-official">{official}</span>
      <span className="correction-sep">|</span>
      <span className="correction-after">{correction}</span>
    </span>
  );
}

export function ContestCorrectionPage() {
  const { contestId: contestIdParam } = useParams();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;

  const correctionQuery = useQuery({
    queryKey: ['correction-ranking', contestId],
    queryFn: () => apiGet<CorrectionRanking>(`/api/contests/${contestId}/correction-ranking`),
    enabled: validId,
    staleTime: 5_000,
  });

  if (!validId) {
    return <ErrorResult error={new Error('无效的比赛编号')} />;
  }
  if (correctionQuery.isPending) {
    return <PageLoading tip="正在加载订正榜…" />;
  }
  if (correctionQuery.isError) {
    return (
      <ErrorResult
        error={correctionQuery.error}
        onRetry={() => void correctionQuery.refetch()}
      />
    );
  }

  const data = correctionQuery.data;
  if (!data) {
    return <ErrorResult error={new Error('比赛不存在')} />;
  }
  const { contest, problems, rows, correctionsOpen, archived } = data;
  const correctedCount = rows.filter((row) =>
    row.cells.some((cell) => cell.correctionScore > 0),
  ).length;
  const officialTotal = rows.reduce((sum, row) => sum + row.officialTotal, 0);
  const correctedTotal = rows.reduce((sum, row) => sum + row.correctedTotal, 0);

  const statusTag = archived ? (
    <Tag color="red">已归档 · 只读</Tag>
  ) : correctionsOpen ? (
    <Tag color="green">订正开放</Tag>
  ) : (
    <Tag>未开放</Tag>
  );

  const baseColumns: TableColumnsType<CorrectionRankingRow> = [
    {
      title: '名次',
      dataIndex: 'rank',
      width: 64,
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
      title: '官方总分',
      dataIndex: 'officialTotal',
      width: 92,
      align: 'right',
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '订正总分',
      dataIndex: 'correctedTotal',
      width: 92,
      align: 'right',
      render: (value: number, row) => (
        <strong className={value > row.officialTotal ? 'correction-total-changed' : 'mono'}>
          {value}
        </strong>
      ),
    },
  ];

  const problemColumns: TableColumnsType<CorrectionRankingRow> = problems.map(
    (problem, index) => ({
      title: (
        <div className="rank-problem-head">
          <span>{problemLetter(index)}</span>
          <span className="muted rank-problem-title">{problem.title}</span>
          <span className="rank-problem-points">{problem.points} 分</span>
        </div>
      ),
      width: 132,
      align: 'center',
      render: (_value, row) => (
        <CorrectionPair cell={row.cells.find((cell) => cell.problemId === problem.id)} />
      ),
    }),
  );

  const trailingColumns: TableColumnsType<CorrectionRankingRow> = [
    {
      title: '官方 AC',
      dataIndex: 'officialSolved',
      width: 82,
      align: 'right',
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '订正 AC',
      dataIndex: 'correctedSolved',
      width: 82,
      align: 'right',
      render: (value: number) => <span className="mono">{value}</span>,
    },
  ];

  const exportCsv = () => {
    downloadCsv(`contest-${contestId}-correction-ranking.csv`, correctionCsv(data));
  };

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '比赛', to: '/contests' },
          { label: contest.name, to: `/contest/${contestId}` },
          { label: '订正榜' },
        ]}
        title={`${contest.name} · 订正榜`}
        tags={
          <>
            <Tag>{contest.mode.toUpperCase()}</Tag>
            {statusTag}
            {contest.end_at !== null ? (
              <Tag>结束 {formatDateTime(contest.end_at)}</Tag>
            ) : null}
          </>
        }
        subtitle="独立订正榜：每题取 max(官方分, 赛后最高分)；正式榜保持不变。"
        extra={
          <Space>
            <Button icon={<DownloadOutlined />} onClick={exportCsv}>
              导出 CSV
            </Button>
            <Link to={`/contest/${contestId}/ranking`}>
              <Button>正式榜</Button>
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
          message="比赛已归档，订正榜只读。"
          description="归档后不能继续提交订正；当前显示归档时的官方分与订正分。"
        />
      ) : !correctionsOpen ? (
        <Alert
          className="ranking-freeze"
          type="info"
          showIcon
          message="比赛尚未结束，订正榜未开放。"
          description="比赛结束后，参赛者的赛后提交会自动进入订正榜；当前仅显示官方成绩。"
        />
      ) : (
        <Alert
          className="ranking-freeze"
          type="success"
          showIcon
          message="订正开放：赛后提交只计入订正榜，不影响正式榜。"
        />
      )}

      <div className="correction-summary">
        <div className="correction-stat">
          <span className="correction-stat-value">{rows.length}</span>
          <span className="muted">参赛人数</span>
        </div>
        <div className="correction-stat">
          <span className="correction-stat-value">{correctedCount}</span>
          <span className="muted">订正人数</span>
        </div>
        <div className="correction-stat">
          <span className="correction-stat-value">{officialTotal}</span>
          <span className="muted">官方总分</span>
        </div>
        <div className="correction-stat">
          <span className="correction-stat-value">{correctedTotal}</span>
          <span className="muted">订正总分</span>
        </div>
      </div>

      <Card className="oij-card">
        {rows.length === 0 ? (
          <Empty description="暂无参赛者" />
        ) : (
          <Table<CorrectionRankingRow>
            className="oij-table rank-table correction-table"
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
