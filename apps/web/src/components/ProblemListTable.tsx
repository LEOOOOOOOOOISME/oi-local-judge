import { Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import type { ProblemSummary, Verdict } from '../api/types';
import { formatMemoryLimit, formatTimeLimit } from '../utils/format';
import { difficultyLabel } from '../utils/status';
import { VerdictBadge } from './VerdictBadge';

export interface ProblemScore {
  score: number;
  verdict: Verdict | null;
}

export function ProblemListTable({
  problems,
  problemPath,
  letters,
  scores,
  showScore = false,
  emptyText = '暂无题目',
}: {
  problems: ProblemSummary[];
  problemPath: (problemId: number) => string;
  letters?: Map<number, string>;
  scores?: Map<number, ProblemScore>;
  showScore?: boolean;
  emptyText?: string;
}) {
  const columns: TableColumnsType<ProblemSummary> = [
    {
      title: '编号',
      dataIndex: 'id',
      width: 64,
      render: (_value, record) => (
        <span className="problem-no">{letters?.get(record.id) ?? `#${record.id}`}</span>
      ),
    },
    {
      title: '题目名称',
      dataIndex: 'title',
      render: (_value, record) => (
        <Link className="problem-link" to={problemPath(record.id)}>
          {record.title}
        </Link>
      ),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 118,
      render: (value: number | null) => (
        <span className={`difficulty difficulty-${value ?? 0}`}>{difficultyLabel(value)}</span>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 176,
      render: (tags: string[]) =>
        tags.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <span className="tag-list">
            {tags.map((tag) => (
              <Tag key={tag} bordered={false}>
                {tag}
              </Tag>
            ))}
          </span>
        ),
    },
    {
      title: '时间限制',
      dataIndex: 'timeMs',
      width: 96,
      render: (value: number) => formatTimeLimit(value),
    },
    {
      title: '内存限制',
      dataIndex: 'memoryMb',
      width: 96,
      render: (value: number) => formatMemoryLimit(value),
    },
  ];

  if (showScore) {
    columns.push({
      title: '我的得分',
      width: 96,
      align: 'center',
      render: (_value, record) => {
        const score = scores?.get(record.id);
        if (!score) return <span className="muted">—</span>;
        return (
          <span className="score-cell">
            <VerdictBadge verdict={score.verdict} />
            <span className="score-cell-value">{score.score}</span>
          </span>
        );
      },
    });
  }

  return (
    <Table<ProblemSummary>
      className="oij-table"
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={problems}
      pagination={false}
      locale={{ emptyText }}
    />
  );
}
