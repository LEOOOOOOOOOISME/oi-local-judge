import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { registerContestRoutes } from '../src/http/contests.js';
import { getTeamRanking } from '../src/services/team-ranking.js';
import { insertContestTeamRegistration } from '../src/storage/repos/contest-teams.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createHack } from '../src/storage/repos/hacks.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { insertTeam, insertTeamMember } from '../src/storage/repos/teams.js';
import { createUser } from '../src/storage/repos/users.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

interface UserIds {
  alice: number;
  bob: number;
  carol: number;
  dave: number;
}

interface Ctx {
  db: DatabaseSync;
  users: UserIds;
  p1: number;
  p2: number;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'oij-team-ranking-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  const users: UserIds = {
    alice: createUser(db, { username: 'alice', passwordHash: 'x' }),
    bob: createUser(db, { username: 'bob', passwordHash: 'x' }),
    carol: createUser(db, { username: 'carol', passwordHash: 'x' }),
    dave: createUser(db, { username: 'dave', passwordHash: 'x' }),
  };
  const p1 = createProblem(db, {
    title: 'P1',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  const p2 = createProblem(db, {
    title: 'P2',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '2.in', outputPath: '2.out', points: 100 }],
  });
  return { db, users, p1, p2 };
}

function makeContest(
  ctx: Ctx,
  input: {
    mode?: string;
    freezeAt?: number | null;
    startAt?: number;
    endAt?: number;
  } = {},
): number {
  return createContest(ctx.db, {
    name: `Team Ranking ${input.mode ?? 'oi'}`,
    mode: input.mode ?? 'oi',
    teamMode: 'team',
    startAt: input.startAt ?? 0,
    endAt: input.endAt ?? 10_000,
    freezeAt: input.freezeAt ?? null,
    problemIds: [ctx.p1, ctx.p2],
  });
}

function setRankingRule(
  ctx: Ctx,
  contestId: number,
  rule: Record<string, unknown>,
): void {
  ctx.db
    .prepare('UPDATE contests SET ranking_rule_json = ? WHERE id = ?')
    .run(JSON.stringify(rule), contestId);
}

function makeTeam(
  ctx: Ctx,
  input: { name: string; ownerId: number; memberIds?: number[] },
): number {
  const teamId = insertTeam(ctx.db, { name: input.name, ownerId: input.ownerId, createdAt: 1 });
  insertTeamMember(ctx.db, {
    teamId,
    userId: input.ownerId,
    role: 'captain',
    joinedAt: 1,
  });
  for (const userId of input.memberIds ?? []) {
    insertTeamMember(ctx.db, { teamId, userId, role: 'member', joinedAt: 1 });
  }
  return teamId;
}

function registerTeam(ctx: Ctx, contestId: number, teamId: number): void {
  insertContestTeamRegistration(ctx.db, {
    contestId,
    teamId,
    registeredBy: null,
    registeredAt: 1,
  });
}

function addSubmission(
  ctx: Ctx,
  input: {
    contestId: number;
    problemId: number;
    userId: number;
    teamId?: number | null;
    verdict: string;
    score: number;
    createdAt: number;
    phase?: string;
    status?: string;
    hackedAt?: number | null;
  },
): number {
  const id = createSubmission(ctx.db, {
    contestId: input.contestId,
    problemId: input.problemId,
    userId: input.userId,
    teamId: input.teamId ?? null,
    language: 'cpp17',
    sourcePath: 'x.cpp',
    sourceHash: 'h',
    phase: input.phase ?? 'contest',
    createdAt: input.createdAt,
  });
  ctx.db
    .prepare(
      `UPDATE submissions SET verdict = ?, score = ?, created_at = ?, phase = ?, status = ?,
         hacked_at = ? WHERE id = ?`,
    )
    .run(
      input.verdict,
      input.score,
      input.createdAt,
      input.phase ?? 'contest',
      input.status ?? 'finished',
      input.hackedAt ?? null,
      id,
    );
  return id;
}

