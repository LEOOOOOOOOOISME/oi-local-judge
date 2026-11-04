import { useMemo, useState } from 'react';
import { Button, Card, Progress, Segmented, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { ClassSummary, TeamSummary, TrainingPlanSummary } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { TrainingPlanCreateModal } from '../components/TrainingPlanCreateModal';
import { formatDateTime } from '../utils/format';
import {
  canSearchAllGroups,
  filterTrainingPlans,
  manageableGroups,
  planTimeStatus,
  progressPercent,
  TRAINING_PLAN_FILTER_OPTIONS,
  TRAINING_PLAN_GROUP_KIND_LABEL,
  TRAINING_PLAN_TIME_STATUS_COLOR,
  TRAINING_PLAN_TIME_STATUS_LABEL,
  type TrainingPlanFilter,
} from '../utils/trainingPlans';
import '../styles/training-plans.css';

export function TrainingPlansPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<TrainingPlanFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);

  const plansQuery = useQuery({
    queryKey: ['training-plans'],
    queryFn: () => apiGet<TrainingPlanSummary[]>('/api/training-plans'),
  });
  const classesQuery = useQuery({
    queryKey: ['classes'],
    queryFn: () => apiGet<ClassSummary[]>('/api/classes'),
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
  });

  const isAdmin = user?.role === 'admin';
  const groups = useMemo(
    () =>
      manageableGroups(classesQuery.data ?? [], teamsQuery.data ?? [], {
        currentUserId: user?.id,
        isAdmin,
      }),
    [classesQuery.data, teamsQuery.data, user?.id, isAdmin],
  );
  // 管理员入口始终可见（若不在任何组中，弹窗会给出提示）。
  // 比赛管理员现在也能搜索全量班级/团队，因此同样始终显示创建入口。
  const canCreate = canSearchAllGroups(user?.role) || groups.length > 0;

  const plans = plansQuery.data ?? [];
  const visiblePlans = filterTrainingPlans(plans, filter);

  const columns: TableColumnsType<TrainingPlanSummary> = [
    {
      title: '训练计划',
      dataIndex: 'title',
      render: (value: string, row) => (
        <div className="training-plan-title-cell">
          <Link to={`/training-plans/${row.id}`} className="training-plan-title-link">
            {value}
          </Link>
          {row.description ? (
            <div className="training-plan-desc muted">{row.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      title: '班级 / 团队',
      dataIndex: 'groupName',
      width: 210,
      render: (_value, row) => (
        <Space size={6}>
          <Tag color={row.groupKind === 'class' ? 'blue' : 'purple'}>
            {TRAINING_PLAN_GROUP_KIND_LABEL[row.groupKind]}
          </Tag>
          <span>{row.groupName}</span>
        </Space>
      ),
    },
    {
      title: '时间',
      width: 250,
      render: (_value, row) => {
        if (row.startsAt === null && row.endsAt === null) {
          return <span className="muted">不限制</span>;
        }
        return (
          <span className="mono training-plan-time">
            {row.startsAt === null ? '不限' : formatDateTime(row.startsAt)}
            <span className="muted"> ~ </span>
            {row.endsAt === null ? '不限' : formatDateTime(row.endsAt)}
          </span>
        );
      },
    },
    {
      title: '完成度',
      dataIndex: 'myProgress',
      width: 190,
      render: (_value, row) =>
        row.myProgress.itemCount === 0 ? (
          <span className="muted">暂无题目</span>
        ) : (
          <div className="training-plan-progress-cell">
            <Progress
              percent={progressPercent(row.myProgress)}
              size="small"
              status={row.myProgress.allCompleted ? 'success' : 'normal'}
              format={() =>
                `${row.myProgress.completedCount}/${row.myProgress.itemCount}`
              }
            />
            {row.myProgress.overdueCount > 0 ? (
              <span className="training-plan-overdue muted">
                {row.myProgress.overdueCount} 题逾期
              </span>
            ) : null}
          </div>
        ),
    },
    {
      title: '状态',
      width: 108,
      render: (_value, row) => {
        const status = planTimeStatus(row);
        return (
          <Space size={4} wrap>
            <Tag color={TRAINING_PLAN_TIME_STATUS_COLOR[status]}>
              {TRAINING_PLAN_TIME_STATUS_LABEL[status]}
            </Tag>
            {row.myProgress.itemCount > 0 && row.myProgress.allCompleted ? (
              <Tag color="green">已完成</Tag>
            ) : null}
          </Space>
        );
      },
    },
    {
      title: '我的权限',
      dataIndex: 'canManage',
      width: 100,
      render: (value: boolean) =>
        value ? <Tag color="gold">可管理</Tag> : <Tag>只读</Tag>,
    },
    {
      title: '操作',
      width: 88,
      render: (_value, row) => (
        <Link to={`/training-plans/${row.id}`}>
          <Tag color="processing">打开</Tag>
        </Link>
      ),
    },
  ];

  const emptyText =
    plans.length === 0 ? (
      <div className="training-plan-empty">
        <div>还没有可见的训练计划。</div>
        <div className="muted">
          加入班级或团队后，教练/队长发布的训练计划会显示在这里。
          {groups.length > 0 ? '你也可以直接创建训练计划。' : ''}
        </div>
      </div>
    ) : (
      <div className="training-plan-empty muted">当前筛选下没有训练计划。</div>
    );

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '首页', to: '/contests' }, { label: '训练' }]}
        title="训练计划"
        subtitle="查看班级/团队训练计划与我的完成度；教练、队长与管理员可以创建和管理计划。"
        extra={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={plansQuery.isFetching}
              onClick={() => void plansQuery.refetch()}
            >
              刷新
            </Button>
            {canCreate ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreateOpen(true)}
              >
                创建训练计划
              </Button>
            ) : null}
          </Space>
        }
      />

      <Card
        className="oij-card"
        title="我的训练计划"
        extra={
          <Space wrap size={12}>
            <span className="muted">共 {plans.length} 个</span>
            <Segmented<TrainingPlanFilter>
              size="small"
              value={filter}
              onChange={(value) => setFilter(value)}
              options={TRAINING_PLAN_FILTER_OPTIONS}
            />
          </Space>
        }
      >
        {plansQuery.isPending ? (
          <PageLoading tip="正在加载训练计划…" />
        ) : plansQuery.isError ? (
          <ErrorResult error={plansQuery.error} onRetry={() => void plansQuery.refetch()} />
        ) : (
          <Table<TrainingPlanSummary>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={visiblePlans}
            pagination={false}
            locale={{ emptyText }}
          />
        )}
      </Card>

      <TrainingPlanCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        classes={classesQuery.data ?? []}
        teams={teamsQuery.data ?? []}
        groupsLoading={classesQuery.isPending || teamsQuery.isPending}
        onCreated={(id) => navigate(`/training-plans/${id}`)}
      />
    </div>
  );
}
