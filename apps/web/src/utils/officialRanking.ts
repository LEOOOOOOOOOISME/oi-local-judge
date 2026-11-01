import { ApiError, apiGet } from '../api/client';
import type {
  Contest,
  OfficialRanking,
  OfficialRankingCell,
  OfficialRankingProblem,
  OfficialRankingRow,
  RankingPreset,
  RankingRow,
} from '../api/types';
import { rankingProblemLetter } from './ranking';

export const PRESET_LABEL: Record<RankingPreset, string> = {
  oi: 'OI 正式榜',
  ioi: 'IOI 正式榜',
  acm: 'ACM 正式榜',
  'cf-like': 'CF-like 正式榜',
};

export function presetLabel(preset: string): string {
  if (preset.startsWith('plugin:')) return `插件：${preset.slice('plugin:'.length)}`;
  return PRESET_LABEL[preset as RankingPreset] ?? preset;
}

export function presetFromMode(mode: string | undefined): RankingPreset {
  if (mode === 'acm') return 'acm';
  if (mode === 'ioi') return 'ioi';
  return 'oi';
}

function legacyPenalty(row: RankingRow, contest: Contest): number {
  if (contest.start_at === null || row.lastAcAt === null) return 0;
  return Math.max(0, Math.round((row.lastAcAt - contest.start_at) / 60_000));
}

/**
 * 旧 /ranking 接口兼容转换：official-ranking 404 时使用。
 * 旧接口没有 attempts/points，转换时以 0 补齐；题目标题退化为 #id。
 */
export function legacyRankingToOfficial(
  contest: Contest,
  rows: RankingRow[],
): OfficialRanking {
  const problems: OfficialRankingProblem[] = (rows[0]?.problems ?? []).map((cell, index) => ({
    id: cell.problemId,
    ordinal: index + 1,
    points: 0,
    title: `#${cell.problemId}`,
  }));
  const preset = presetFromMode(contest.mode);
  const officialRows: OfficialRankingRow[] = rows.map((row) => ({
    rank: row.rank,
    userId: row.userId,
    totalScore: row.totalScore,
    solved: row.solved,
    penalty: legacyPenalty(row, contest),
    lastAcAt: row.lastAcAt,
    cells: row.problems.map(
      (cell): OfficialRankingCell => ({
        problemId: cell.problemId,
        score: cell.score,
        verdict: cell.verdict,
        attempts: 0,
        firstAcAt: cell.lastAcAt,
      }),
    ),
    username: row.username,
    realName: row.realName,
    className: row.className,
  }));
  return {
    contest,
    problems,
    rows: officialRows,
    config: { preset, tie: 'same-rank', freezeAt: null },
    archived: false,
    preset,
  };
}

async function fetchLegacyRanking(contestId: number): Promise<OfficialRanking> {
  const [legacyRows, contests] = await Promise.all([
    apiGet<RankingRow[]>(`/api/contests/${contestId}/ranking`),
    apiGet<Contest[]>('/api/contests'),
  ]);
  const contest = contests.find((item) => item.id === contestId);
  if (!contest) throw new ApiError(404, '比赛不存在', 'NOT_FOUND');
  return legacyRankingToOfficial(contest, legacyRows);
}

/** 优先正式榜；仅 404（旧后端/旧比赛数据）回退旧 /ranking。 */
export async function fetchOfficialRanking(contestId: number): Promise<OfficialRanking> {
  try {
    return await apiGet<OfficialRanking>(`/api/contests/${contestId}/official-ranking`);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    try {
      return await fetchLegacyRanking(contestId);
    } catch {
      throw error;
    }
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 正式榜 CSV：名次/用户名/姓名/班级/总分/各题/罚时。 */
export function buildOfficialRankingCsv(data: OfficialRanking): string {
  const header = [
    '排名',
    '用户名',
    '姓名',
    '班级',
    '总分',
    ...data.problems.map((_problem, index) => rankingProblemLetter(index)),
    '罚时',
  ];
  const lines = data.rows.map((row) => [
    String(row.rank),
    row.username,
    row.realName ?? '',
    row.className ?? '未分班',
    String(row.totalScore),
    ...data.problems.map(
      (problem) => String(row.cells.find((cell) => cell.problemId === problem.id)?.score ?? 0),
    ),
    String(row.penalty),
  ]);
  return [header, ...lines]
    .map((line) => line.map((cell) => csvCell(cell)).join(','))
    .join('\r\n');
}
