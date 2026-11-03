import { useState } from 'react';
import { Button, Space } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ProblemSetSummary } from '../api/types';
import { ErrorResult, PageLoading } from './PageStates';
import { ProblemSetCreateModal } from './ProblemSetCreateModal';
import { ProblemSetTable } from './ProblemSetTable';
import '../styles/problem-sets.css';

/**
 * 团队详情“题单”Tab：展示当前账号可见的该团队题单。
 *
 * 列表来自 GET /api/problem-sets（已按 ACL 过滤），前端按 ownerType/ownerId 过滤出本团队；
 * 私有团队题单不会出现在非成员的结果中。
 */
export function TeamProblemSetsPanel({
  teamId,
  teamName,
  canCreate,
  currentUserId,
}: {
  teamId: number;
  teamName: string;
  canCreate: boolean;
  currentUserId?: number;
}) {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const setsQuery = useQuery({
    queryKey: ['problem-sets'],
    queryFn: () => apiGet<ProblemSetSummary[]>('/api/problem-sets'),
  });

  const teamSets = (setsQuery.data ?? []).filter(
    (set) => set.ownerType === 'team' && set.ownerId === teamId,
  );

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div className="problem-set-toolbar">
        <span className="muted">
          共 {teamSets.length} 个团队题单
          {canCreate ? '；团队题单只有队长可以创建、编辑和分享。' : '。'}
        </span>
        {canCreate ? (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            创建团队题单
          </Button>
        ) : null}
      </div>

      {setsQuery.isPending ? (
        <PageLoading tip="正在加载团队题单…" />
      ) : setsQuery.isError ? (
        <ErrorResult error={setsQuery.error} onRetry={() => void setsQuery.refetch()} />
      ) : (
        <ProblemSetTable
          sets={teamSets}
          currentUserId={currentUserId}
          showOwner={false}
          emptyText={
            <div className="problem-set-empty">
              <div>该团队还没有{canCreate ? '' : '可见的'}题单。</div>
              <div className="muted">
                {canCreate
                  ? '点击右上角“创建团队题单”，把团队训练题目组织在一起。'
                  : '团队题单创建后会显示在这里（公开题单所有登录用户可读）。'}
              </div>
            </div>
          }
        />
      )}

      <ProblemSetCreateModal
        open={createOpen}
        teams={[]}
        fixedOwner={{ ownerId: teamId, name: teamName }}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => navigate(`/problem-sets/${id}`)}
      />
    </Space>
  );
}
