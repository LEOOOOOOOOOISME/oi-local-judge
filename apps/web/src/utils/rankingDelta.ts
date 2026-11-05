import type { OfficialRanking, OfficialRankingRow, RankingDelta } from '../api/types';

/**
 * 把一条 `ranking.delta` 合并进本地正式榜缓存，返回新对象（不修改旧对象）。
 *
 * - `changed` 中是完整行，已存在则替换，新用户则插入；
 * - `removed` 删除行；
 * - `ranks` 是服务端新快照的全部 userId/rank，也用于丢弃本地多出来的旧行；
 * - 最后按 rank 升序（同 rank 按 userId）排序；problems/contest/config 等原样保留。
 *
 * 返回值约定：
 * - 没有本地缓存（`current` 为空）→ 返回 null，由调用方决定 invalidate 整榜；
 * - 本地版本不比 delta 旧（例如 HTTP 刷新已经拿到更新的榜单）→ 原样返回 current；
 * - 否则返回合并后的新榜单对象。
 */
export function mergeRankingDelta(
  current: OfficialRanking | null | undefined,
  delta: RankingDelta,
): OfficialRanking | null {
  if (!current) return null;
  if (typeof current.version === 'number' && delta.version <= current.version) {
    return current;
  }

  const rowsByUser = new Map<number, OfficialRankingRow>();
  for (const row of current.rows) rowsByUser.set(row.userId, row);
  for (const row of delta.changed) rowsByUser.set(row.userId, row);
  for (const userId of delta.removed) rowsByUser.delete(userId);

  const rankByUser = new Map<number, number>();
  for (const entry of delta.ranks) rankByUser.set(entry.userId, entry.rank);

  const rows: OfficialRankingRow[] = [];
  for (const [userId, row] of rowsByUser) {
    const rank = rankByUser.get(userId);
    // 服务端快照里已经没有这一行：即使 removed 漏报也一并丢弃，避免脏行。
    if (rank === undefined) continue;
    rows.push(rank === row.rank ? row : { ...row, rank });
  }
  rows.sort((left, right) => left.rank - right.rank || left.userId - right.userId);

  return { ...current, rows, version: delta.version };
}
