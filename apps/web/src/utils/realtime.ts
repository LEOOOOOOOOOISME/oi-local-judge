/**
 * realtime 相关的纯函数：从当前 URL 解析比赛 id，并拼接 WS 地址。
 * 单独成文件便于测试，不依赖 React/DOM。
 */

/**
 * 从 `/contest/:id`（含 `/ranking`、`/problem/:id` 等子路由）或
 * `/admin/contests/:id`（含 `/batch` 子路由）解析比赛 id；其余页面返回 null。
 */
export function contestIdFromPathname(pathname: string): number | null {
  const match = /^\/(?:contest|admin\/contests)\/(\d+)(?:\/|$)/.exec(pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** 默认连 `/ws`；比赛页/管理端控制台带 `?contestId=<id>` 以订阅 `contest:<id>` 房间。 */
export function realtimeSocketPath(contestId: number | null): string {
  return contestId === null ? '/ws' : `/ws?contestId=${contestId}`;
}
