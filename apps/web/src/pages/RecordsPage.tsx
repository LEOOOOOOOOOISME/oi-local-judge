import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Select, Space, Spin } from 'antd';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ProblemSummary, Submission } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult } from '../components/PageStates';
import { SubmissionTable } from '../components/SubmissionTable';

const PAGE_SIZE = 20;

export function RecordsPage() {
  const { user } = useAuth();
  const [page, setPage] = useState(0);
  const [cursorStack, setCursorStack] = useState<Array<number | undefined>>([undefined]);
  const [problemFilter, setProblemFilter] = useState<number | undefined>(undefined);

  useEffect(() => {
    setPage(0);
    setCursorStack([undefined]);
  }, [problemFilter]);

  const beforeId = cursorStack[page];
  const recordsQuery = useQuery({
    queryKey: [
      'submissions',
      { scope: 'mine', problemId: problemFilter ?? null, beforeId: beforeId ?? null, limit: PAGE_SIZE },
    ],
    queryFn: () => {
      const params = new URLSearchParams({ userId: 'me', limit: String(PAGE_SIZE) });
      if (problemFilter !== undefined) params.set('problemId', String(problemFilter));
      if (beforeId !== undefined) params.set('beforeId', String(beforeId));
      return apiGet<Submission[]>(`/api/submissions?${params.toString()}`);
    },
    enabled: Boolean(user),
  });
  const problemsQuery = useQuery({
    queryKey: ['problems'],
    queryFn: () => apiGet<ProblemSummary[]>('/api/problems'),
    staleTime: 60_000,
  });

  const rows = recordsQuery.data ?? [];
  const problemTitles = useMemo(
    () => new Map((problemsQuery.data ?? []).map((problem) => [problem.id, problem.title])),
    [problemsQuery.data],
  );

  const goNext = () => {
    if (rows.length < PAGE_SIZE) return;
    const last = rows[rows.length - 1];
    setCursorStack((previous) => {
      const next = [...previous];
      next[page + 1] = last.id;
      return next;
    });
    setPage((previous) => previous + 1);
  };

  const goPrevious = () => {
    if (page === 0) return;
    setPage((previous) => Math.max(0, previous - 1));
  };

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '首页', to: '/contests' }, { label: '我的记录' }]}
        title="我的记录"
        subtitle="按提交时间倒序排列，使用提交号游标分页（每页 20 条）。"
        extra={
          <Space>
            <Select<number>
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="按题目筛选"
              style={{ width: 240 }}
              value={problemFilter}
              onChange={(value) => setProblemFilter(value)}
              options={(problemsQuery.data ?? []).map((problem) => ({
                value: problem.id,
                label: `#${problem.id} ${problem.title}`,
              }))}
            />
            <Link to="/problems">
              <Button>去刷题</Button>
            </Link>
          </Space>
        }
      />

      <Card className="oij-card">
        {recordsQuery.isPending ? (
          <div className="inline-loading">
            <Spin />
          </div>
        ) : recordsQuery.isError ? (
          <ErrorResult error={recordsQuery.error} onRetry={() => void recordsQuery.refetch()} />
        ) : (
          <>
            <SubmissionTable
              submissions={rows}
              problemTitles={problemTitles}
              showContest
              emptyText={
                problemFilter === undefined ? '还没有提交记录' : '该题目下还没有提交记录'
              }
            />
            <div className="table-footer">
              <span className="muted">
                第 {page + 1} 页 · 本页 {rows.length} 条
              </span>
              <Space>
                <Button size="small" disabled={page === 0} onClick={goPrevious}>
                  上一页
                </Button>
                <Button size="small" disabled={rows.length < PAGE_SIZE} onClick={goNext}>
                  下一页
                </Button>
              </Space>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
