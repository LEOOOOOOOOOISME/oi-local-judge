export type RankingPreset = 'oi' | 'ioi' | 'acm' | 'cf-like';

export interface RankingConfig {
  preset: RankingPreset;
  tie: 'same-rank' | 'none';
  cfLike?: { decay: number };
  freezeAt?: number | null;
}

export interface RankingSubmissionInput {
  userId: number;
  problemId: number;
  verdict: string;
  score: number;
  createdAt: number;
}

export interface RankingCell {
  problemId: number;
  score: number;
  verdict: string | null;
  attempts: number;
  firstAcAt: number | null;
}

export interface RankingRowResult {
  rank: number;
  userId: number;
  totalScore: number;
  solved: number;
  penalty: number;
  lastAcAt: number | null;
  cells: RankingCell[];
}

export interface RankingOfficialScoreInput {
  userId: number;
  problemId: number;
  score: number;
  verdict: string;
}

export interface ComputeRankingInput {
  config: RankingConfig;
  problemIds: number[];
  userIds: number[];
  submissions: RankingSubmissionInput[];
  officialScores?: RankingOfficialScoreInput[];
  /** Authoritative max points per problem, usually contest_problems.points. */
  problemPoints?: Record<number, number>;
  contestStartAt?: number | null;
  contestEndAt?: number | null;
}

const DEFAULT_CF_LIKE_DECAY = 0.5;
const WRONG_ATTEMPT_PENALTY_MINUTES = 20;
const MS_PER_MINUTE = 60_000;

interface CellAccumulator {
  attempts: number;
  bestScore: number;
  bestVerdict: string | null;
  firstAcAt: number | null;
  wrongBeforeAc: number;
}

/**
 * Computes a contest ranking for one of the built-in presets.
 *
 * This is a pure function: it never reads the clock or a database. Callers pass
 * already-visibility-filtered submissions. CF-like is an approximation of the
 * Codeforces scoring model (no hack scores, no problem-specific points table);
 * it must not be described as a complete Codeforces implementation.
 */
