import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { buildContestReport, contestReportToCsv } from '../src/services/contest-report.js';
import { registerTeamForContest } from '../src/services/contest-teams.js';
import { addTeamMember, createTeam } from '../src/services/teams.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import {
  addParticipant,
  createContest,
  updateParticipant,
} from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];
const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps) {
    try {
      await app.close();
    } catch {
      // already closed by the test
    }
  }
  apps.length = 0;
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

type Username = 'admin' | 'manager' | 'contestant' | 'alice' | 'bob' | 'carol' | 'dave';

interface Ctx {
  dir: string;
  db: DatabaseSync;
  config: Config;
  users: Record<Username, number>;
  p1: number;
  p2: number;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'oij-contest-report-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  ensureDataDirs(dir);
  const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const users: Record<Username, number> = {
    admin: createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' }),
    manager: createUser(db, {
      username: 'manager',
      passwordHash: 'x',
      role: 'contestmanager',
    }),
    contestant: createUser(db, { username: 'contestant', passwordHash: 'x' }),
    alice: createUser(db, {
      username: 'alice',
      passwordHash: 'x',
      realName: 'Alice',
      className: '1班',
    }),
    bob: createUser(db, { username: 'bob', passwordHash: 'x', realName: 'Bob' }),
    carol: createUser(db, { username: 'carol', passwordHash: 'x' }),
    dave: createUser(db, { username: 'dave', passwordHash: 'x', realName: 'Dave' }),
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
  return { dir, db, config, users, p1, p2 };
}

async function buildTestApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = await buildApp({ db: ctx.db, config: ctx.config });
  apps.push(app);
  return app;
}

function cookieFor(ctx: Ctx, userId: number): string {
  return `oij.sid=${signSession({ userId, version: 0 }, ctx.config.sessionSecret, 3600)}`;
}

function addSubmission(
  ctx: Ctx,
  contestId: number,
  problemId: number,
  userId: number,
  verdict: string | null,
  score: number,
  createdAt: number,
  options: { teamId?: number | null; status?: string } = {},
): number {
  const id = createSubmission(ctx.db, {
    contestId,
    problemId,
    userId,
    teamId: options.teamId ?? null,
    language: 'cpp17',
    sourcePath: 'x.cpp',
    sourceHash: 'h',
    createdAt,
  });
  const status = options.status ?? (verdict === null ? 'queued' : 'finished');
  ctx.db
    .prepare('UPDATE submissions SET verdict = ?, score = ?, status = ?, judged_at = ? WHERE id = ?')
    .run(verdict, score, status, verdict === null ? null : createdAt + 1, id);
  return id;
}

/**
 * Seeds one contest with every participant state and a hidden participant:
 * alice accepted + checked in, bob pending, carol rejected, dave accepted+hidden.
 */
function seedReportContest(ctx: Ctx): number {
  const contestId = createContest(ctx.db, {
    name: 'Report Cup',
    mode: 'oi',
    problemIds: [ctx.p1, ctx.p2],
    startAt: 1000,
    endAt: 2000,
  });
  addParticipant(ctx.db, contestId, ctx.users.alice);
  addParticipant(ctx.db, contestId, ctx.users.bob);
  addParticipant(ctx.db, contestId, ctx.users.carol);
  addParticipant(ctx.db, contestId, ctx.users.dave);
  ctx.db
    .prepare(
      "UPDATE contest_participants SET status = 'pending' WHERE contest_id = ? AND user_id = ?",
    )
    .run(contestId, ctx.users.bob);
  ctx.db
    .prepare(
      "UPDATE contest_participants SET status = 'rejected' WHERE contest_id = ? AND user_id = ?",
    )
    .run(contestId, ctx.users.carol);
  ctx.db
    .prepare('UPDATE contest_participants SET checked_in_at = ? WHERE contest_id = ? AND user_id = ?')
    .run(1500, contestId, ctx.users.alice);
  updateParticipant(ctx.db, contestId, ctx.users.dave, { hidden: true });

  addSubmission(ctx, contestId, ctx.p1, ctx.users.alice, 'AC', 100, 1100);
  addSubmission(ctx, contestId, ctx.p2, ctx.users.alice, 'AC', 100, 1200);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.bob, 'WA', 0, 1100);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.bob, 'AC', 100, 1300);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.dave, 'AC', 100, 1400);
  addSubmission(ctx, contestId, ctx.p2, ctx.users.carol, null, 0, 1500);
  return contestId;
}

