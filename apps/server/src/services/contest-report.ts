import type { DatabaseSync } from 'node:sqlite';
import {
  getContest,
  getParticipants,
  type ContestRow,
} from '../storage/repos/contests.js';
import { listRegistrationsWithStats } from '../storage/repos/contest-registrations.js';
import { listContestSubmissions, type SubmissionRow } from '../storage/repos/submissions.js';
import { getOfficialRanking, type OfficialRankingRow } from './official-ranking.js';
import { getTeamRanking, type TeamRankingRow } from './team-ranking.js';

export interface ContestReportParticipantStats {
  total: number;
  accepted: number;
  pending: number;
  rejected: number;
  /** Accepted participants that checked in. */
  checkedIn: number;
}

export interface ContestReportSubmissionStats {
  total: number;
  /** Submission count per verdict; submissions without a verdict use the key `none`. */
  byVerdict: Record<string, number>;
  /** Submission count per judge status. */
  byStatus: Record<string, number>;
}

export interface ContestReportProblemStats {
  problemId: number;
  ordinal: number;
  title: string;
  points: number;
  submissions: number;
  acSubmissions: number;
  /** Distinct users with at least one AC submission on this problem. */
  acUsers: number;
  /** AC submissions / submissions, as a 0-100 percentage rounded to one decimal. */
  acRate: number;
  /** Mean of each accepted participant's best score on this problem. */
  averageScore: number;
  /** Highest best score of any user on this problem. */
  maxScore: number;
}

export interface ContestReportTeamStats {
  teamCount: number;
  rows: TeamRankingRow[];
}

export interface ContestReport {
  generatedAt: number;
  contest: ContestRow;
  participants: ContestReportParticipantStats;
  submissions: ContestReportSubmissionStats;
  problems: ContestReportProblemStats[];
  /** Visible official-ranking rows only; hidden participants are never included. */
  ranking: OfficialRankingRow[];
  /** Number of visible ranking rows before the `top` limit was applied. */
  rankingTotal: number;
  /** Present only for contests that accept teams. */
  teamStats: ContestReportTeamStats | null;
}

export interface ContestReportOptions {
  /** Keep only the first N rows of the individual ranking. */
  top?: number;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((key) => [key, counts[key]]),
  );
}

function problemStats(
  submissions: SubmissionRow[],
  acceptedUserIds: number[],
  problems: Array<{ id: number; ordinal: number; points: number; title: string }>,
): ContestReportProblemStats[] {
  const byProblem = new Map<
    number,
    { submissions: number; acSubmissions: number; acUsers: Set<number>; best: Map<number, number> }
  >();
  for (const submission of submissions) {
    const entry = byProblem.get(submission.problem_id) ?? {
      submissions: 0,
      acSubmissions: 0,
      acUsers: new Set<number>(),
      best: new Map<number, number>(),
    };
    entry.submissions += 1;
    if (submission.verdict === 'AC') {
      entry.acSubmissions += 1;
      entry.acUsers.add(submission.user_id);
    }
    const previousBest = entry.best.get(submission.user_id);
    if (previousBest === undefined || submission.score > previousBest) {
      entry.best.set(submission.user_id, submission.score);
    }
    byProblem.set(submission.problem_id, entry);
  }

  return problems.map((problem) => {
    const entry = byProblem.get(problem.id) ?? {
      submissions: 0,
      acSubmissions: 0,
      acUsers: new Set<number>(),
      best: new Map<number, number>(),
    };
    const bestScores = acceptedUserIds.map((userId) => entry.best.get(userId) ?? 0);
    const averageScore =
      bestScores.length === 0
        ? 0
        : round1(bestScores.reduce((sum, score) => sum + score, 0) / bestScores.length);
    let maxScore = 0;
    for (const score of entry.best.values()) {
      if (score > maxScore) maxScore = score;
    }
    return {
      problemId: problem.id,
      ordinal: problem.ordinal,
      title: problem.title,
      points: problem.points,
      submissions: entry.submissions,
      acSubmissions: entry.acSubmissions,
      acUsers: entry.acUsers.size,
      acRate:
        entry.submissions === 0 ? 0 : round1((entry.acSubmissions / entry.submissions) * 100),
      averageScore,
      maxScore,
    };
  });
}

function participantStats(db: DatabaseSync, contestId: number): ContestReportParticipantStats {
  const rows = listRegistrationsWithStats(db, contestId);
  const accepted = rows.filter((row) => row.status === 'accepted');
  return {
    total: rows.length,
    accepted: accepted.length,
    pending: rows.filter((row) => row.status === 'pending').length,
    rejected: rows.filter((row) => row.status === 'rejected').length,
    checkedIn: accepted.filter((row) => row.checked_in_at !== null).length,
  };
}

/**
 * Builds the administrator contest result report.
 *
 * The individual ranking reuses the cached official-ranking snapshot, so hidden
 * participants are excluded exactly as on the public board and a report request
 * does not recompute the ranking from scratch. All submission statistics are
 * derived from a single `listContestSubmissions` query to avoid N+1 reads.
 */
