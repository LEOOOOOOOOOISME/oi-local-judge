import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  InputNumber,
  Popconfirm,
  Select,
  Tag,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPost } from '../api/client';
import type {
  AddProblemShareRequest,
  ProblemGranteeType,
  ProblemShare,
  ProblemSharePermission,
  TeamSummary,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import {
  PROBLEM_GRANTEE_TYPE_LABEL,
  PROBLEM_SHARE_PERMISSION_LABEL,
  PROBLEM_SHARE_PERMISSION_OPTIONS,
  describeProblemAclError,
} from '../utils/problemAcl';
import '../styles/problem-shares.css';

const GRANTEE_OPTIONS: Array<{ value: ProblemGranteeType; label: string }> = [
  { value: 'user', label: PROBLEM_GRANTEE_TYPE_LABEL.user },
  { value: 'team', label: PROBLEM_GRANTEE_TYPE_LABEL.team },
];

function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 403 || error.status === 404)
  );
}

/**
 * 题目分享卡片（用户 / 团队，read / edit）。
 *
 * 组件自身通过 `GET /api/problems/:id/shares` 探测管理权限：只有管理员、题目
 * 所有者或团队队长能拿到分享列表；其余用户（包括被分享的只读用户）得到 403/404，
 * 此时组件不渲染任何内容，与“只读用户不显示分享”的要求一致。
 */
export function ProblemSharePanel({
  problemId,
  enabled = true,
}: {
  problemId: number;
  enabled?: boolean;
}) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [granteeType, setGranteeType] = useState<ProblemGranteeType>('user');
  const [granteeId, setGranteeId] = useState<number | null>(null);
  const [permission, setPermission] = useState<ProblemSharePermission>('read');

  const sharesQuery = useQuery({
    queryKey: ['problem-shares', problemId],
    queryFn: () => apiGet<ProblemShare[]>(`/api/problems/${problemId}/shares`),
    enabled: enabled && Boolean(user) && problemId > 0,
    retry: false,
    staleTime: 15_000,
  });
  const canManage = sharesQuery.isSuccess;

  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
    enabled: canManage,
    staleTime: 60_000,
  });
  const teams = teamsQuery.data ?? [];
  const teamNames = useMemo(
    () => new Map(teams.map((team) => [team.id, team.name] as const)),
    [teams],
  );

  const invalidateShares = () => {
    void queryClient.invalidateQueries({ queryKey: ['problem-shares', problemId] });
  };

  const addMutation = useMutation({
    mutationFn: (body: AddProblemShareRequest) =>
      apiPost<null>(`/api/problems/${problemId}/shares`, body),
    onSuccess: () => {
      message.success('分享已添加');
      setGranteeId(null);
      invalidateShares();
    },
    onError: (error) => {
      message.error(describeProblemAclError(error, '添加分享失败'));
    },
  });

  const removeMutation = useMutation({
    mutationFn: (share: Pick<ProblemShare, 'granteeType' | 'granteeId'>) =>
      apiDelete<null>(
        `/api/problems/${problemId}/shares/${share.granteeType}/${share.granteeId}`,
      ),
    onSuccess: () => {
      message.success('分享已移除');
      invalidateShares();
    },
    onError: (error) => {
      message.error(describeProblemAclError(error, '移除分享失败'));
    },
  });

  if (!user) return null;

  // 无权限（403/404）与加载中都保持隐藏，避免只读用户看到管理入口。
  if (sharesQuery.isError) {
    if (isPermissionDenied(sharesQuery.error)) return null;
    return (
      <Card className="oij-card" size="small" title="分享">
        <Alert
          type="error"
          showIcon
          message="分享列表加载失败"
          description={
            sharesQuery.error instanceof Error
              ? sharesQuery.error.message
              : '请稍后重试'
          }
        />
      </Card>
    );
  }
  if (!sharesQuery.isSuccess) return null;

  const shares = sharesQuery.data;
  const granteeLabel = (share: ProblemShare) =>
    share.granteeType === 'team'
      ? `团队 · ${teamNames.get(share.granteeId) ?? `#${share.granteeId}`}`
      : `用户 #${share.granteeId}`;
  const granteeColor = (share: ProblemShare) =>
    share.granteeType === 'team' ? 'purple' : 'blue';

  const submitShare = () => {
    if (granteeId === null) return;
    addMutation.mutate({ granteeType, granteeId, permission });
  };

  return (
    <Card
      className="oij-card"
      size="small"
      title={`分享（${shares.length}）`}
      extra={<span className="muted">用户 / 团队</span>}
    >
      <div className="problem-share-toolbar">
        <Select<ProblemGranteeType>
          value={granteeType}
          onChange={(value) => {
            setGranteeType(value);
            setGranteeId(null);
          }}
          options={GRANTEE_OPTIONS}
        />
        {granteeType === 'team' ? (
          teams.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="还没有可用团队"
              description={
                <span>
                  请先在 <Link to="/teams">团队</Link> 页创建或加入团队。
                </span>
              }
            />
          ) : (
            <Select<number>
              value={granteeId}
              onChange={(value) => setGranteeId(value)}
              placeholder="选择团队"
              allowClear
              options={teams.map((team) => ({ value: team.id, label: team.name }))}
            />
          )
        ) : (
          <InputNumber
            min={1}
            precision={0}
            value={granteeId}
            onChange={(value) =>
              setGranteeId(typeof value === 'number' ? value : null)
            }
            placeholder="用户 ID"
          />
        )}
        <Select<ProblemSharePermission>
          value={permission}
          onChange={setPermission}
          options={PROBLEM_SHARE_PERMISSION_OPTIONS}
        />
        <Button
          type="primary"
          block
          icon={<PlusOutlined />}
          disabled={granteeId === null}
          loading={addMutation.isPending}
          onClick={submitShare}
        >
          添加分享
        </Button>
      </div>

      {shares.length === 0 ? (
        <div className="problem-share-empty muted">
          还没有分享给任何用户或团队。
        </div>
      ) : (
        <div className="problem-share-list">
          {shares.map((share) => {
            const key = `${share.granteeType}-${share.granteeId}`;
            const removing =
              removeMutation.isPending &&
              removeMutation.variables?.granteeType === share.granteeType &&
              removeMutation.variables?.granteeId === share.granteeId;
            return (
              <div className="problem-share-row" key={key}>
                <div className="problem-share-main">
                  <Tag color={granteeColor(share)}>
                    {PROBLEM_GRANTEE_TYPE_LABEL[share.granteeType]}
                  </Tag>
                  <span className="problem-share-name" title={granteeLabel(share)}>
                    {granteeLabel(share)}
                  </span>
                </div>
                <div className="problem-share-side">
                  <Tag color={share.permission === 'edit' ? 'gold' : undefined}>
                    {PROBLEM_SHARE_PERMISSION_LABEL[share.permission]}
                  </Tag>
                  <Popconfirm
                    title="移除该分享？"
                    description="移除后对方将无法再通过该分享访问题目。"
                    okText="移除"
                    okButtonProps={{ danger: true }}
                    cancelText="取消"
                    onConfirm={() =>
                      removeMutation.mutate({
                        granteeType: share.granteeType,
                        granteeId: share.granteeId,
                      })
                    }
                  >
                    <Button size="small" danger loading={removing}>
                      移除
                    </Button>
                  </Popconfirm>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
