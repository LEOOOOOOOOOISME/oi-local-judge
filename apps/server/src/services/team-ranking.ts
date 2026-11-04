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
import { parseRankingConfig } from './official-ranking.js';

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
  penalty: number;
  lastAcAt: number | null;
  cells: TeamRankingCell[];
}

export interface TeamRankingResult {
  contest: ContestRow;
  problems: TeamRankingProblem[];
  rows: TeamRankingRow[];
}

function presetForMode(mode: string): RankingPreset {
  if (mode === 'acm') return 'acm';
  if (mode === 'ioi') return 'ioi';
  if (mode === 'cf-like') return 'cf-like';
  return 'oi';
}

/**
 * Team ranking for a contest.
 *
 * Only teams registered for the contest appear. Submissions are still keyed by
 * `team_id`, so the shared ranking engine sees the whole team as one
 * competitor:
 *
 * - OI/IOI: each problem takes the best member score, and those bests are
 *   summed.
 * - ACM: each problem is solved once when any member first gets AC, and the
 *   team penalty is the first-AC minute plus 20 minutes per wrong attempt
 *   before that first AC.
 * - CF-like: shared CF-like scoring (time decay + penalty), using the
 *   `cfLike` settings from `ranking_rule_json`.
 *
 * The preset comes from the contest ranking config (the same one the official
 * ranking uses), falling back to `contest.mode`; a `plugin:` preset has no
 * team equivalent, so it falls back to the mode's builtin preset.
 *
 * `freeze_at` is applied whenever it is set, matching the previous team
 * ranking behaviour: submissions created after it are hidden from the board.
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

  const parsed = parseRankingConfig(contest);
  const preset: RankingPreset = parsed.pluginName
    ? presetForMode(contest.mode)
    : parsed.config.preset;
  const config: RankingConfig = {
    ...parsed.config,
    preset,
    // Team boards always honour freeze_at when it is configured, regardless of
    // the contest status the official ranking keys its freeze off.
    freezeAt: contest.freeze_at,
  };

  const computed = computeRanking({
    config,
    problemIds,
    userIds: teamIds,
    submissions,
    problemPoints: Object.fromEntries(problems.map((problem) => [problem.id, problem.points])),
    contestStartAt: contest.start_at,
    contestEndAt: contest.end_at,
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
      penalty: row.penalty,
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
