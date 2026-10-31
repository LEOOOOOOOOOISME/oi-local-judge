import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type { AdminPostRow, AdminUser } from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/community.css';

const STATUS_LABEL: Record<string, string> = {
  pending: '待审核',
  published: '已公开',
  hidden: '已隐藏',
};
const STATUS_COLOR: Record<string, string> = {
  pending: 'gold',
  published: 'green',
  hidden: 'default',
};
const CATEGORY_LABEL: Record<string, string> = {
  discuss: '讨论',
  solution: '题解',
  announcement: '公告',
};

type StatusFilter = 'pending' | 'published' | 'hidden';

export function AdminPostsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>('pending');
  const [flagLoading, setFlagLoading] = useState<string | null>(null);

  const postsQuery = useQuery({
    queryKey: ['admin-posts', status],
    queryFn: () => apiGet<AdminPostRow[]>(`/api/admin/posts?status=${status}&limit=200`),
  });
  const usersQuery = useQuery({
    queryKey: ['admin-users', 'community'],
    queryFn: () => apiGet<AdminUser[]>('/api/admin/users?limit=500'),
    staleTime: 30_000,
  });
  const usersById = useMemo(
    () => new Map((usersQuery.data ?? []).map((user) => [user.id, user])),
    [usersQuery.data],
  );

  const updateFlags = async (
    record: AdminPostRow,
    action: string,
    flags: { status?: string; pinned?: boolean; locked?: boolean },
  ) => {
    setFlagLoading(`${record.id}:${action}`);
    try {
      await apiPost<null>(`/api/admin/posts/${record.id}/flags`, flags);
      message.success('帖子状态已更新');
      void queryClient.invalidateQueries({ queryKey: ['admin-posts'] });
      void queryClient.invalidateQueries({ queryKey: ['posts'] });
      void queryClient.invalidateQueries({ queryKey: ['post', record.id] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setFlagLoading(null);
    }
  };

  const columns: TableColumnsType<AdminPostRow> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 64,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '标题',
      dataIndex: 'title',
      render: (value: string, record) => (
        <Space size={6}>
          <span>{value}</span>
          {record.pinned ? <Tag color="blue">置顶</Tag> : null}
          {record.locked ? <Tag color="gold">锁定</Tag> : null}
        </Space>
      ),
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 80,
      render: (value: string) => CATEGORY_LABEL[value] ?? value,
    },
    {
      title: '作者',
      dataIndex: 'author_id',
      width: 150,
      render: (value: number) => {
        const author = usersById.get(value);
        return author ? (
          <span>
            {author.realName ?? author.username}
            <span className="muted"> @{author.username}</span>
          </span>
        ) : (
          <span className="mono">#{value}</span>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) => (
        <Tag color={STATUS_COLOR[value] ?? 'default'}>{STATUS_LABEL[value] ?? value}</Tag>
      ),
    },
    {
      title: '时间',
      dataIndex: 'created_at',
      width: 160,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      width: 300,
      render: (_value, record) => (
        <Space size={6} wrap>
          {record.status !== 'published' ? (
            <Button
              size="small"
              type="primary"
              loading={flagLoading === `${record.id}:publish`}
              onClick={() => void updateFlags(record, 'publish', { status: 'published' })}
            >
              通过
            </Button>
          ) : null}
          {record.status !== 'hidden' ? (
            <Popconfirm
              title="隐藏该帖子？"
              okText="隐藏"
              cancelText="取消"
              onConfirm={() => void updateFlags(record, 'hide', { status: 'hidden' })}
            >
              <Button size="small" danger loading={flagLoading === `${record.id}:hide`}>
                隐藏
              </Button>
            </Popconfirm>
          ) : null}
          {record.status === 'published' ? (
            <Link to={`/discuss/${record.id}`}>
              <Button size="small">查看</Button>
            </Link>
          ) : null}
          <Button
            size="small"
            loading={flagLoading === `${record.id}:pin`}
            onClick={() => void updateFlags(record, 'pin', { pinned: record.pinned !== 1 })}
          >
            {record.pinned ? '取消置顶' : '置顶'}
          </Button>
          <Button
            size="small"
            loading={flagLoading === `${record.id}:lock`}
            onClick={() => void updateFlags(record, 'lock', { locked: record.locked !== 1 })}
          >
            {record.locked ? '解除锁定' : '锁定'}
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '讨论', to: '/discuss' },
          { label: '审核管理' },
        ]}
        title="社区审核"
        subtitle="审核选手题解，管理讨论/公告的公开、置顶与锁定状态。"
        extra={
          <Link to="/discuss">
            <Button>返回讨论区</Button>
          </Link>
        }
      />

      <Card className="oij-card">
        <Tabs
          className="problem-tabs"
          activeKey={status}
          onChange={(key) => setStatus(key as StatusFilter)}
          items={[
            { key: 'pending', label: '待审核' },
            { key: 'published', label: '已公开' },
            { key: 'hidden', label: '已隐藏' },
          ]}
        />
        {postsQuery.isPending ? (
          <PageLoading tip="正在加载帖子…" />
        ) : postsQuery.isError ? (
          <ErrorResult
            error={postsQuery.error}
            onRetry={() => void postsQuery.refetch()}
          />
        ) : (
          <Table<AdminPostRow>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={postsQuery.data ?? []}
            pagination={false}
            expandable={{
              expandedRowRender: (record) => (
                <pre className="admin-post-body">{record.body_md}</pre>
              ),
              rowExpandable: (record) => record.body_md.length > 0,
            }}
            locale={{ emptyText: '当前状态下没有帖子' }}
          />
        )}
      </Card>
    </div>
  );
}
