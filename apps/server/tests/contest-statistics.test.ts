import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { signSession } from '../src/security/session.js';
import {
  buildContestStatistics,
  getContestStatistics,
} from '../src/services/contest-statistics.js';
import { invalidateOfficialRanking } from '../src/services/official-ranking.js';
import { openDatabase, transaction } from '../src/storage/db.js';
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
      // already closed
    }
  }
  apps.length = 0;
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
  delete process.env.OIJ_STATISTICS_CACHE_MS;
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
  const dir = mkdtempSync(join(tmpdir(), 'oij-contest-statistics-'));
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
    bob: createUser(db, {
      username: 'bob',
      passwordHash: 'x',
      realName: 'Bob',
      className: '1班',
    }),
    carol: createUser(db, {
      username: 'carol',
      passwordHash: 'x',
      realName: 'Carol',
      className: '2班',
    }),
    dave: createUser(db, {
      username: 'dave',
      passwordHash: 'x',
      realName: 'Dave',
      className: '2班',
    }),
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

function addSubmission(
  ctx: Ctx,
  contestId: number,
  problemId: number,
  userId: number,
  verdict: string | null,
  score: number,
  createdAt: number,
): number {
  const id = createSubmission(ctx.db, {
    contestId,
    problemId,
    userId,
    language: 'cpp17',
    sourcePath: 'x.cpp',
    sourceHash: 'h',
    createdAt,
  });
  ctx.db
    .prepare('UPDATE submissions SET verdict = ?, score = ?, status = ?, judged_at = ? WHERE id = ?')
    .run(verdict, score, verdict === null ? 'queued' : 'finished', verdict === null ? null : createdAt + 1, id);
  return id;
}

/** OI contest: alice 200, bob 100, carol 0, dave hidden 200. */
function seedOiContest(ctx: Ctx): number {
  const contestId = createContest(ctx.db, {
    name: 'Stats Cup',
    mode: 'oi',
    startAt: 1000,
    endAt: 2000,
    problemIds: [ctx.p1, ctx.p2],
  });
  for (const username of ['alice', 'bob', 'carol', 'dave'] as const) {
    addParticipant(ctx.db, contestId, ctx.users[username]);
  }
  updateParticipant(ctx.db, contestId, ctx.users.dave, { hidden: true });

  addSubmission(ctx, contestId, ctx.p1, ctx.users.alice, 'AC', 100, 1100);
  addSubmission(ctx, contestId, ctx.p2, ctx.users.alice, 'AC', 100, 1200);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.bob, 'AC', 100, 1300);
  addSubmission(ctx, contestId, ctx.p2, ctx.users.bob, 'WA', 0, 1400);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.carol, 'WA', 0, 1500);
  addSubmission(ctx, contestId, ctx.p2, ctx.users.carol, 'WA', 0, 1600);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.dave, 'AC', 100, 1700);
  addSubmission(ctx, contestId, ctx.p2, ctx.users.dave, 'AC', 100, 1800);
  return contestId;
}

function seedAcmContest(ctx: Ctx): number {
  const contestId = createContest(ctx.db, {
    name: 'ACM Cup',
    mode: 'acm',
    startAt: 0,
    endAt: 10_000_000,
    problemIds: [ctx.p1, ctx.p2],
  });
  for (const username of ['alice', 'bob', 'carol'] as const) {
    addParticipant(ctx.db, contestId, ctx.users[username]);
  }
  addSubmission(ctx, contestId, ctx.p2, ctx.users.bob, 'WA', 0, 60_000);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.bob, 'AC', 1, 300_000);
  addSubmission(ctx, contestId, ctx.p1, ctx.users.alice, 'AC', 1, 600_000);
  addSubmission(ctx, contestId, ctx.p2, ctx.users.alice, 'AC', 1, 1_200_000);
  return contestId;
}

async function buildTestApp(ctx: Ctx): Promise<FastifyInstance> {
  const app = await buildApp({ db: ctx.db, config: ctx.config });
  apps.push(app);
  return app;
}

function cookieFor(ctx: Ctx, userId: number): string {
  return `oij.sid=${signSession({ userId, version: 0 }, ctx.config.sessionSecret, 3600)}`;
}

