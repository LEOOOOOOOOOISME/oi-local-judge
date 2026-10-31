import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ProblemSummary } from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { ProblemListTable } from '../components/ProblemListTable';

export function ProblemsPage() {
  const problemsQuery = useQuery({
    queryKey: ['problems'],
    queryFn: () => apiGet<ProblemSummary[]>('/api/problems'),
    staleTime: 60_000,
  });

  if (problemsQuery.isPending) return <PageLoading tip="正在加载题目…" />;
  if (problemsQuery.isError) {
    return <ErrorResult error={problemsQuery.error} onRetry={() => void problemsQuery.refetch()} />;
  }

  const problems = problemsQuery.data ?? [];

  return (
    <div>
      <PageHead
        title="题目"
        subtitle="题库中的公开题目，可直接提交练习。"
        extra={<span className="muted">共 {problems.length} 题</span>}
      />
      <ProblemListTable problems={problems} problemPath={(id) => `/problem/${id}`} emptyText="暂无公开题目" />
    </div>
  );
}