function addHack(
  ctx: Ctx,
  input: {
    contestId: number;
    problemId: number;
    hackerId: number;
    targetSubmissionId: number;
    teamId?: number | null;
    status?: string;
    createdAt?: number;
  },
): number {
  const id = createHack(ctx.db, {
    contestId: input.contestId,
    problemId: input.problemId,
    hackerId: input.hackerId,
    targetSubmissionId: input.targetSubmissionId,
    teamId: input.teamId ?? null,
    inputPath: 'hacks/h.in',
  });
  const createdAt = input.createdAt ?? 100;
  ctx.db
    .prepare('UPDATE contest_hacks SET status = ?, created_at = ?, judged_at = ? WHERE id = ?')
    .run(input.status ?? 'success', createdAt, createdAt, id);
  return id;
}

describe('team ranking service', () => {
  it('takes the best member score per problem and sums it per registered team', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, {
      name: 'Alpha',
      ownerId: ctx.users.alice,
      memberIds: [ctx.users.bob],
    });
    const beta = makeTeam(ctx, {
      name: 'Beta',
      ownerId: ctx.users.carol,
      memberIds: [ctx.users.dave],
    });
    registerTeam(ctx, contestId, alpha);
    registerTeam(ctx, contestId, beta);

    // Alpha: p1 best is bob's 100 (not 60 + 100); p2 best is alice's 100.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'WA',
      score: 60,
      createdAt: 100,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'WA',
      score: 100,
      createdAt: 200,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p2,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 300,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p2,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'WA',
      score: 40,
      createdAt: 400,
    });

    // Beta: 100 + 50 = 150.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.carol,
      teamId: beta,
      verdict: 'AC',
      score: 100,
      createdAt: 100,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p2,
      userId: ctx.users.dave,
      teamId: beta,
      verdict: 'WA',
      score: 30,
      createdAt: 200,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p2,
      userId: ctx.users.carol,
      teamId: beta,
      verdict: 'WA',
      score: 50,
      createdAt: 300,
    });

    const ranking = getTeamRanking(ctx.db, contestId)!;
    expect(ranking.rows).toHaveLength(2);
    expect(ranking.rows.map((row) => row.teamName)).toEqual(['Alpha', 'Beta']);

    const [alphaRow, betaRow] = ranking.rows;
    expect(alphaRow).toMatchObject({
      rank: 1,
      teamId: alpha,
      teamName: 'Alpha',
      memberCount: 2,
      totalScore: 200,
      solved: 1,
    });
    expect(alphaRow?.cells).toEqual([
      { problemId: ctx.p1, score: 100, verdict: 'WA', attempts: 2, firstAcAt: null },
      { problemId: ctx.p2, score: 100, verdict: 'AC', attempts: 2, firstAcAt: 300 },
    ]);

    expect(betaRow).toMatchObject({
      rank: 2,
      teamId: beta,
      teamName: 'Beta',
      memberCount: 2,
      totalScore: 150,
      solved: 1,
    });
  });

  it('scores ACM teams by the union of problems solved by different members', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, {
      mode: 'acm',
      startAt: 0,
      endAt: 2 * 60 * 60 * 1000,
    });
    const alpha = makeTeam(ctx, {
      name: 'Alpha',
      ownerId: ctx.users.alice,
      memberIds: [ctx.users.bob],
    });
    registerTeam(ctx, contestId, alpha);

    // Alice solves p1 after 1 minute, Bob solves p2 after 2 minutes.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 60_000,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p2,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 120_000,
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row).toMatchObject({
      solved: 2,
      totalScore: 2,
      penalty: 3,
      lastAcAt: 120_000,
    });
    expect(row.cells).toEqual([
      { problemId: ctx.p1, score: 1, verdict: 'AC', attempts: 1, firstAcAt: 60_000 },
      { problemId: ctx.p2, score: 1, verdict: 'AC', attempts: 1, firstAcAt: 120_000 },
    ]);
  });

  it('adds every team-member failure before the first AC to the ACM penalty', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, {
      mode: 'acm',
      startAt: 0,
      endAt: 2 * 60 * 60 * 1000,
    });
    const alpha = makeTeam(ctx, {
      name: 'Alpha',
      ownerId: ctx.users.alice,
      memberIds: [ctx.users.bob],
    });
    registerTeam(ctx, contestId, alpha);

    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'WA',
      score: 0,
      createdAt: 60_000,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'WA',
      score: 0,
      createdAt: 120_000,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 180_000,
    });
    // Wrong submissions after the first team AC must not add penalty.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'WA',
      score: 0,
      createdAt: 240_000,
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row.solved).toBe(1);
    expect(row.penalty).toBe(3 + 2 * 20);
    expect(row.cells[0]).toMatchObject({
      problemId: ctx.p1,
      score: 1,
      verdict: 'AC',
      attempts: 4,
      firstAcAt: 180_000,
    });
  });

  it('counts repeated ACs on the same problem only once for a team', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, {
      mode: 'acm',
      startAt: 0,
      endAt: 2 * 60 * 60 * 1000,
    });
    const alpha = makeTeam(ctx, {
      name: 'Alpha',
      ownerId: ctx.users.alice,
      memberIds: [ctx.users.bob],
    });
    registerTeam(ctx, contestId, alpha);

    for (const [userId, createdAt] of [
      [ctx.users.alice, 60_000],
      [ctx.users.bob, 120_000],
      [ctx.users.alice, 180_000],
    ] as const) {
      addSubmission(ctx, {
        contestId,
        problemId: ctx.p1,
        userId,
        teamId: alpha,
        verdict: 'AC',
        score: 100,
        createdAt,
      });
    }

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row.solved).toBe(1);
    expect(row.penalty).toBe(1);
    expect(row.cells[0]).toMatchObject({ attempts: 3, firstAcAt: 60_000 });
  });

  it('hides ACM team submissions created after freeze_at', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, {
      mode: 'acm',
      freezeAt: 1000,
      startAt: 0,
      endAt: 2 * 60 * 60 * 1000,
    });
    const alpha = makeTeam(ctx, {
      name: 'Alpha',
      ownerId: ctx.users.alice,
      memberIds: [ctx.users.bob],
    });
    registerTeam(ctx, contestId, alpha);

    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 500,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p2,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 1500,
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row.solved).toBe(1);
    expect(row.cells[1]).toMatchObject({
      problemId: ctx.p2,
      score: 0,
      verdict: null,
      firstAcAt: null,
    });
  });

  it('scores CF-like teams with the shared CF formula', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, {
      mode: 'acm',
      startAt: 0,
      endAt: 100 * 60 * 1000,
    });
    setRankingRule(ctx, contestId, {
      preset: 'cf-like',
      tie: 'same-rank',
      cfLike: { decay: 0.5 },
    });
    const alpha = makeTeam(ctx, {
      name: 'Alpha',
      ownerId: ctx.users.alice,
      memberIds: [ctx.users.bob],
    });
    registerTeam(ctx, contestId, alpha);

    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 0,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p2,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 50 * 60 * 1000,
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row.solved).toBe(2);
    expect(row.totalScore).toBe(175);
    expect(row.penalty).toBe(50);
    expect(row.cells.map((cell) => cell.score)).toEqual([100, 75]);
  });

  it('adds successful CF-like team hacks, subtracts failed ones and ignores individual hacks', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, {
      mode: 'acm',
      startAt: 0,
      endAt: 100 * 60 * 1000,
    });
    setRankingRule(ctx, contestId, {
      preset: 'cf-like',
      tie: 'same-rank',
      cfLike: { decay: 0.5, hackPoints: 100, failedHackPenalty: 50 },
    });
    // Beta is created first so it has the lower team id and wins the
    // pre-hack tie-break; Alpha's hack must flip the order.
    const beta = makeTeam(ctx, { name: 'Beta', ownerId: ctx.users.carol });
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice });
    registerTeam(ctx, contestId, beta);
    registerTeam(ctx, contestId, alpha);

    const alphaSubmission = addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 0,
    });
    const betaSubmission = addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.carol,
      teamId: beta,
      verdict: 'AC',
      score: 100,
      createdAt: 0,
    });

    const before = getTeamRanking(ctx.db, contestId)!;
    expect(before.rows.map((row) => [row.teamName, row.rank, row.totalScore])).toEqual([
      ['Beta', 1, 100],
      ['Alpha', 1, 100],
    ]);

    addHack(ctx, {
      contestId,
      problemId: ctx.p1,
      hackerId: ctx.users.alice,
      targetSubmissionId: betaSubmission,
      teamId: alpha,
      status: 'success',
    });
    addHack(ctx, {
      contestId,
      problemId: ctx.p1,
      hackerId: ctx.users.alice,
      targetSubmissionId: betaSubmission,
      teamId: alpha,
      status: 'failed',
    });
    // Bob represents no team: his success must not reach any team row.
    addHack(ctx, {
      contestId,
      problemId: ctx.p1,
      hackerId: ctx.users.bob,
      targetSubmissionId: alphaSubmission,
      teamId: null,
      status: 'success',
    });

    const after = getTeamRanking(ctx.db, contestId)!;
    expect(after.rows.map((row) => row.teamName)).toEqual(['Alpha', 'Beta']);
    expect(after.rows[0]).toMatchObject({
      rank: 1,
      teamId: alpha,
      totalScore: 150,
      hackScore: 50,
      solved: 1,
    });
    expect(after.rows[1]).toMatchObject({
      rank: 2,
      teamId: beta,
      totalScore: 100,
      hackScore: 0,
      solved: 1,
    });
  });

  it('treats promoted hacks as successful CF-like team hacks', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, { startAt: 0, endAt: 100 * 60 * 1000 });
    setRankingRule(ctx, contestId, {
      preset: 'cf-like',
      tie: 'same-rank',
      cfLike: { decay: 0.5 },
    });
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice });
    registerTeam(ctx, contestId, alpha);
    const submissionId = addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 0,
    });

    addHack(ctx, {
      contestId,
      problemId: ctx.p1,
      hackerId: ctx.users.alice,
      targetSubmissionId: submissionId,
      teamId: alpha,
      status: 'promoted',
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row).toMatchObject({ totalScore: 200, hackScore: 100, solved: 1 });
  });

  it('ignores legacy hacks whose team attribution is null', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, { startAt: 0, endAt: 100 * 60 * 1000 });
    setRankingRule(ctx, contestId, {
      preset: 'cf-like',
      tie: 'same-rank',
      cfLike: { decay: 0.5 },
    });
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice });
    registerTeam(ctx, contestId, alpha);
    const submissionId = addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 0,
    });

    // Simulates a row created before contest_hacks.team_id existed: no value
    // for the column, so it reads back as NULL.
    ctx.db
      .prepare(
        `INSERT INTO contest_hacks
           (contest_id, problem_id, hacker_id, target_submission_id, input_path, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'success', 100)`,
      )
      .run(contestId, ctx.p1, ctx.users.alice, submissionId, 'hacks/legacy.in');

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row).toMatchObject({ totalScore: 100, hackScore: 0 });
  });

  it('does not add hack scores to OI team rankings', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice });
    registerTeam(ctx, contestId, alpha);
    const submissionId = addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 100,
    });

    addHack(ctx, {
      contestId,
      problemId: ctx.p1,
      hackerId: ctx.users.alice,
      targetSubmissionId: submissionId,
      teamId: alpha,
      status: 'success',
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row).toMatchObject({ totalScore: 100, hackScore: 0, solved: 1 });
  });

  it('does not add hack scores to ACM team rankings', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, {
      mode: 'acm',
      startAt: 0,
      endAt: 2 * 60 * 60 * 1000,
    });
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice });
    registerTeam(ctx, contestId, alpha);
    const submissionId = addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 60_000,
    });

    addHack(ctx, {
      contestId,
      problemId: ctx.p1,
      hackerId: ctx.users.alice,
      targetSubmissionId: submissionId,
      teamId: alpha,
      status: 'success',
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row).toMatchObject({ totalScore: 1, hackScore: 0, solved: 1, penalty: 1 });
  });

  it('ignores hacked, post-freeze, non-contest and unfinished submissions', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, { freezeAt: 1000 });
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice, memberIds: [ctx.users.bob] });
    registerTeam(ctx, contestId, alpha);

    // Hacked submissions never count, even when they would be the best score.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 100,
      hackedAt: 1,
    });
    // Only finished contest submissions count.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 95,
      createdAt: 200,
      status: 'queued',
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'AC',
      score: 90,
      createdAt: 300,
      phase: 'practice',
    });
    // Freeze hides submissions after freeze_at.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 1100,
    });
    // These are the only counted submissions.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'WA',
      score: 40,
      createdAt: 500,
    });
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'WA',
      score: 70,
      createdAt: 900,
    });

    const row = getTeamRanking(ctx.db, contestId)!.rows[0]!;
    expect(row.totalScore).toBe(70);
    expect(row.solved).toBe(0);
    expect(row.cells[0]).toMatchObject({ problemId: ctx.p1, score: 70, attempts: 2 });
  });

  it('only includes teams registered for the contest', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice });
    const unregistered = makeTeam(ctx, { name: 'Gamma', ownerId: ctx.users.carol });
    registerTeam(ctx, contestId, alpha);

    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.alice,
      teamId: alpha,
      verdict: 'WA',
      score: 50,
      createdAt: 100,
    });
    // A team that is not registered for this contest must not appear.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.carol,
      teamId: unregistered,
      verdict: 'AC',
      score: 100,
      createdAt: 100,
    });
    // An individual submission (team_id NULL) must not appear either.
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.dave,
      teamId: null,
      verdict: 'AC',
      score: 100,
      createdAt: 100,
    });

    const ranking = getTeamRanking(ctx.db, contestId)!;
    expect(ranking.rows.map((row) => row.teamId)).toEqual([alpha]);
    expect(ranking.rows[0]?.totalScore).toBe(50);
  });

  it('assigns the same rank to teams with equal totals and breaks order by team id', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice });
    const beta = makeTeam(ctx, { name: 'Beta', ownerId: ctx.users.bob });
    const gamma = makeTeam(ctx, { name: 'Gamma', ownerId: ctx.users.carol });
    for (const teamId of [alpha, beta, gamma]) registerTeam(ctx, contestId, teamId);

    for (const [teamId, userId, score] of [
      [alpha, ctx.users.alice, 100],
      [beta, ctx.users.bob, 100],
      [gamma, ctx.users.carol, 40],
    ] as const) {
      addSubmission(ctx, {
        contestId,
        problemId: ctx.p1,
        userId,
        teamId,
        verdict: score === 100 ? 'AC' : 'WA',
        score,
        createdAt: 100,
      });
    }

    const rows = getTeamRanking(ctx.db, contestId)!.rows;
    expect(rows.map((row) => [row.teamName, row.rank])).toEqual([
      ['Alpha', 1],
      ['Beta', 1],
      ['Gamma', 3],
    ]);
  });

  it('returns null for an unknown contest and an empty ranking without teams', () => {
    const ctx = setup();
    expect(getTeamRanking(ctx.db, 999999)).toBeNull();

    const contestId = makeContest(ctx);
    const ranking = getTeamRanking(ctx.db, contestId)!;
    expect(ranking.rows).toEqual([]);
  });

  it('exposes the ranking over HTTP', async () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, { name: 'Alpha', ownerId: ctx.users.alice, memberIds: [ctx.users.bob] });
    registerTeam(ctx, contestId, alpha);
    addSubmission(ctx, {
      contestId,
      problemId: ctx.p1,
      userId: ctx.users.bob,
      teamId: alpha,
      verdict: 'AC',
      score: 100,
      createdAt: 100,
    });

    const app = Fastify();
    registerContestRoutes(app, { db: ctx.db });
    const response = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/team-ranking`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: boolean;
      data: Array<{
        teamName: string;
        memberCount: number;
        totalScore: number;
        solved: number;
        penalty: number;
        rank: number;
      }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([
      expect.objectContaining({
        teamName: 'Alpha',
        memberCount: 2,
        totalScore: 100,
        solved: 1,
        penalty: 0,
        rank: 1,
      }),
    ]);

    const missingApp = Fastify();
    registerContestRoutes(missingApp, { db: ctx.db });
    const missing = await missingApp.inject({
      method: 'GET',
      url: '/api/contests/999999/team-ranking',
    });
    await missingApp.close();
    expect(missing.statusCode).toBe(404);
  });
});