describe('contest report service', () => {
  it('aggregates participants, submissions, problems and the visible ranking', async () => {
    const ctx = setup();
    const contestId = seedReportContest(ctx);

    const report = await buildContestReport(ctx.db, contestId, ctx.dir);

    expect(report).not.toBeNull();
    expect(report!.contest.id).toBe(contestId);
    expect(report!.contest.name).toBe('Report Cup');
    expect(report!.participants).toEqual({
      total: 4,
      accepted: 2,
      pending: 1,
      rejected: 1,
      checkedIn: 1,
    });
    expect(report!.submissions.total).toBe(6);
    expect(report!.submissions.byVerdict).toEqual({ AC: 4, WA: 1, none: 1 });
    expect(report!.submissions.byStatus).toEqual({ finished: 5, queued: 1 });

    expect(report!.problems).toHaveLength(2);
    expect(report!.problems[0]).toMatchObject({
      problemId: ctx.p1,
      ordinal: 1,
      title: 'P1',
      points: 100,
      submissions: 4,
      acSubmissions: 3,
      acUsers: 3,
      acRate: 75,
      averageScore: 100,
      maxScore: 100,
    });
    expect(report!.problems[1]).toMatchObject({
      problemId: ctx.p2,
      submissions: 2,
      acSubmissions: 1,
      acUsers: 1,
      acRate: 50,
      averageScore: 50,
      maxScore: 100,
    });

    // dave is hidden, so only alice is on the visible individual ranking.
    expect(report!.ranking).toHaveLength(1);
    expect(report!.ranking[0]).toMatchObject({
      rank: 1,
      userId: ctx.users.alice,
      username: 'alice',
      totalScore: 200,
    });
    expect(report!.rankingTotal).toBe(1);
    expect(JSON.stringify(report)).not.toContain('dave');
    expect(report!.teamStats).toBeNull();
    expect(typeof report!.generatedAt).toBe('number');
  });

  it('limits the individual ranking with top without changing the total', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Top Cup',
      mode: 'oi',
      problemIds: [ctx.p1],
      startAt: 1000,
      endAt: 2000,
    });
    addParticipant(ctx.db, contestId, ctx.users.alice);
    addParticipant(ctx.db, contestId, ctx.users.bob);
    addSubmission(ctx, contestId, ctx.p1, ctx.users.alice, 'AC', 100, 1100);
    addSubmission(ctx, contestId, ctx.p1, ctx.users.bob, 'WA', 0, 1100);

    const full = await buildContestReport(ctx.db, contestId, ctx.dir);
    expect(full!.ranking).toHaveLength(2);

    const top = await buildContestReport(ctx.db, contestId, ctx.dir, { top: 1 });
    expect(top!.ranking).toHaveLength(1);
    expect(top!.rankingTotal).toBe(2);
    expect(top!.ranking[0]?.userId).toBe(ctx.users.alice);
  });

  it('reports an empty contest with zeroed stats', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Empty Cup',
      mode: 'oi',
      problemIds: [ctx.p1],
    });

    const report = await buildContestReport(ctx.db, contestId, ctx.dir);

    expect(report).not.toBeNull();
    expect(report!.participants).toEqual({
      total: 0,
      accepted: 0,
      pending: 0,
      rejected: 0,
      checkedIn: 0,
    });
    expect(report!.submissions).toEqual({ total: 0, byVerdict: {}, byStatus: {} });
    expect(report!.problems).toEqual([
      {
        problemId: ctx.p1,
        ordinal: 1,
        title: 'P1',
        points: 100,
        submissions: 0,
        acSubmissions: 0,
        acUsers: 0,
        acRate: 0,
        averageScore: 0,
        maxScore: 0,
      },
    ]);
    expect(report!.ranking).toEqual([]);
    expect(report!.rankingTotal).toBe(0);
    expect(report!.teamStats).toBeNull();
  });

  it('includes team statistics for a team contest', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Team Cup',
      mode: 'oi',
      teamMode: 'team',
      problemIds: [ctx.p1],
      startAt: 1000,
      endAt: 2000,
    });
    const teamId = createTeam(ctx.db, { name: 'Alpha', ownerId: ctx.users.alice });
    addTeamMember(ctx.db, {
      teamId,
      actorId: ctx.users.alice,
      username: 'bob',
    });
    registerTeamForContest(ctx.db, {
      contestId,
      teamId,
      actorId: ctx.users.alice,
      isAdmin: true,
      now: 1100,
    });
    addSubmission(ctx, contestId, ctx.p1, ctx.users.alice, 'AC', 100, 1200, { teamId });

    const report = await buildContestReport(ctx.db, contestId, ctx.dir);

    expect(report!.teamStats).not.toBeNull();
    expect(report!.teamStats!.teamCount).toBe(1);
    expect(report!.teamStats!.rows[0]).toMatchObject({
      rank: 1,
      teamId,
      teamName: 'Alpha',
      memberCount: 2,
      totalScore: 100,
    });
    const csv = contestReportToCsv(report!);
    expect(csv).toContain('团队成绩');
    expect(csv).toContain('名次,团队ID,团队名称,成员数,总分,通过数,罚时,最后AC,第1题 P1');
    expect(csv).toContain('1,1,Alpha,2,100,1,0,,100');
  });

  it('returns null for a missing contest', async () => {
    const ctx = setup();
    expect(await buildContestReport(ctx.db, 9999, ctx.dir)).toBeNull();
  });

  it('serializes a UTF-8 BOM CSV with stable problem and ranking columns', async () => {
    const ctx = setup();
    const contestId = seedReportContest(ctx);
    const report = await buildContestReport(ctx.db, contestId, ctx.dir);
    const csv = contestReportToCsv(report!);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('题号,题目ID,题目,分值,提交数,AC人数,AC率,平均分,最高分');
    expect(csv).toContain('1,1,P1,100,4,3,75.0%,100.0,100');
    expect(csv).toContain('名次,用户ID,用户名,姓名,班级,总分,通过数,罚时,最后AC,第1题 P1,第2题 P2');
    expect(csv).toContain(
      `1,${ctx.users.alice},alice,Alice,1班,200,2,0,,100,100`,
    );
    expect(csv).not.toContain('dave');
  });
});

