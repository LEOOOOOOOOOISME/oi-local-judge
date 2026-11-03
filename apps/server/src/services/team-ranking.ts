import type { DatabaseSync } from 'node:sqlite';
import { computeRanking, type RankingConfig, type RankingPreset } from '@oij/shared';
import {
  getContest,
  getContestProblemEntries,
  type ContestRow,
} from '../storage/repos/contests.js';
import { listContestTeamRegistrations } from '../storage/repos/contest-teams.js';
import { getProblem } from '../storage/repos/problems.js';
import { listContestSubmissions } from '../storage/repos/submissions.js';

export interface TeamRankingProblem {
  id: number;
  ordinal: number;
  points: number;
  title: string;
}

export interface TeamRankingCell {
  problemId: number;
  score: number;
  verdict: string | null;
  attempts: number;
  firstAcAt: number | null;
}

export interface TeamRankingRow {
  rank: number;
  teamId: number;
  teamName: string;
  memberCount: number;
  totalScore: number;
  solved: number;
  lastAcAt: number | null;
  cells: TeamRankingCell[];
}

export interface TeamRankingResult {
  contest: ContestRow;
  problems: TeamRankingProblem[];
  rows: TeamRankingRow[];
}

/**
 * Team ranking for a contest.
 *
 * Only teams registered for the contest appear. For each registered team, every
 * contest problem takes the best finished, unhacked contest-phase submission
 * among the team's attributed submissions; those per-problem bests are summed.
 *
 * The current implementation uses OI/IOI scoring (sum of per-problem best
 * scores) for every contest mode. ACM/CF-like team scoring (team solve union /
 * penalties) is intentionally left for a follow-up; this still provides the
 * documented "aggregate by the same total score" fallback.
 *
 * `freeze_at` is applied the same way as the existing contest ranking: when it
 * is set, submissions created after it are hidden from the ranking.
 */
export function getTeamRanking(
  db: DatabaseSync,
  contestId: number,
): TeamRankingResult | null {
  const contest = getContest(db, contestId);
  if (!contest) return null;

  const entries = getContestProblemEntries(db, contestId);
  const problems: TeamRankingProblem[] = entries.map((entry) => ({
    id: entry.problem_id,
    ordinal: entry.ordinal,
    points: entry.points,
    title: getProblem(db, entry.problem_id)?.title ?? `#${entry.problem_id}`,
  }));
  const problemIds = problems.map((problem) => problem.id);
  const problemSet = new Set(problemIds);

  const registrations = listContestTeamRegistrations(db, contestId);
  const registrationByTeam = new Map(registrations.map((team) => [team.teamId, team]));
  const teamIds = registrations.map((team) => team.teamId);
  const teamIdSet = new Set(teamIds);

  // `submissions.team_id` is the authoritative attribution written when a team
  // member submits (see contest-teams.resolveSubmissionTeam). Aggregating by
  // attribution instead of current membership keeps later roster changes from
  // rewriting the historical ranking.
  const submissions = listContestSubmissions(db, contestId)
    .filter(
      (submission) =>
        submission.phase === 'contest' &&
        submission.status === 'finished' &&
        submission.hacked_at === null &&
        submission.team_id !== null &&
        teamIdSet.has(submission.team_id) &&
        problemSet.has(submission.problem_id),
    )
    .map((submission) => ({
      userId: submission.team_id as number,
      problemId: submission.problem_id,
      verdict: submission.verdict ?? 'WA',
      score: submission.score,
      createdAt: submission.created_at,
    }));

  // The OI and IOI presets share the same per-problem best-score aggregation and
  // score-based ranking; keeping the contest's own OI/IOI flavour matters for
  // callers that inspect the preset later.
  const preset: RankingPreset = contest.mode === 'ioi' ? 'ioi' : 'oi';
  const config: RankingConfig = {
    preset,
    tie: 'same-rank',
    freezeAt: contest.freeze_at,
  };

  const computed = computeRanking({
    config,
    problemIds,
    userIds: teamIds,
    submissions,
    problemPoints: Object.fromEntries(problems.map((problem) => [problem.id, problem.points])),
  });

  const rows: TeamRankingRow[] = computed.map((row) => {
    const registration = registrationByTeam.get(row.userId)!;
    return {
      rank: row.rank,
      teamId: row.userId,
      teamName: registration.name,
      memberCount: registration.members.length,
      totalScore: row.totalScore,
      solved: row.solved,
      lastAcAt: row.lastAcAt,
      cells: row.cells.map((cell) => ({
        problemId: cell.problemId,
        score: cell.score,
        verdict: cell.verdict,
        attempts: cell.attempts,
        firstAcAt: cell.firstAcAt,
      })),
    };
  });

  return { contest, problems, rows };
}
