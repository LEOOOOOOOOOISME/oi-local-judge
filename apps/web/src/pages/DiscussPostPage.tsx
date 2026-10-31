import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Empty,
  Input,
  Space,
  Tag,
} from 'antd';
import { LockOutlined, PushpinOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../api/client';
import type { PostDetail } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/community.css';

const CATEGORY_LABEL: Record<string, string> = {
  discuss: '讨论',
  solution: '题解',
  announcement: '公告',
};
const STAFF_ROLES = ['admin', 'setter', 'contestmanager'];

export function DiscussPostPage() {
  const params = useParams<{ postId: string }>();
  const postId = Number(params.postId);
  const validId = Number.isInteger(postId) && postId > 0;
  const { user } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [flagLoading, setFlagLoading] = useState<string | null>(null);

  const postQuery = useQuery({
    queryKey: ['post', postId],
    queryFn: () => apiGet<PostDetail>(`/api/posts/${postId}`),
    enabled: validId,
  });

  const commentMutation = useMutation({
    mutationFn: (body: string) =>
      apiPost<{ id: number }>(`/api/posts/${postId}/comments`, { body }),
    onSuccess: () => {
      message.success('评论已发布');
      setComment('');
      void queryClient.invalidateQueries({ queryKey: ['post', postId] });
      void queryClient.invalidateQueries({ queryKey: ['posts'] });
    },
    onError: (error) => {
      let text = error instanceof Error ? error.message : '评论失败';
      if (error instanceof ApiError && error.code === 'LOCKED') text = '帖子已锁定，无法评论';
      if (error instanceof ApiError && error.code === 'RATE_LIMITED') {
        text = '评论过于频繁，请稍后再试';
      }
      message.error(text);
    },
  });

  const setFlags = async (
    action: string,
    flags: { status?: string; pinned?: boolean; locked?: boolean },
  ) => {
    setFlagLoading(action);
    try {
      await apiPost<null>(`/api/admin/posts/${postId}/flags`, flags);
      message.success('帖子状态已更新');
      void queryClient.invalidateQueries({ queryKey: ['post', postId] });
      void queryClient.invalidateQueries({ queryKey: ['posts'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-posts'] });
      if (flags.status === 'hidden') navigate('/discuss');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '操作失败');
    } finally {
      setFlagLoading(null);
    }
  };

  if (!validId) return <ErrorResult error={new Error('无效的帖子编号')} />;
  if (postQuery.isPending) return <PageLoading tip="正在加载帖子…" />;
  if (postQuery.isError) {
    return <ErrorResult error={postQuery.error} onRetry={() => void postQuery.refetch()} />;
  }
  const post = postQuery.data;
  if (!post) return <PageLoading tip="正在加载帖子…" />;
  const isStaff = Boolean(user && STAFF_ROLES.includes(user.role));
  const canComment = Boolean(user) && !post.locked;

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '讨论', to: '/discuss' },
          { label: post.title },
        ]}
        title={post.title}
        tags={
          <>
            <Tag>{CATEGORY_LABEL[post.category] ?? post.category}</Tag>
            {post.pinned ? (
              <Tag color="blue">
                <PushpinOutlined /> 置顶
              </Tag>
            ) : null}
            {post.locked ? (
              <Tag color="gold">
                <LockOutlined /> 已锁定
              </Tag>
            ) : null}
          </>
        }
        subtitle={
          <span>
            {post.author.realName ?? post.author.username}（@{post.author.username}） ·{' '}
            {formatDateTime(post.createdAt)}
            {post.problemId !== null ? (
              <>
                {' '}· <Link to={`/problem/${post.problemId}`}>题目 #{post.problemId}</Link>
              </>
            ) : null}
            {post.contestId !== null ? (
              <>
                {' '}· <Link to={`/contest/${post.contestId}`}>比赛 #{post.contestId}</Link>
              </>
            ) : null}
          </span>
        }
        extra={
          <Space>
            {user && post.author.id !== user.id ? (
              <Link to={`/messages?userId=${post.author.id}`}>
                <Button>私信作者</Button>
              </Link>
            ) : null}
            {isStaff ? (
              <Link to="/admin/posts">
                <Button>审核管理</Button>
              </Link>
            ) : null}
            <Link to="/discuss">
              <Button>返回讨论区</Button>
            </Link>
          </Space>
        }
      />

      <div className="stack">
        {isStaff ? (
          <Card className="oij-card" size="small" title="管理操作">
            <Space wrap>
              <Button
                loading={flagLoading === 'pin'}
                onClick={() =>
                  void setFlags('pin', { pinned: !post.pinned })
                }
              >
                {post.pinned ? '取消置顶' : '置顶'}
              </Button>
              <Button
                loading={flagLoading === 'lock'}
                onClick={() =>
                  void setFlags('lock', { locked: !post.locked })
                }
              >
                {post.locked ? '解除锁定' : '锁定'}
              </Button>
              <Button
                danger
                loading={flagLoading === 'hide'}
                onClick={() => void setFlags('hide', { status: 'hidden' })}
              >
                隐藏
              </Button>
            </Space>
          </Card>
        ) : null}

        <Card className="oij-card">
          <article
            className="rich-text"
            dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
          />
        </Card>

        <Card
          className="oij-card"
          title={`评论 (${post.comments.length})`}
        >
          {post.comments.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有评论" />
          ) : (
            <div className="comment-list">
              {post.comments.map((item) => (
                <div className="comment-item" key={item.id}>
                  <div className="comment-head">
                    <span className="comment-author">
                      {item.author.realName ?? item.author.username}
                    </span>
                    <span className="muted">@{item.author.username}</span>
                    <span className="muted">{formatDateTime(item.createdAt)}</span>
                  </div>
                  <div
                    className="rich-text comment-body"
                    dangerouslySetInnerHTML={{ __html: item.bodyHtml }}
                  />
                </div>
              ))}
            </div>
          )}

          <Divider />
          {post.locked ? (
            <Alert type="warning" showIcon message="帖子已锁定，不能再评论。" />
          ) : !user ? (
            <Alert
              type="info"
              showIcon
              message={
                <span>
                  登录后参与评论。<Link to={`/login?next=${encodeURIComponent(`/discuss/${post.id}`)}`}>去登录</Link>
                </span>
              }
            />
          ) : (
            <div className="comment-form">
              <Input.TextArea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="写下你的评论（支持 Markdown）"
                rows={4}
                maxLength={20000}
              />
              <div className="comment-form-footer">
                <span className="muted">评论会通知帖子作者。</span>
                <Button
                  type="primary"
                  loading={commentMutation.isPending}
                  disabled={!comment.trim() || !canComment}
                  onClick={() => commentMutation.mutate(comment.trim())}
                >
                  发表评论
                </Button>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
