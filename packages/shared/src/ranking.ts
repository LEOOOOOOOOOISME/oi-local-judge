import type { RankingRow, RankingSubmission } from './domain.js';
import type { Verdict } from './protocol.js';

interface RankingCell {
  score: number;
  verdict: Verdict | null;
  lastAcAt: number | null;
}

export interface OiRankingInput {
  problemIds: number[];
  userIds: number[];
  submissions: RankingSubmission[];
  freezeAt?: number | null;
}

/**
 * OI 赛制榜单：每题取最高分，总分降序；同分按最后一次 AC 时间升序（早者靠前），
 * 再按 userId 升序稳定排序。封榜时间之前的提交才计入。
 */
export function computeOiRanking(input: OiRankingInput): RankingRow[] {
  const freezeAt = input.freezeAt ?? null;
  const perUser = new Map<number, Map<number, RankingCell>>();

  for (const userId of input.userIds) perUser.set(userId, new Map());

  const visible = input.submissions
    .filter((s) => freezeAt === null || s.createdAt <= freezeAt)
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const submission of visible) {
    const problems = perUser.get(submission.userId);
    if (!problems) continue;
    if (!input.problemIds.includes(submission.problemId)) continue;

    const current: RankingCell = problems.get(submission.problemId) ?? {
      score: 0,
      verdict: null,
      lastAcAt: null,
    };
    const isAc = submission.verdict === 'AC';
    if (submission.score > current.score) current.score = submission.score;
    if (isAc) {
      current.lastAcAt = submission.createdAt;
      current.verdict = 'AC';
    } else if (!current.verdict) {
      current.verdict = submission.verdict;
    }
    problems.set(submission.problemId, current);
  }

  const rows: RankingRow[] = input.userIds.map((userId) => {
    const problems = perUser.get(userId)!;
    let totalScore = 0;
    let solved = 0;
    let lastAcAt: number | null = null;
    const cells = input.problemIds.map((problemId) => {
      const cell = problems.get(problemId) ?? { score: 0, verdict: null, lastAcAt: null };
      totalScore += cell.score;
      if (cell.verdict === 'AC') solved += 1;
      if (cell.lastAcAt !== null && (lastAcAt === null || cell.lastAcAt > lastAcAt)) {
        lastAcAt = cell.lastAcAt;
      }
      return { problemId, ...cell };
    });
    return { rank: 0, userId, totalScore, solved, lastAcAt, problems: cells };
  });

  rows.sort((a, b) => {
    if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (a.lastAcAt !== b.lastAcAt) {
      if (a.lastAcAt === null) return 1;
      if (b.lastAcAt === null) return -1;
      return a.lastAcAt - b.lastAcAt;
    }
    return a.userId - b.userId;
  });

  rows.forEach((row, index) => {
    row.rank = index + 1;
  });
  return rows;
}
