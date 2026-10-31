import { useMemo } from 'react';
import { Button, Card, Space, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../api/client';
import type { AdminUser, AuditLog } from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/screen.css';

function actionColor(action: string): string {
  if (action.startsWith('auth.login_failed')) return 'red';
  if (action.startsWith('auth.login')) return 'green';
  if (action.startsWith('DELETE')) return 'red';
  if (action.startsWith('POST')) return 'blue';
  if (action.startsWith('PUT') || action.startsWith('PATCH')) return 'gold';
  return 'default';
}

export function AdminAuditPage() {
  const auditQuery = useQuery({
    queryKey: ['admin-audit'],
    queryFn: () => apiGet<AuditLog[]>('/api/admin/audit?limit=200'),
  });
  const usersQuery = useQuery({
    queryKey: ['admin-users', 'audit'],
    queryFn: () => apiGet<AdminUser[]>('/api/admin/users?limit=500'),
    staleTime: 30_000,
  });
  const usersById = useMemo(
    () => new Map((usersQuery.data ?? []).map((user) => [user.id, user])),
    [usersQuery.data],
  );

  const columns: TableColumnsType<AuditLog> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作者',
      dataIndex: 'actorId',
      width: 190,
      render: (value: number | null) => {
        if (value === null) return <span className="muted">匿名 / 失败登录</span>;
        const user = usersById.get(value);
        return user ? (
          <span>
            {user.realName ?? user.username}
            <span className="muted"> @{user.username}</span>
          </span>
        ) : (
          <span className="mono">#{value}</span>
        );
      },
    },
    {
      title: '动作',
      dataIndex: 'action',
      render: (value: string) => (
        <Tag color={actionColor(value)} className="audit-action">
          {value}
        </Tag>
      ),
    },
    {
      title: '目标',
      width: 170,
      render: (_value, row) =>
        row.targetType === null ? (
          <span className="muted">—</span>
        ) : (
          <span>
            {row.targetType}
            {row.targetId !== null ? <span className="mono"> #{row.targetId}</span> : null}
          </span>
        ),
    },
    {
      title: 'IP',
      dataIndex: 'ip',
      width: 130,
      render: (value: string | null) => <span className="mono">{value ?? '—'}</span>,
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理', to: '/admin/problems' }, { label: '审计日志' }]}
        title="审计日志"
        subtitle="管理员登录与所有 /api/admin 写操作记录；最多显示最近 200 条，展开可查看详情 JSON。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={auditQuery.isFetching}
            onClick={() => void auditQuery.refetch()}
          >
            刷新
          </Button>
        }
      />

      <Card className="oij-card">
        {auditQuery.isPending ? (
          <PageLoading tip="正在加载审计日志…" />
        ) : auditQuery.isError ? (
          <ErrorResult
            error={auditQuery.error}
            onRetry={() => void auditQuery.refetch()}
          />
        ) : (
          <Table<AuditLog>
            className="oij-table audit-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={auditQuery.data ?? []}
            pagination={false}
            expandable={{
              expandedRowRender: (record) => (
                <pre className="audit-detail">
                  {JSON.stringify(record.detail, null, 2)}
                </pre>
              ),
              rowExpandable: () => true,
            }}
            locale={{ emptyText: '暂无审计记录' }}
          />
        )}
        <div className="audit-footer muted">
          <Space size={16} wrap>
            <span>共 {auditQuery.data?.length ?? 0} 条</span>
            <span>limit=200</span>
          </Space>
        </div>
      </Card>
    </div>
  );
}
