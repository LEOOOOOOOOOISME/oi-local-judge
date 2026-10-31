import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Modal,
  Space,
  Spin,
} from 'antd';
import { MessageOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type {
  CommunityAuthor,
  ConversationPartner,
  ConversationThread,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/community.css';

function displayName(user: CommunityAuthor): string {
  return user.realName ?? user.username;
}

function initials(user: CommunityAuthor): string {
  return displayName(user).slice(0, 1).toUpperCase();
}

export function MessagesPage() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const paramUserId = Number(searchParams.get('userId'));
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    Number.isInteger(paramUserId) && paramUserId > 0 ? paramUserId : null,
  );
  const [draft, setDraft] = useState('');
  const [newOpen, setNewOpen] = useState(false);
  const [newUserId, setNewUserId] = useState<number | null>(null);

  const conversationsQuery = useQuery({
    queryKey: ['conversations'],
    queryFn: () => apiGet<ConversationPartner[]>('/api/messages/conversations'),
    enabled: Boolean(user),
    refetchInterval: 5_000,
  });
  const conversations = conversationsQuery.data ?? [];

  useEffect(() => {
    if (paramUserId > 0) {
      setSelectedUserId((current) => (current === paramUserId ? current : paramUserId));
      return;
    }
    if (selectedUserId === null && conversations.length > 0) {
      setSelectedUserId(conversations[0].user.id);
    }
  }, [paramUserId, selectedUserId, conversations]);

  const threadQuery = useQuery({
    queryKey: ['conversation', selectedUserId],
    queryFn: () => apiGet<ConversationThread>(`/api/messages/${selectedUserId}`),
    enabled: Boolean(user) && selectedUserId !== null,
    refetchInterval: 2_000,
  });

  useEffect(() => {
    if (threadQuery.dataUpdatedAt > 0) {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  }, [threadQuery.dataUpdatedAt, queryClient]);

  const selectedConversation = useMemo(
    () => conversations.find((item) => item.user.id === selectedUserId),
    [conversations, selectedUserId],
  );
  const threadUser = threadQuery.data?.user ?? selectedConversation?.user ?? null;
  const messages = threadQuery.data?.messages ?? [];

  const sendMessage = async () => {
    if (!selectedUserId || !draft.trim()) return;
    try {
      await apiPost<{ id: number }>(`/api/messages/${selectedUserId}`, {
        body: draft.trim(),
      });
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['conversation', selectedUserId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发送失败');
    }
  };

  const openNewMessage = () => {
    setNewUserId(null);
    setNewOpen(true);
  };

  const startNewMessage = () => {
    if (!newUserId || newUserId <= 0) return;
    setSelectedUserId(newUserId);
    setNewOpen(false);
    navigate(`/messages?userId=${newUserId}`);
  };

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '消息' }]}
        title="私信"
        subtitle="与出题人、比赛管理员或其他用户交流；消息每 2 秒刷新。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openNewMessage}>
            发起私信
          </Button>
        }
      />

      <div className="messages-layout">
        <Card
          className="oij-card messages-sidebar"
          title="会话"
          extra={<span className="muted">{conversations.length}</span>}
        >
          {conversationsQuery.isPending ? (
            <div className="inline-loading">
              <Spin />
            </div>
          ) : conversationsQuery.isError ? (
            <ErrorResult
              error={conversationsQuery.error}
              onRetry={() => void conversationsQuery.refetch()}
            />
          ) : conversations.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="还没有会话"
            >
              <Button icon={<MessageOutlined />} onClick={openNewMessage}>
                发起私信
              </Button>
            </Empty>
          ) : (
            <div className="conversation-list">
              {conversations.map((item) => (
                <button
                  type="button"
                  key={item.user.id}
                  className={`conversation-item${
                    selectedUserId === item.user.id ? ' conversation-item-active' : ''
                  }`}
                  onClick={() => {
                    setSelectedUserId(item.user.id);
                    navigate(`/messages?userId=${item.user.id}`);
                  }}
                >
                  <Avatar size={34} className="conversation-avatar">
                    {initials(item.user)}
                  </Avatar>
                  <span className="conversation-main">
                    <span className="conversation-head">
                      <span className="conversation-name">
                        {displayName(item.user)}{' '}
                        <span className="muted">@{item.user.username}</span>
                      </span>
                      <span className="muted">{formatDateTime(item.lastAt)}</span>
                    </span>
                    <span className="conversation-preview">{item.lastMessage}</span>
                  </span>
                  {item.unread > 0 ? <Badge count={item.unread} size="small" /> : null}
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card
          className="oij-card messages-thread"
          title={
            threadUser ? (
              <Space>
                <Avatar size={26} className="conversation-avatar">
                  {initials(threadUser)}
                </Avatar>
                <span>{displayName(threadUser)}</span>
                <span className="muted">@{threadUser.username}</span>
              </Space>
            ) : (
              '消息线程'
            )
          }
          extra={
            selectedUserId !== null && threadQuery.isFetching ? (
              <span className="muted">刷新中…</span>
            ) : null
          }
        >
          {selectedUserId === null ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="选择一个会话，或发起新的私信。"
            />
          ) : threadQuery.isPending ? (
            <PageLoading tip="正在加载消息…" />
          ) : threadQuery.isError ? (
            <ErrorResult
              error={threadQuery.error}
              onRetry={() => void threadQuery.refetch()}
            />
          ) : (
            <>
              <div className="message-list">
                {messages.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="还没有消息，发送第一条吧。"
                  />
                ) : (
                  messages.map((item) => {
                    const mine = item.senderId === user?.id;
                    return (
                      <div
                        className={`message-row${mine ? ' message-row-mine' : ''}`}
                        key={item.id}
                      >
                        <div className="message-bubble">
                          <div className="message-body">{item.body}</div>
                          <div className="message-time muted">
                            {formatDateTime(item.createdAt)}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="message-composer">
                <Input.TextArea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="输入私信内容，最多 10000 字"
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  maxLength={10000}
                />
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  disabled={!draft.trim()}
                  onClick={() => void sendMessage()}
                >
                  发送
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <Modal
        title="发起私信"
        open={newOpen}
        onCancel={() => setNewOpen(false)}
        onOk={startNewMessage}
        okText="打开会话"
        cancelText="取消"
        okButtonProps={{ disabled: !newUserId || newUserId <= 0 }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <span className="muted">
            当前没有用户检索接口；可输入用户 ID，或从讨论帖作者的“私信作者”进入。
          </span>
          <InputNumber
            min={1}
            precision={0}
            value={newUserId}
            onChange={(value) => setNewUserId(typeof value === 'number' ? value : null)}
            placeholder="接收者用户 ID"
            style={{ width: '100%' }}
          />
        </Space>
      </Modal>
    </div>
  );
}
