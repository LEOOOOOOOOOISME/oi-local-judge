import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Input,
  Space,
  Spin,
  Switch,
  Tag,
} from 'antd';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type { Clarification, CommunityAuthor } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ErrorResult } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/community.css';

const STAFF_ROLES = ['admin', 'setter', 'contestmanager'];

function authorName(user: CommunityAuthor): string {
  return user.realName ?? user.username;
}

function ClarificationItem({
  contestId,
  item,
  canAnswer,
}: {
  contestId: number;
  item: Clarification;
  canAnswer: boolean;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState(item.answer ?? '');
  const [isPublic, setIsPublic] = useState(item.isPublic);
  const [saving, setSaving] = useState(false);

  const submitAnswer = async () => {
    if (!answer.trim()) {
      message.warning('请填写回答');
      return;
    }
    setSaving(true);
    try {
      await apiPost<null>(
        `/api/admin/contests/${contestId}/clarifications/${item.id}/answer`,
        { answer: answer.trim(), public: isPublic },
      );
      message.success('答疑已回复');
      void queryClient.invalidateQueries({ queryKey: ['clarifications', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '回复失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="clarification-item">
      <div className="clarification-head">
        <span className="clarification-question">Q：{item.question}</span>
        <Space size={6} wrap>
          {item.answer ? (
            <Tag color="green">已回复</Tag>
          ) : (
            <Tag color="gold">未回复</Tag>
          )}
          <Tag>{item.isPublic ? '公开' : '仅提问者可见'}</Tag>
        </Space>
      </div>
      <div className="clarification-meta muted">
        {authorName(item.user)}（@{item.user.username}） · {formatDateTime(item.createdAt)}
      </div>
      {item.answer ? (
        <div className="clarification-answer">
          <span className="clarification-answer-label">A：</span>
          <span>{item.answer}</span>
          <span className="muted">
            {' '}
            · {item.answeredAt !== null ? formatDateTime(item.answeredAt) : ''}
          </span>
        </div>
      ) : (
        <div className="clarification-unanswered">等待管理员回复。</div>
      )}
      {canAnswer ? (
        <div className="clarification-admin">
          <Input.TextArea
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={item.answer ? '更新回答' : '输入回答'}
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
          <Space className="clarification-admin-actions" size={10} wrap>
            <span className="muted">
              <Switch size="small" checked={isPublic} onChange={setIsPublic} /> 公开回答
            </span>
            <Button type="primary" size="small" loading={saving} onClick={() => void submitAnswer()}>
              {item.answer ? '更新回答' : '提交回答'}
            </Button>
          </Space>
        </div>
      ) : null}
    </div>
  );
}

export function ContestClarifications({ contestId }: { contestId: number }) {
  const { user } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const isStaff = Boolean(user && STAFF_ROLES.includes(user.role));

  const clarificationsQuery = useQuery({
    queryKey: ['clarifications', contestId],
    queryFn: () => apiGet<Clarification[]>(`/api/contests/${contestId}/clarifications`),
    enabled: Boolean(user),
    refetchInterval: 5_000,
  });

  const ask = async () => {
    if (!question.trim()) {
      message.warning('请输入问题');
      return;
    }
    setAsking(true);
    try {
      await apiPost<{ id: number }>(`/api/contests/${contestId}/clarifications`, {
        question: question.trim(),
      });
      message.success('问题已提交');
      setQuestion('');
      void queryClient.invalidateQueries({ queryKey: ['clarifications', contestId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '提问失败');
    } finally {
      setAsking(false);
    }
  };

  if (!user) {
    return (
      <Card className="oij-card">
        <Alert
          type="info"
          showIcon
          message="登录后查看和参与比赛答疑。"
          action={
            <Link to={`/login?next=${encodeURIComponent(`/contest/${contestId}?tab=clarifications`)}`}>
              <Button size="small" type="primary">
                去登录
              </Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="stack">
      <Card className="oij-card" title="我要提问">
        <div className="clarification-ask">
          <Input.TextArea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="向出题人提问（公开问题会展示给所有选手）"
            autoSize={{ minRows: 2, maxRows: 5 }}
            maxLength={10000}
          />
          <div className="clarification-ask-footer">
            <span className="muted">问题默认公开；回答后会通知提问者。</span>
            <Button
              type="primary"
              loading={asking}
              disabled={!question.trim()}
              onClick={() => void ask()}
            >
              提交问题
            </Button>
          </div>
        </div>
      </Card>

      <Card
        className="oij-card"
        title={`答疑列表${
          clarificationsQuery.data ? ` (${clarificationsQuery.data.length})` : ''
        }`}
        extra={isStaff ? <span className="muted">管理员可直接回复</span> : null}
      >
        {clarificationsQuery.isPending ? (
          <div className="inline-loading">
            <Spin />
          </div>
        ) : clarificationsQuery.isError ? (
          <ErrorResult
            error={clarificationsQuery.error}
            onRetry={() => void clarificationsQuery.refetch()}
          />
        ) : !clarificationsQuery.data || clarificationsQuery.data.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有答疑" />
        ) : (
          <div className="clarification-list">
            {clarificationsQuery.data.map((item) => (
              <ClarificationItem
                key={item.id}
                contestId={contestId}
                item={item}
                canAnswer={isStaff}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
