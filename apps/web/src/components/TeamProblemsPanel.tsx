import { Button, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ProblemSummary } from '../api/types';
import { ErrorResult, PageLoading } from './PageStates';
import { filterTeamProblems } from '../utils/teamProblems';
import { formatMemoryLimit, formatTimeLimit } from '../utils/format';
import { difficultyLabel, problemTypeLabel } from '../utils/status';
import '../styles/problem-sets.css';

/**
 * 团队详情“题目”Tab：展示该团队拥有的题目。
 *
 * 列表来自 GET /api/problems（已按题目 ACL 过滤），前端按 ownerType/ownerId 过滤出本团队；
 * 非团队成员/非管理员看不到团队题，因此这里只会看到空列表。
 */
export function TeamProblemsPanel({ teamId }: { teamId: number }) {
  const problemsQuery = useQuery({
    queryKey: ['problems'],
    queryFn: () => apiGet<ProblemSummary[]>('/api/problems'),
    staleTime: 60_000,
  });

  const teamProblems = filterTeamProblems(problemsQuery.data ?? [], teamId);

  const columns: TableColumnsType<ProblemSummary> = [
    {
      title: '题目',
      dataIndex: 'title',
      render: (_value, problem) => (
        <Link className="problem-link" to={`/problem/${problem.id}`}>
          {problem.title}
        </Link>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 120,
      render: (value: ProblemSummary['type']) => (
        <Tag bordered={false}>{problemTypeLabel(value)}</Tag>
      ),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 130,
      render: (value: number | null) => (
        <span className={`difficulty difficulty-${value ?? 0}`}>{difficultyLabel(value)}</span>
      ),
    },
    {
      title: '时间限制',
      dataIndex: 'timeMs',
      width: 110,
      render: (value: number) => <span className="mono">{formatTimeLimit(value)}</span>,
    },
    {
      title: '内存限制',
      dataIndex: 'memoryMb',
      width: 110,
      render: (value: number) => <span className="mono">{formatMemoryLimit(value)}</span>,
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div className="problem-set-toolbar">
        <span className="muted">
          共 {teamProblems.length} 道团队题目；点击题目名称进入题目页。
        </span>
        <Button
          icon={<ReloadOutlined />}
          loading={problemsQuery.isFetching}
          onClick={() => void problemsQuery.refetch()}
        >
          刷新
        </Button>
      </div>

      {problemsQuery.isPending ? (
        <PageLoading tip="正在加载团队题目…" />
      ) : problemsQuery.isError ? (
        <ErrorResult
          error={problemsQuery.error}
          onRetry={() => void problemsQuery.refetch()}
        />
      ) : (
        <Table<ProblemSummary>
          className="oij-table"
          rowKey="id"
          size="small"
          columns={columns}
          dataSource={teamProblems}
          pagination={false}
          locale={{
            emptyText: (
              <div className="problem-set-empty">
                <div>该团队还没有可见的题目。</div>
                <div className="muted">
                  题目归属团队后才会出现在这里；非团队成员与访客看不到团队题目。
                </div>
              </div>
            ),
          }}
        />
      )}
    </Space>
  );
}
