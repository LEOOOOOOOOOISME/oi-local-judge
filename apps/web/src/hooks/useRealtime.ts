import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import type {
  OfficialRanking,
  RankingDelta,
  SubmissionUpdatedPayload,
  WsMessage,
} from '../api/types';
import { mergeRankingDelta } from '../utils/rankingDelta';
import { contestIdFromPathname, realtimeSocketPath } from '../utils/realtime';

/** 同一批提交事件在短时间内合并刷新，避免每次提交都全量拉取。 */
const INVALIDATE_DEBOUNCE_MS = 250;

/**
 * 登录后维持一条 /ws 连接；比赛页/管理端控制台额外订阅 `/ws?contestId=<id>` 房间
 * （切换比赛会重连）。收到 submission.updated 时 debounce 250ms，只失效当前比赛相关的 query；
 * 收到 ranking.delta 时立即把增量合并进 ['official-ranking', contestId] 缓存（无缓存才回退整榜刷新）。
 * 断线自动重连（指数退避，最多 30s）；服务端 1008（未认证）时停止重连。
 */
export function useRealtime(enabled: boolean): void {
  const queryClient = useQueryClient();
  const location = useLocation();
  const contestId = contestIdFromPathname(location.pathname);

  useEffect(() => {
    if (!enabled) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let invalidateTimer: number | undefined;
    let disposed = false;
    let attempts = 0;
    const pendingSubmissionIds = new Set<number>();
    let pendingListRefresh = false;

    const clearHeartbeat = () => {
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    const flushInvalidations = () => {
      invalidateTimer = undefined;
      if (disposed) return;
      const submissionIds = [...pendingSubmissionIds];
      pendingSubmissionIds.clear();
      for (const submissionId of submissionIds) {
        void queryClient.invalidateQueries({ queryKey: ['submission', submissionId] });
      }
      if (!pendingListRefresh) return;
      pendingListRefresh = false;
      void queryClient.invalidateQueries({ queryKey: ['submissions'] });
      if (contestId !== null) {
        // 正式榜由 ranking.delta 即时合并，这里不再整榜失效。
        void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
        void queryClient.invalidateQueries({ queryKey: ['class-stats', contestId] });
        void queryClient.invalidateQueries({ queryKey: ['admin-class-stats', contestId] });
      }
    };

    const scheduleInvalidations = (submissionId: number | undefined) => {
      if (submissionId !== undefined) pendingSubmissionIds.add(submissionId);
      pendingListRefresh = true;
      if (invalidateTimer !== undefined) return;
      invalidateTimer = window.setTimeout(flushInvalidations, INVALIDATE_DEBOUNCE_MS);
    };

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(
        `${protocol}://${window.location.host}${realtimeSocketPath(contestId)}`,
      );

      socket.onopen = () => {
        attempts = 0;
        clearHeartbeat();
        heartbeatTimer = window.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30_000);
      };

      socket.onmessage = (event: MessageEvent) => {
        let message: WsMessage;
        try {
          message = JSON.parse(String(event.data)) as WsMessage;
        } catch {
          return;
        }
        if (message.type === 'ranking.delta') {
          const delta = message.data as RankingDelta | undefined;
          if (!delta || typeof delta.contestId !== 'number' || !Array.isArray(delta.ranks)) {
            return;
          }
          // 每条连接只订阅一个比赛房间，但仍以 payload 的 contestId 为准。
          const queryKey = ['official-ranking', delta.contestId];
          const cached = queryClient.getQueryData<OfficialRanking>(queryKey);
          const merged = mergeRankingDelta(cached, delta);
          if (merged) {
            queryClient.setQueryData(queryKey, merged);
          } else {
            // 没有本地缓存时无法增量合并，退回一次整榜刷新。
            void queryClient.invalidateQueries({ queryKey });
          }
          return;
        }
        if (message.type !== 'submission.updated') return;
        const payload = message.data as SubmissionUpdatedPayload | undefined;
        scheduleInvalidations(payload?.submissionId);
      };

      socket.onclose = (event: CloseEvent) => {
        clearHeartbeat();
        if (disposed || event.code === 1008) return;
        attempts += 1;
        reconnectTimer = window.setTimeout(connect, Math.min(30_000, 3_000 * attempts));
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      if (invalidateTimer !== undefined) window.clearTimeout(invalidateTimer);
      clearHeartbeat();
      socket?.close();
      socket = null;
    };
  }, [enabled, queryClient, contestId]);
}
