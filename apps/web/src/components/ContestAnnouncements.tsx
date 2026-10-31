import { Card, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { apiGet } from '../api/client';
import type { PostDetail, PostSummary } from '../api/types';
import { formatDateTime } from '../utils/format';
import { ErrorResult } from './PageStates';
import '../styles/contest-admin.css';

/** 比赛公告：先取列表，再取每篇详情以获得服务端渲染的 bodyHtml。 */
export function useContestAnnouncements(contestId: number) {
  return useQuery({
    queryKey: ['contest-announcements', contestId],
    queryFn: async () => {
      const list = await apiGet<PostSummary[]>(
        `/api/posts?contestId=${contestId}&category=announcement&limit=50`,
      );
      if (list.length === 0) return [];
      return Promise.all(
        list.map((item) => apiGet<PostDetail>(`/api/posts/${item.id}`)),
      );
    },
    staleTime: 10_000,
  });
}

export function ContestAnnouncements({ contestId }: { contestId: number }) {
  const announcementsQuery = useContestAnnouncements(contestId);
  if (announcementsQuery.isPending) {
    return (
      <Card className="oij-card" title="比赛公告">
        <div className="inline-loading">
          <Spin />
        </div>
      </Card>
    );
  }
  if (announcementsQuery.isError) {
    return (
      <Card className="oij-card" title="比赛公告">
        <ErrorResult
          error={announcementsQuery.error}
          onRetry={() => void announcementsQuery.refetch()}
        />
      </Card>
    );
  }
  const announcements = announcementsQuery.data ?? [];
  if (announcements.length === 0) return null;

  return (
    <Card className="oij-card quote-announcements" title="比赛公告">
      <div className="announcement-list">
        {announcements.map((post, index) => (
          <article className="announcement-item" key={post.id}>
            <div className="announcement-head">
              <div>
                <span className="announcement-index">公告 {index + 1}</span>
                <h3 className="announcement-title">
                  <Link to={`/discuss/${post.id}`}>{post.title}</Link>
                </h3>
              </div>
              <span className="muted announcement-meta">
                {post.author.realName ?? post.author.username} ·{' '}
                {formatDateTime(post.createdAt)}
              </span>
            </div>
            <div
              className="rich-text announcement-body"
              dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
            />
          </article>
        ))}
      </div>
    </Card>
  );
}
