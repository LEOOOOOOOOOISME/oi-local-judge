import { useEffect, useState } from 'react';

/** 每秒刷新的本地时钟，用于倒计时展示（不轮询服务器）。 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}
