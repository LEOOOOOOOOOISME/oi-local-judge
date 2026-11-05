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
        subtitle="按你的权限可见的题目：公开题、自己的题目以及分享给你的题目。"
        extra={<span className="muted">共 {problems.length} 题</span>}
      />
      <ProblemListTable problems={problems} problemPath={(id) => `/problem/${id}`} emptyText="暂无公开题目" />
    </div>
  );
}