describe('contest statistics service', () => {
  it('aggregates OI summary, distribution, cumulative, problems and class groups', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);

    const stats = await buildContestStatistics(ctx.db, contestId, ctx.dir);

    expect(stats).not.toBeNull();
    expect(stats!.mode).toBe('score');
    expect(stats!.contest).toMatchObject({
      id: contestId,
      title: 'Stats Cup',
      mode: 'oi',
      preset: 'oi',
      frozen: false,
    });
    expect(typeof stats!.contest.generatedAt).toBe('number');

    expect(stats!.summary).toMatchObject({
      participants: 3,
      submissions: 6,
      avgScore: 100,
      medianScore: 100,
      stddev: 81.6,
      maxScore: 200,
      minScore: 0,
      fullScoreCount: 1,
      zeroScoreCount: 1,
      avgPenalty: null,
      medianPenalty: null,
    });

    // 200 points total -> two 0-99 / 100-200 buckets.
    expect(stats!.distribution).toEqual([
      { from: 0, to: 99, count: 1 },
      { from: 100, to: 200, count: 2 },
    ]);
    const at0 = stats!.cumulative.find((point) => point.score === 0);
    expect(at0).toMatchObject({ count: 3, ratio: 1 });
    const at101 = stats!.cumulative.find((point) => point.score === 101);
    expect(at101).toMatchObject({ count: 1 });
    expect(stats!.cumulative[0]?.score).toBe(0);
    expect(stats!.cumulative.at(-1)?.score).toBe(200);

    expect(stats!.problems).toHaveLength(2);
    expect(stats!.problems[0]).toMatchObject({
      problemId: ctx.p1,
      ordinal: 1,
      title: 'P1',
      fullScore: 100,
      avgScore: 66.7,
      medianScore: 100,
      stddev: 47.1,
      acRate: 66.7,
      fullRate: 66.7,
      zeroRate: 33.3,
      difficulty: 0.6667,
      discrimination: 100,
    });
    expect(stats!.problems[0]!.distribution.reduce((sum, bin) => sum + bin.count, 0)).toBe(3);

    expect(stats!.groups).toEqual([
      { name: '1班', kind: 'class', participants: 2, avgScore: 150, fullRate: 50 },
      { name: '2班', kind: 'class', participants: 1, avgScore: 0, fullRate: 0 },
    ]);

    expect(stats!.insights.length).toBeGreaterThan(0);
    expect(stats!.insights.join('\n')).toContain('P2');
    expect(stats!.insights.join('\n')).toContain('1班');
    expect(stats!.insights).toContain('各题区分度均为 100 分。');
    expect(JSON.stringify(stats)).not.toContain('dave');
  });

  it('excludes hidden participants publicly and includes them for managers', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);

    const publicStats = await buildContestStatistics(ctx.db, contestId, ctx.dir);
    expect(publicStats!.summary.participants).toBe(3);
    expect(publicStats!.summary.fullScoreCount).toBe(1);
    expect(publicStats!.groups).toHaveLength(2);

    const adminStats = await buildContestStatistics(ctx.db, contestId, ctx.dir, {
      includeHidden: true,
    });
    expect(adminStats!.summary.participants).toBe(4);
    expect(adminStats!.summary.avgScore).toBe(125);
    expect(adminStats!.summary.medianScore).toBe(150);
    expect(adminStats!.summary.fullScoreCount).toBe(2);
    expect(adminStats!.groups).toHaveLength(2);
    expect(adminStats!.groups.find((group) => group.name === '2班')).toMatchObject({
      participants: 2,
      avgScore: 100,
    });
  });

  it('uses solved counts and penalty for ACM contests without a score histogram', async () => {
    const ctx = setup();
    const contestId = seedAcmContest(ctx);

    const stats = await buildContestStatistics(ctx.db, contestId, ctx.dir);

    expect(stats!.mode).toBe('solved');
    expect(stats!.contest.preset).toBe('acm');
    expect(stats!.summary).toMatchObject({
      participants: 3,
      avgScore: 1,
      medianScore: 1,
      maxScore: 2,
      minScore: 0,
      fullScoreCount: 1,
      zeroScoreCount: 1,
      avgPenalty: 11.7,
      medianPenalty: 5,
    });
    expect(stats!.distribution).toEqual([
      { from: 0, to: 0, count: 1 },
      { from: 1, to: 1, count: 1 },
      { from: 2, to: 2, count: 1 },
    ]);
    expect(stats!.problems[0]).toMatchObject({
      problemId: ctx.p1,
      avgScore: 66.7,
      acRate: 66.7,
      difficulty: 0.3333,
      discrimination: 100,
    });
    expect(stats!.problems[0]!.distribution).toEqual([
      { from: 0, to: 0, count: 1 },
      { from: 1, to: 1, count: 2 },
    ]);
    expect(stats!.problems[1]!.distribution).toEqual([
      { from: 0, to: 0, count: 2 },
      { from: 1, to: 1, count: 1 },
    ]);
  });

  it('honours the frozen board snapshot', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Frozen Cup',
      mode: 'acm',
      startAt: 1000,
      endAt: 10_000,
      freezeAt: 1500,
      problemIds: [ctx.p1],
    });
    for (const username of ['alice', 'bob', 'carol'] as const) {
      addParticipant(ctx.db, contestId, ctx.users[username]);
    }
    ctx.db.prepare("UPDATE contests SET status = 'frozen' WHERE id = ?").run(contestId);
    addSubmission(ctx, contestId, ctx.p1, ctx.users.alice, 'AC', 1, 1100);
    addSubmission(ctx, contestId, ctx.p1, ctx.users.bob, 'AC', 1, 1600);
    addSubmission(ctx, contestId, ctx.p1, ctx.users.carol, 'AC', 1, 1200);

    const stats = await buildContestStatistics(ctx.db, contestId, ctx.dir);

    expect(stats!.contest.frozen).toBe(true);
    expect(stats!.mode).toBe('solved');
    expect(stats!.summary.avgScore).toBe(0.7);
    expect(stats!.summary.fullScoreCount).toBe(2);
    expect(stats!.problems[0]!.acRate).toBe(66.7);
    expect(stats!.distribution).toEqual([
      { from: 0, to: 0, count: 1 },
      { from: 1, to: 1, count: 2 },
    ]);
  });

  it('returns null for a missing contest and empty stats for no participants', async () => {
    const ctx = setup();
    expect(await buildContestStatistics(ctx.db, 9999, ctx.dir)).toBeNull();

    const contestId = createContest(ctx.db, {
      name: 'Empty Cup',
      mode: 'oi',
      problemIds: [ctx.p1],
    });
    const stats = await buildContestStatistics(ctx.db, contestId, ctx.dir);
    expect(stats!.summary).toMatchObject({
      participants: 0,
      submissions: 0,
      avgScore: null,
      medianScore: null,
      stddev: null,
      maxScore: null,
      minScore: null,
      fullScoreCount: 0,
      zeroScoreCount: 0,
    });
    expect(stats!.distribution).toEqual([]);
    expect(stats!.cumulative).toEqual([]);
    expect(stats!.problems[0]).toMatchObject({
      avgScore: null,
      medianScore: null,
      stddev: null,
      acRate: null,
      fullRate: null,
      zeroRate: null,
      difficulty: null,
      discrimination: null,
      distribution: [],
    });
    expect(stats!.groups).toEqual([]);
    expect(stats!.insights).toEqual([]);
  });

  it('caches results and invalidates them with the ranking version', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    process.env.OIJ_STATISTICS_CACHE_MS = '10000';

    const first = await getContestStatistics(ctx.db, contestId, ctx.dir);
    const second = await getContestStatistics(ctx.db, contestId, ctx.dir);
    expect(second).toBe(first);

    updateParticipant(ctx.db, contestId, ctx.users.carol, { hidden: true });
    invalidateOfficialRanking(ctx.db, contestId);
    const third = await getContestStatistics(ctx.db, contestId, ctx.dir);
    expect(third).not.toBe(first);
    expect(third!.summary.participants).toBe(2);
  });
});

