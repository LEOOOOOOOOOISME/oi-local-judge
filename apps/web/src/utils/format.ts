/** 统一的展示格式化函数，全部使用固定宽度、无本地化歧义。 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatDateTime(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/** 题目限制：API 用毫秒。 */
export function formatTimeLimit(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms % 1000 === 0) return `${ms / 1000} s`;
  return `${ms} ms`;
}

export function formatMemoryLimit(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return '—';
  return `${mb} MB`;
}

/** 单测试点运行时间（毫秒）。 */
export function formatRunTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** 单测试点内存（KB）。 */
export function formatMemoryKb(kb: number | null | undefined): string {
  if (kb === null || kb === undefined || !Number.isFinite(kb) || kb <= 0) return '—';
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${Math.round(kb)} KB`;
}

/** 倒计时：dd 天 hh:mm:ss 或 hh:mm:ss。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const clock = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
  return days > 0 ? `${days} 天 ${clock}` : clock;
}

/** 相对时间（用于列表的简洁展示）。 */
export function formatRelative(value: string | number | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined || value === '') return '—';
  const time = typeof value === 'number' ? value : new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const diff = now - time;
  if (diff < 0) return formatDateTime(value);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDateTime(value);
}