export async function buildContestReport(
  db: DatabaseSync,
  contestId: number,
  dataDir = process.cwd(),
  options: ContestReportOptions = {},
): Promise<ContestReport | null> {
  const contest = getContest(db, contestId);
  if (!contest) return null;

  const ranking = await getOfficialRanking(db, contestId, dataDir);
  if (!ranking) return null;

  const submissions = listContestSubmissions(db, contestId);
  const acceptedUserIds = getParticipants(db, contestId);
  const top =
    options.top !== undefined && options.top > 0 ? Math.floor(options.top) : undefined;
  const teamRanking = contest.team_mode === 'individual' ? null : getTeamRanking(db, contestId);

  return {
    generatedAt: Date.now(),
    contest,
    participants: participantStats(db, contestId),
    submissions: {
      total: submissions.length,
      byVerdict: tally(submissions.map((submission) => submission.verdict ?? 'none')),
      byStatus: tally(submissions.map((submission) => submission.status)),
    },
    problems: problemStats(submissions, acceptedUserIds, ranking.problems),
    ranking: top === undefined ? ranking.rows : ranking.rows.slice(0, top),
    rankingTotal: ranking.rows.length,
    teamStats: teamRanking
      ? { teamCount: teamRanking.rows.length, rows: teamRanking.rows }
      : null,
  };
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}

function isoTime(value: number | null): string {
  return value === null ? '' : new Date(value).toISOString();
}

function scoreCell(value: number | undefined): number {
  return value ?? 0;
}

/**
 * Serializes a report as a single UTF-8 CSV document (with a BOM so spreadsheet
 * programs detect the encoding). Sections share a fixed column order; the
 * per-problem columns of the ranking tables follow the contest's problem order.
 */
export function contestReportToCsv(report: ContestReport): string {
  const lines: string[] = [];
  const blank = () => lines.push('');
  const problemCells = (cells: Array<{ problemId: number; score: number }>) => {
    const byProblem = new Map(cells.map((cell) => [cell.problemId, cell.score]));
    return report.problems.map((problem) => scoreCell(byProblem.get(problem.problemId)));
  };
  const problemHeaders = report.problems.map(
    (problem) => `第${problem.ordinal}题 ${problem.title}`,
  );

  lines.push('比赛成绩报告');
  lines.push(csvLine(['比赛ID', report.contest.id]));
  lines.push(csvLine(['比赛名称', report.contest.name]));
  lines.push(csvLine(['赛制', report.contest.mode]));
  lines.push(csvLine(['团队模式', report.contest.team_mode]));
  lines.push(csvLine(['比赛状态', report.contest.status]));
  lines.push(csvLine(['开始时间', isoTime(report.contest.start_at)]));
  lines.push(csvLine(['结束时间', isoTime(report.contest.end_at)]));
  lines.push(csvLine(['封榜时间', isoTime(report.contest.freeze_at)]));
  lines.push(csvLine(['生成时间', new Date(report.generatedAt).toISOString()]));
  blank();

  lines.push('参与者统计');
  lines.push(csvLine(['指标', '数值']));
  lines.push(csvLine(['总人数', report.participants.total]));
  lines.push(csvLine(['已通过', report.participants.accepted]));
  lines.push(csvLine(['待审核', report.participants.pending]));
  lines.push(csvLine(['已拒绝', report.participants.rejected]));
  lines.push(csvLine(['已签到', report.participants.checkedIn]));
  blank();

  lines.push('提交统计');
  lines.push(csvLine(['指标', '数值']));
  lines.push(csvLine(['提交总数', report.submissions.total]));
  for (const [verdict, count] of Object.entries(report.submissions.byVerdict)) {
    lines.push(csvLine([`verdict:${verdict}`, count]));
  }
  for (const [status, count] of Object.entries(report.submissions.byStatus)) {
    lines.push(csvLine([`status:${status}`, count]));
  }
  blank();

  lines.push('题目统计');
  lines.push(
    csvLine(['题号', '题目ID', '题目', '分值', '提交数', 'AC人数', 'AC率', '平均分', '最高分']),
  );
  for (const problem of report.problems) {
    lines.push(
      csvLine([
        problem.ordinal,
        problem.problemId,
        problem.title,
        problem.points,
        problem.submissions,
        problem.acUsers,
        `${problem.acRate.toFixed(1)}%`,
        problem.averageScore.toFixed(1),
        problem.maxScore,
      ]),
    );
  }
  blank();

  lines.push('个人成绩');
  lines.push(
    csvLine([
      '名次',
      '用户ID',
      '用户名',
      '姓名',
      '班级',
      '总分',
      '通过数',
      '罚时',
      '最后AC',
      ...problemHeaders,
    ]),
  );
  for (const row of report.ranking) {
    lines.push(
      csvLine([
        row.rank,
        row.userId,
        row.username,
        row.realName,
        row.className,
        row.totalScore,
        row.solved,
        row.penalty,
        isoTime(row.lastAcAt),
        ...problemCells(row.cells),
      ]),
    );
  }

  if (report.teamStats) {
    blank();
    lines.push('团队成绩');
    lines.push(
      csvLine([
        '名次',
        '团队ID',
        '团队名称',
        '成员数',
        '总分',
        '通过数',
        '罚时',
        '最后AC',
        ...problemHeaders,
      ]),
    );
    for (const row of report.teamStats.rows) {
      lines.push(
        csvLine([
          row.rank,
          row.teamId,
          row.teamName,
          row.memberCount,
          row.totalScore,
          row.solved,
          row.penalty,
          isoTime(row.lastAcAt),
          ...problemCells(row.cells),
        ]),
      );
    }
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