describe('GET /api/contests/:id/statistics', () => {
  it('serves public stats to anonymous callers and contestants', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    const url = `/api/contests/${contestId}/statistics`;

    const anonymous = await app.inject({ method: 'GET', url });
    expect(anonymous.statusCode).toBe(200);
    const body = anonymous.json() as {
      data: { contest: { id: number }; mode: string; summary: { participants: number } };
    };
    expect(body.data.contest.id).toBe(contestId);
    expect(body.data.mode).toBe('score');
    expect(body.data.summary.participants).toBe(3);

    const contestant = await app.inject({
      method: 'GET',
      url,
      headers: { cookie: cookieFor(ctx, ctx.users.contestant) },
    });
    expect(contestant.statusCode).toBe(200);
  });

  it('allows includeHidden only for admins and contest managers', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    const url = `/api/contests/${contestId}/statistics?includeHidden=1`;

    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(403);
    expect(
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { cookie: cookieFor(ctx, ctx.users.contestant) },
        })
      ).statusCode,
    ).toBe(403);

    for (const username of ['admin', 'manager'] as const) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: cookieFor(ctx, ctx.users[username]) },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { summary: { participants: number } } };
      expect(body.data.summary.participants).toBe(4);
    }
  });

  it('rejects invalid includeHidden values, unknown contests and bad ids', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    const cookie = cookieFor(ctx, ctx.users.admin);

    const invalid = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/statistics?includeHidden=yes`,
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_INCLUDE_HIDDEN',
    );

    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/contests/9999/statistics',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/contests/not-a-number/statistics',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('exposes hidden rows on official-ranking only with includeHidden for managers', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    const base = `/api/contests/${contestId}/official-ranking`;
    const adminCookie = cookieFor(ctx, ctx.users.admin);

    const publicResponse = await app.inject({ method: 'GET', url: base });
    expect(publicResponse.statusCode).toBe(200);
    expect((publicResponse.json() as { data: { rows: unknown[] } }).data.rows).toHaveLength(3);

    const adminResponse = await app.inject({
      method: 'GET',
      url: `${base}?includeHidden=1`,
      headers: { cookie: adminCookie },
    });
    expect(adminResponse.statusCode).toBe(200);
    expect((adminResponse.json() as { data: { rows: unknown[] } }).data.rows).toHaveLength(4);

    const contestantResponse = await app.inject({
      method: 'GET',
      url: `${base}?includeHidden=1`,
      headers: { cookie: cookieFor(ctx, ctx.users.contestant) },
    });
    expect(contestantResponse.statusCode).toBe(403);
  });
});

interface PagedRankingData {
  items: Array<{
    userId: number;
    username: string;
    realName: string | null;
    className: string | null;
    totalScore: number;
  }>;
  total: number;
  allTotal: number;
  offset: number;
  limit: number;
  query: string;
  rows?: unknown;
}

async function getRankingPage(
  app: FastifyInstance,
  contestId: number,
  query: string,
  cookie?: string,
) {
  return app.inject({
    method: 'GET',
    url: `/api/contests/${contestId}/official-ranking/page${query ? `?${query}` : ''}`,
    ...(cookie ? { headers: { cookie } } : {}),
  });
}

function pagedBody(response: {
  statusCode: number;
  body: string;
  json: () => unknown;
}): PagedRankingData {
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { data: PagedRankingData }).data;
}

describe('official ranking server paging', () => {
  it('pages in rank order and keeps the complete endpoint compatible', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    const complete = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking`,
    });
    const all = (complete.json() as { data: { rows: Array<{ userId: number }> } }).data.rows;
    expect(all).toHaveLength(3);

    const first = pagedBody(await getRankingPage(app, contestId, 'offset=0&limit=2'));
    expect(first).toMatchObject({ total: 3, allTotal: 3, offset: 0, limit: 2 });
    expect(first.items.map((item) => item.userId)).toEqual(
      all.slice(0, 2).map((row) => row.userId),
    );
    expect(first.rows).toBeUndefined();

    const second = pagedBody(await getRankingPage(app, contestId, 'offset=2&limit=2'));
    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.userId).toBe(all[2]!.userId);

    const beyond = pagedBody(await getRankingPage(app, contestId, 'offset=99&limit=2'));
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(3);

    const defaults = pagedBody(await getRankingPage(app, contestId, ''));
    expect(defaults.limit).toBe(100);
    expect(defaults.items).toHaveLength(3);

    // The original endpoint switches to the paged envelope when paging params
    // are present, and `complete=1` still returns the full ranking.
    const extended = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking?offset=0&limit=1`,
    });
    const extendedBody = pagedBody(extended);
    expect(extendedBody.items).toHaveLength(1);
    expect(extendedBody.total).toBe(3);
    const completeOverride = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking?complete=1&offset=0&limit=1`,
    });
    expect(
      (completeOverride.json() as { data: { rows: unknown[] } }).data.rows,
    ).toHaveLength(3);
  });

  it('normalizes offset/limit boundaries and caps the page size', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    const capped = pagedBody(await getRankingPage(app, contestId, 'limit=1000'));
    expect(capped.limit).toBe(500);
    const badLimit = pagedBody(await getRankingPage(app, contestId, 'limit=0'));
    expect(badLimit.limit).toBe(100);
    const badOffset = pagedBody(await getRankingPage(app, contestId, 'offset=-5'));
    expect(badOffset.offset).toBe(0);
    const fractional = pagedBody(
      await getRankingPage(app, contestId, 'offset=1.9&limit=1.9'),
    );
    expect(fractional.offset).toBe(1);
    expect(fractional.limit).toBe(1);
    expect(fractional.items).toHaveLength(1);
  });

  it('searches username, real name and class within the visible ranking', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    expect(
      pagedBody(await getRankingPage(app, contestId, 'query=ali')).items.map(
        (item) => item.username,
      ),
    ).toEqual(['alice']);
    expect(
      pagedBody(await getRankingPage(app, contestId, 'query=ALICE')).items.map(
        (item) => item.username,
      ),
    ).toEqual(['alice']);
    expect(
      pagedBody(await getRankingPage(app, contestId, 'query=carol')).items.map(
        (item) => item.username,
      ),
    ).toEqual(['carol']);
    const class1 = pagedBody(await getRankingPage(app, contestId, 'query=1班'));
    expect(class1.items.map((item) => item.username).sort()).toEqual(['alice', 'bob']);
    const hidden = pagedBody(await getRankingPage(app, contestId, 'query=dave'));
    expect(hidden.total).toBe(0);
    expect(hidden.items).toEqual([]);
    const missing = pagedBody(await getRankingPage(app, contestId, 'query=zzz'));
    expect(missing.total).toBe(0);
    const searchedPage = pagedBody(
      await getRankingPage(app, contestId, 'query=1班&offset=1&limit=1'),
    );
    expect(searchedPage.total).toBe(2);
    expect(searchedPage.items).toHaveLength(1);
  });

  it('keeps includeHidden permissions on the paged endpoint', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    const app = await buildTestApp(ctx);
    expect(pagedBody(await getRankingPage(app, contestId, '')).total).toBe(3);
    expect(
      pagedBody(
        await getRankingPage(
          app,
          contestId,
          'includeHidden=1',
          cookieFor(ctx, ctx.users.admin),
        ),
      ).total,
    ).toBe(4);
    const forbidden = await getRankingPage(
      app,
      contestId,
      'includeHidden=1',
      cookieFor(ctx, ctx.users.contestant),
    );
    expect(forbidden.statusCode).toBe(403);
    const invalid = await getRankingPage(app, contestId, 'includeHidden=yes');
    expect(invalid.statusCode).toBe(400);
  });

  it('uses the same frozen-board semantics as the complete endpoint', async () => {
    const ctx = setup();
    const contestId = seedOiContest(ctx);
    ctx.db
      .prepare("UPDATE contests SET status = 'frozen', freeze_at = ? WHERE id = ?")
      .run(1250, contestId);
    const app = await buildTestApp(ctx);
    const complete = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking`,
    });
    const all = (
      complete.json() as { data: { rows: Array<{ userId: number; totalScore: number }> } }
    ).data.rows;
    const page = pagedBody(await getRankingPage(app, contestId, 'offset=0&limit=100'));
    expect(page.total).toBe(all.length);
    expect(page.items.map((item) => item.userId)).toEqual(all.map((row) => row.userId));
    expect(page.items.map((item) => item.totalScore)).toEqual(
      all.map((row) => row.totalScore),
    );
  });

  it('returns an empty page for a contest without participants', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Empty',
      mode: 'oi',
      startAt: 0,
      endAt: 1000,
      problemIds: [ctx.p1],
    });
    const app = await buildTestApp(ctx);
    const page = pagedBody(await getRankingPage(app, contestId, ''));
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.allTotal).toBe(0);
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(100);
  });

  it('pages and searches a 5000-participant board without returning every row', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Big',
      mode: 'oi',
      startAt: 0,
      endAt: 10_000_000,
      problemIds: [ctx.p1],
    });
    transaction(ctx.db, () => {
      const insertUser = ctx.db.prepare(
        `INSERT INTO users(username, password_hash, real_name, class_name, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertParticipant = ctx.db.prepare(
        "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
      );
      for (let index = 0; index < 5000; index += 1) {
        const result = insertUser.run(
          `bulk${index}`,
          'x',
          `Bulk ${index}`,
          `${index % 20}班`,
          'contestant',
          0,
        );
        insertParticipant.run(contestId, Number(result.lastInsertRowid));
      }
    });
    const app = await buildTestApp(ctx);
    const page = pagedBody(
      await getRankingPage(app, contestId, 'offset=4900&limit=100'),
    );
    expect(page.total).toBe(5000);
    expect(page.allTotal).toBe(5000);
    expect(page.items).toHaveLength(100);
    expect((page as { rows?: unknown }).rows).toBeUndefined();

    const searched = pagedBody(await getRankingPage(app, contestId, 'query=bulk4999'));
    expect(searched.total).toBe(1);
    expect(searched.items[0]!.username).toBe('bulk4999');

    const complete = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking`,
    });
    expect((complete.json() as { data: { rows: unknown[] } }).data.rows).toHaveLength(5000);
  }, 30_000);
});
