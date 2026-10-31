/** datetime-local 输入值与 epoch 毫秒互转（使用浏览器本地时区）。 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function toLocalDateTimeInput(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

export function fromLocalDateTimeInput(value: string): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

/** 新建比赛默认开始时间：当前分钟，结束时间 +7 天。 */
export function defaultContestTimes(): { startAt: number; endAt: number } {
  const start = new Date();
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + 7 * 24 * 3600_000);
  return { startAt: start.getTime(), endAt: end.getTime() };
}
