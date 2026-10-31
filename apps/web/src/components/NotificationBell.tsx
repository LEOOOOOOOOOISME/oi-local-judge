import { useState } from 'react';
import { Badge, Button, Empty, Popover } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type { NotificationItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';
import '../styles/community.css';

const TYPE_LABEL: Record<string, string> = {
  comment: '评论',
  message: '私信',
  clarification: '答疑',
};

function asRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

function notificationText(item: NotificationItem): { title: string; detail: string; to: string } {
  const payload = asRecord(item.payload);
  if (item.type === 'comment') {
    const postId = Number(payload.postId);
    return {
      title: '收到新评论',
      detail: `${String(payload.by ?? '用户')} 评论了《${String(payload.title ?? '帖子')}》`,
      to: Number.isInteger(postId) ? `/discuss/${postId}` : '/discuss',
    };
  }
  if (item.type === 'message') {
    const from = Number(payload.from);
    return {
      title: '收到新私信',
      detail: String(payload.preview ?? ''),
      to: Number.isInteger(from) ? `/messages?userId=${from}` : '/messages',
    };
  }
  if (item.type === 'clarification') {
    const contestId = Number(payload.contestId);
    return {
      title: '比赛答疑已回复',
      detail: String(payload.answer ?? ''),
      to: Number.isInteger(contestId)
        ? `/contest/${contestId}?tab=clarifications`
        : '/contests',
    };
  }
  return { title: '系统通知', detail: '有新的通知', to: '/' };
}

export function NotificationBell() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  const notificationsQuery = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiGet<NotificationItem[]>('/api/notifications'),
    enabled: Boolean(user),
    refetchInterval: 5_000,
  });
  const notifications = notificationsQuery.data ?? [];
  const unread = notifications.filter((item) => item.readAt === null).length;

  const markRead = async () => {
    try {
      await apiPost<null>('/api/notifications/read');
      void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    } catch {
      // 通知已读失败不阻塞导航。
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen && unread > 0) void markRead();
  };

  const handleClick = async (item: NotificationItem) => {
    await markRead();
    setOpen(false);
    navigate(notificationText(item).to);
  };

  if (!user) return null;

  const content = (
    <div className="notification-panel">
      <div className="notification-head">
        <span>通知</span>
        <span className="muted">{unread > 0 ? `${unread} 条未读` : '全部已读'}</span>
      </div>
      {notifications.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知" />
      ) : (
        <div className="notification-list">
          {notifications.map((item) => {
            const meta = notificationText(item);
            return (
              <button
                type="button"
                className="notification-item"
                key={item.id}
                onClick={() => void handleClick(item)}
              >
                <span className="notification-item-head">
                  <span>{meta.title}</span>
                  <span className="muted">{TYPE_LABEL[item.type] ?? item.type}</span>
                </span>
                <span className="notification-item-detail">{meta.detail}</span>
                <span className="notification-item-time muted">
                  {formatDateTime(item.createdAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}
      <div className="notification-footer">
        <Button type="link" size="small" onClick={() => void markRead()}>
          全部标为已读
        </Button>
      </div>
    </div>
  );

  return (
    <Popover
      content={content}
      trigger="click"
      placement="bottomRight"
      open={open}
      onOpenChange={handleOpenChange}
    >
      <button type="button" className="notification-bell" aria-label="通知">
        <Badge count={unread} size="small" offset={[-2, 2]}>
          <BellOutlined />
        </Badge>
      </button>
    </Popover>
  );
}