describe('GET /api/admin/contests/:id/report', () => {
  it('requires an admin or contest manager', async () => {
    const ctx = setup();
    const contestId = seedReportContest(ctx);
    const app = await buildTestApp(ctx);
    const url = `/api/admin/contests/${contestId}/report`;

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { cookie: cookieFor(ctx, ctx.users.contestant) },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { cookie: cookieFor(ctx, ctx.users.manager) },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { cookie: cookieFor(ctx, ctx.users.admin) },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('returns JSON by default, CSV on request and 404 for a missing contest', async () => {
    const ctx = setup();
    const contestId = seedReportContest(ctx);
    const app = await buildTestApp(ctx);
    const cookie = cookieFor(ctx, ctx.users.admin);
    const url = `/api/admin/contests/${contestId}/report`;

    const json = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(json.statusCode).toBe(200);
    const body = json.json() as {
      data: { contest: { id: number }; submissions: { total: number }; rankingTotal: number };
    };
    expect(body.data.contest.id).toBe(contestId);
    expect(body.data.submissions.total).toBe(6);
    expect(body.data.rankingTotal).toBe(1);

    const csv = await app.inject({
      method: 'GET',
      url: `${url}?format=csv`,
      headers: { cookie },
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain('attachment');
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    expect(csv.body).toContain('题号,题目ID,题目,分值,提交数,AC人数,AC率,平均分,最高分');
    expect(csv.body).toContain(
      `1,${ctx.users.alice},alice,Alice,1班,200,2,0,,100,100`,
    );
    expect(csv.body).not.toContain('dave');

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/admin/contests/9999/report`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects unknown formats and invalid top values', async () => {
    const ctx = setup();
    const contestId = seedReportContest(ctx);
    const app = await buildTestApp(ctx);
    const cookie = cookieFor(ctx, ctx.users.admin);
    const url = `/api/admin/contests/${contestId}/report`;

    const badFormat = await app.inject({
      method: 'GET',
      url: `${url}?format=xml`,
      headers: { cookie },
    });
    expect(badFormat.statusCode).toBe(400);
    expect((badFormat.json() as { error: { code: string } }).error.code).toBe('INVALID_FORMAT');

    const badTop = await app.inject({
      method: 'GET',
      url: `${url}?top=0`,
      headers: { cookie },
    });
    expect(badTop.statusCode).toBe(400);
    expect((badTop.json() as { error: { code: string } }).error.code).toBe('INVALID_TOP');
  });
});
