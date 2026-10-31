import type { Contest, RankingRow } from '../api/types';

/** 比赛榜单的题目顺序（来自第一行；空榜时为空）。 */
export function rankingProblemIds(rows: RankingRow[]): number[] {
  return rows[0]?.problems.map((cell) => cell.problemId) ?? [];
}

/**
 * 后端 OI 榜单没有独立罚时字段；这里用“最后 AC 相对开赛的分钟数”作为大屏/CSV 的罚时列，
 * 无 AC 或缺少开赛时间时显示 —。
 */
export function penaltyMinutes(row: RankingRow, contest: Contest | null): number | null {
  if (!contest || contest.start_at === null || row.lastAcAt === null) return null;
  return Math.max(0, Math.round((row.lastAcAt - contest.start_at) / 60_000));
}

export function rankingProblemLetter(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildRankingCsv(
  contest: Contest | null,
  rows: RankingRow[],
  problemIds: number[],
): string {
  const header = [
    '排名',
    '选手',
    '班级',
    '总分',
    ...problemIds.map((_id, index) => rankingProblemLetter(index)),
    '罚时',
  ];
  const lines = rows.map((row) => {
    const penalty = penaltyMinutes(row, contest);
    return [
      String(row.rank),
      row.realName ?? row.username,
      row.className ?? '未分班',
      String(row.totalScore),
      ...problemIds.map((problemId) => String(row.problems.find((cell) => cell.problemId === problemId)?.score ?? 0)),
      penalty === null ? '' : String(penalty),
    ];
  });
  return [header, ...lines]
    .map((line) => line.map((cell) => csvCell(cell)).join(','))
    .join('\r\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