export function computeRanking(input: ComputeRankingInput): RankingRowResult[] {
  const problemIds = uniqueNumbers(input.problemIds);
  const userIds = uniqueNumbers(input.userIds);
  const problemSet = new Set(problemIds);
  const userSet = new Set(userIds);
  const freezeAt = input.config.freezeAt ?? null;

  const visible = input.submissions
    .filter(
      (submission) =>
        userSet.has(submission.userId) &&
        problemSet.has(submission.problemId) &&
        (freezeAt === null || submission.createdAt <= freezeAt),
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  const cellsByUser = new Map<number, Map<number, CellAccumulator>>();
  for (const userId of userIds) cellsByUser.set(userId, new Map());

  for (const submission of visible) {
    const userCells = cellsByUser.get(submission.userId);
    if (!userCells) continue;
    let cell = userCells.get(submission.problemId);
    if (!cell) {
      cell = {
        attempts: 0,
        bestScore: 0,
        bestVerdict: null,
        firstAcAt: null,
        wrongBeforeAc: 0,
      };
      userCells.set(submission.problemId, cell);
    }

    cell.attempts += 1;
    if (submission.score > cell.bestScore) {
      cell.bestScore = submission.score;
      cell.bestVerdict = submission.verdict;
    } else if (submission.score === cell.bestScore && cell.bestVerdict === null) {
      cell.bestVerdict = submission.verdict;
    }

    if (submission.verdict === 'AC') {
      if (cell.firstAcAt === null) cell.firstAcAt = submission.createdAt;
    } else if (cell.firstAcAt === null) {
      cell.wrongBeforeAc += 1;
    }
  }

  const officialByCell = new Map<string, { score: number; verdict: string }>();
  for (const official of input.officialScores ?? []) {
    if (!userSet.has(official.userId) || !problemSet.has(official.problemId)) continue;
    officialByCell.set(cellKey(official.userId, official.problemId), {
      score: official.score,
      verdict: official.verdict,
    });
  }

  const contestStartAt = input.contestStartAt ?? null;
  const contestEndAt = input.contestEndAt ?? null;
  const contestDuration =
    contestStartAt !== null && contestEndAt !== null && contestEndAt > contestStartAt
      ? contestEndAt - contestStartAt
      : null;
  const cfLikeDecay = input.config.cfLike?.decay ?? DEFAULT_CF_LIKE_DECAY;
  const inferredPoints = collectProblemPoints(input.config.preset, visible);
  const explicitPoints = new Map<number, number>();
  for (const [key, value] of Object.entries(input.problemPoints ?? {})) {
    const id = Number(key);
    if (Number.isFinite(id) && Number.isFinite(value)) explicitPoints.set(id, value);
  }
  const problemPoints = (problemId: number): number =>
    explicitPoints.get(problemId) ?? inferredPoints.get(problemId) ?? 0;

  const rows: RankingRowResult[] = userIds.map((userId) => {
    let totalScore = 0;
    let solved = 0;
    let penalty = 0;
    let lastAcAt: number | null = null;

    const cells: RankingCell[] = problemIds.map((problemId) => {
      const cell = cellsByUser.get(userId)?.get(problemId);
      const attempts = cell?.attempts ?? 0;
      const firstAcAt = cell?.firstAcAt ?? null;

      if (input.config.preset === 'oi' || input.config.preset === 'ioi') {
        const official = officialByCell.get(cellKey(userId, problemId));
        const cellSolved = official ? official.verdict === 'AC' : firstAcAt !== null;
        const score = official ? official.score : (cell?.bestScore ?? 0);
        const verdict = official
          ? official.verdict
          : firstAcAt !== null
            ? 'AC'
            : (cell?.bestVerdict ?? null);
        totalScore += score;
        if (cellSolved) solved += 1;
        return { problemId, score, verdict, attempts, firstAcAt };
      }

      if (firstAcAt === null || !cell) {
        return { problemId, score: 0, verdict: cell?.bestVerdict ?? null, attempts, firstAcAt };
      }

      solved += 1;
      let score = 1;
      if (input.config.preset === 'cf-like') {
        const points = problemPoints(problemId);
        const elapsed = contestStartAt === null ? 0 : Math.max(0, firstAcAt - contestStartAt);
        const factor =
          contestDuration === null ? 1 : 1 - cfLikeDecay * (elapsed / contestDuration);
        score = Math.max(0, Math.round(points * factor));
      }
      penalty += acPenalty(firstAcAt, cell.wrongBeforeAc, contestStartAt);
      lastAcAt = lastAcAt === null ? firstAcAt : Math.max(lastAcAt, firstAcAt);
      totalScore += score;
      return { problemId, score, verdict: 'AC', attempts, firstAcAt };
    });

    return { rank: 0, userId, totalScore, solved, penalty, lastAcAt, cells };
  });

  assignRanks(rows, input.config.preset, input.config.tie);
  return rows;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function cellKey(userId: number, problemId: number): string {
  return `${userId}:${problemId}`;
}

/**
 * CF-like falls back to the best AC score when the caller does not provide
 * authoritative contest problem points. Services should pass problemPoints.
 */
function collectProblemPoints(
  preset: RankingPreset,
  submissions: RankingSubmissionInput[],
): Map<number, number> {
  const points = new Map<number, number>();
  if (preset !== 'cf-like') return points;
  for (const submission of submissions) {
    if (submission.verdict !== 'AC') continue;
    if (submission.score > (points.get(submission.problemId) ?? 0)) {
      points.set(submission.problemId, submission.score);
    }
  }
  return points;
}

function acPenalty(
  firstAcAt: number,
  wrongBeforeAc: number,
  contestStartAt: number | null,
): number {
  const minutes =
    contestStartAt === null
      ? 0
      : Math.max(0, Math.floor((firstAcAt - contestStartAt) / MS_PER_MINUTE));
  return minutes + wrongBeforeAc * WRONG_ATTEMPT_PENALTY_MINUTES;
}

function compareNullableAsc(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

function assignRanks(
  rows: RankingRowResult[],
  preset: RankingPreset,
  tie: 'same-rank' | 'none',
): void {
  const isOi = preset === 'oi' || preset === 'ioi';
  const isAcm = preset === 'acm';

  rows.sort((a, b) => {
    if (isOi) {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      return a.userId - b.userId;
    }
    if (isAcm && b.solved !== a.solved) return b.solved - a.solved;
    if (!isAcm && b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
    if (a.penalty !== b.penalty) return a.penalty - b.penalty;
    const lastAcOrder = compareNullableAsc(a.lastAcAt, b.lastAcAt);
    if (lastAcOrder !== 0) return lastAcOrder;
    return a.userId - b.userId;
  });

  rows.forEach((row, index) => {
    if (tie === 'none') {
      row.rank = index + 1;
      return;
    }
    if (index === 0) {
      row.rank = 1;
      return;
    }
    const previous = rows[index - 1];
    let sameRank: boolean;
    if (isOi) {
      sameRank = row.totalScore === previous.totalScore;
    } else if (isAcm) {
      sameRank =
        row.solved === previous.solved &&
        row.penalty === previous.penalty &&
        row.lastAcAt === previous.lastAcAt;
    } else {
      sameRank =
        row.totalScore === previous.totalScore &&
        row.penalty === previous.penalty &&
        row.lastAcAt === previous.lastAcAt;
    }
    row.rank = sameRank ? previous.rank : index + 1;
  });
}
