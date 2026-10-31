import { Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import type { Submission } from '../api/types';
import { formatMemoryKb, formatRunTime, formatDateTime } from '../utils/format';
import { SubmissionStatusBadge } from './VerdictBadge';

export function SubmissionTable({
  submissions,
  problemPath = (problemId) => `/problem/${problemId}`,
  problemTitles,
  showContest = false,
  emptyText = '暂无提交',
}: {
  submissions: Submission[];
  problemPath?: (problemId: number) => string;
  problemTitles?: Map<number, string>;
  showContest?: boolean;
  emptyText?: string;
}) {
  const columns: TableColumnsType<Submission> = [
    {
      title: '提交号',
      dataIndex: 'id',
      width: 82,
      render: (_value, record) => (
        <Link className="mono" to={`/submissions/${record.id}`}>
          #{record.id}
        </Link>
      ),
    },
    {
      title: '题目',
      dataIndex: 'problemId',
      render: (_value, record) => (
        <Link to={problemPath(record.problemId)}>
          {problemTitles?.get(record.problemId) ?? `#${record.problemId}`}
        </Link>
      ),
    },
  ];

  if (showContest) {
    columns.push({
      title: '比赛',
      dataIndex: 'contestId',
      width: 90,
      render: (contestId: number | null) =>
        contestId === null ? (
          <span className="muted">练习</span>
        ) : (
          <Link to={`/contest/${contestId}`}>#{contestId}</Link>
        ),
    });
  }

  columns.push(
    {
      title: '状态',
      dataIndex: 'status',
      width: 92,
      render: (_value, record) => (
        <SubmissionStatusBadge status={record.status} verdict={record.verdict} />
      ),
    },
    {
      title: '分数',
      dataIndex: 'score',
      width: 70,
      align: 'right',
      render: (score: number) => <span className="score-value">{score}</span>,
    },
    {
      title: '用时',
      dataIndex: 'timeMs',
      width: 84,
      align: 'right',
      render: (value: number) => formatRunTime(value),
    },
    {
      title: '内存',
      dataIndex: 'memoryKb',
      width: 90,
      align: 'right',
      render: (value: number) => formatMemoryKb(value),
    },
    {
      title: '提交时间',
      dataIndex: 'createdAt',
      width: 158,
      render: (value: string) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '',
      width: 58,
      align: 'center',
      render: (_value, record) => <Link to={`/submissions/${record.id}`}>查看</Link>,
    },
  );

  return (
    <Table<Submission>
      className="oij-table"
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={submissions}
      pagination={false}
      locale={{ emptyText }}
    />
  );
}
