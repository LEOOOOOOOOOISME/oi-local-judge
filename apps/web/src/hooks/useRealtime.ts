import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SubmissionUpdatedPayload, WsMessage } from '../api/types';

/**
 * 登录后维持一条 /ws 连接；收到 submission.updated 时刷新对应提交与列表。
 * 断线自动重连（指数退避，最多 30s）；服务端 1008（未认证）时停止重连。
 */
export function useRealtime(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;
    let disposed = false;
    let attempts = 0;

    const clearHeartbeat = () => {
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

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
        if (message.type !== 'submission.updated') return;
        const payload = message.data as SubmissionUpdatedPayload | undefined;
        if (payload?.submissionId !== undefined) {
          void queryClient.invalidateQueries({ queryKey: ['submission', payload.submissionId] });
        }
        void queryClient.invalidateQueries({ queryKey: ['submissions'] });
        void queryClient.invalidateQueries({ queryKey: ['ranking'] });
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
      clearHeartbeat();
      socket?.close();
      socket = null;
    };
  }, [enabled, queryClient]);
}
