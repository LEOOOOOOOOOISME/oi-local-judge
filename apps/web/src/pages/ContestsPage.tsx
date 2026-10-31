import { Button, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { Contest } from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { useNow } from '../hooks/useNow';
import { formatDateTime } from '../utils/format';
import {
  CONTEST_PHASE_LABEL,
  contestCountdownText,
  contestModeLabel,
  contestPhase,
  type ContestPhase,
} from '../utils/status';

const PHASE_COLOR: Record<ContestPhase, string> = {
  upcoming: 'default',
  running: 'blue',
  frozen: 'gold',
  ended: 'default',
};

export function ContestsPage() {
  const now = useNow(1000);
  const contestsQuery = useQuery({
    queryKey: ['contests'],
    queryFn: () => apiGet<Contest[]>('/api/contests'),
    staleTime: 15_000,
  });

  if (contestsQuery.isPending) return <PageLoading tip="正在加载比赛…" />;
  if (contestsQuery.isError) {
    return <ErrorResult error={contestsQuery.error} onRetry={() => void contestsQuery.refetch()} />;
  }

  const contests = contestsQuery.data ?? [];

  const columns: TableColumnsType<Contest> = [
    {
      title: '比赛名称',
      dataIndex: 'name',
      render: (_value, record) => (
        <span>
          <Link className="contest-link" to={`/contest/${record.id}`}>
            {record.name}
          </Link>
          <span className="muted mono"> #{record.id}</span>
        </span>
      ),
    },
    {
      title: '状态',
      width: 86,
      render: (_value, record) => {
        const phase = contestPhase(record, now);
        return <Tag color={PHASE_COLOR[phase]}>{CONTEST_PHASE_LABEL[phase]}</Tag>;
      },
    },
    {
      title: '倒计时',
      width: 168,
      render: (_value, record) => (
        <span className="countdown-inline">{contestCountdownText(record, now)}</span>
      ),
    },
    {
      title: '赛制',
      dataIndex: 'mode',
      width: 80,
      render: (mode: string) => contestModeLabel(mode),
    },
    {
      title: '开始时间',
      dataIndex: 'start_at',
      width: 158,
      render: (value: number | null) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '结束时间',
      dataIndex: 'end_at',
      width: 158,
      render: (value: number | null) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '',
      width: 74,
      align: 'center',
      render: (_value, record) => (
        <Link to={`/contest/${record.id}`}>
          <Button size="small">进入</Button>
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        title="比赛"
        subtitle="OI 赛制比赛列表，按创建顺序倒序排列。"
        extra={<span className="muted">共 {contests.length} 场</span>}
      />
      <Table<Contest>
        className="oij-table"
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={contests}
        pagination={false}
        locale={{ emptyText: '暂无比赛' }}
      />
    </div>
  );
}
