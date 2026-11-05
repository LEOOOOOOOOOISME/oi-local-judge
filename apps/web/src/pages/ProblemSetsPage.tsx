import { useMemo, useState } from 'react';
import { Button, Card, Segmented, Space } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ProblemSetSummary, TeamSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { ProblemSetCreateModal } from '../components/ProblemSetCreateModal';
import { ProblemSetTable } from '../components/ProblemSetTable';
import {
  PROBLEM_SET_FILTER_OPTIONS,
  filterProblemSets,
  type ProblemSetFilter,
} from '../utils/problemSets';
import '../styles/problem-sets.css';

export function ProblemSetsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<ProblemSetFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);

  const setsQuery = useQuery({
    queryKey: ['problem-sets'],
    queryFn: () => apiGet<ProblemSetSummary[]>('/api/problem-sets'),
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
  });

  const teamNames = useMemo(
    () => new Map((teamsQuery.data ?? []).map((team) => [team.id, team.name] as const)),
    [teamsQuery.data],
  );
  const sets = setsQuery.data ?? [];
  const visibleSets = filterProblemSets(sets, filter);

  const emptyText =
    sets.length === 0 ? (
      <div className="problem-set-empty">
        <div>还没有可见的题单。</div>
        <div className="muted">
          创建个人或团队题单，把需要练习的题目组织在一起；也可以等待他人分享。
        </div>
      </div>
    ) : (
      <div className="problem-set-empty muted">当前筛选下没有题单。</div>
    );

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '首页', to: '/contests' }, { label: '题单' }]}
        title="题单"
        subtitle="个人或团队题单：支持私有/公开，可分享给用户或团队（只读/可编辑）。"
        extra={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={setsQuery.isFetching}
              onClick={() => void setsQuery.refetch()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreateOpen(true)}
            >
              创建题单
            </Button>
          </Space>
        }
      />

      <Card
        className="oij-card"
        title="我的题单"
        extra={
          <Space wrap size={12}>
            <span className="muted">共 {sets.length} 个</span>
            <Segmented<ProblemSetFilter>
              size="small"
              value={filter}
              onChange={(value) => setFilter(value)}
              options={PROBLEM_SET_FILTER_OPTIONS}
            />
          </Space>
        }
      >
        {setsQuery.isPending ? (
          <PageLoading tip="正在加载题单…" />
        ) : setsQuery.isError ? (
          <ErrorResult error={setsQuery.error} onRetry={() => void setsQuery.refetch()} />
        ) : (
          <ProblemSetTable
            sets={visibleSets}
            teamNames={teamNames}
            currentUserId={user?.id}
            emptyText={emptyText}
          />
        )}
      </Card>

      <ProblemSetCreateModal
        open={createOpen}
        teams={teamsQuery.data ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => navigate(`/problem-sets/${id}`)}
      />
    </div>
  );
}
