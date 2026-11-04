import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { signSession } from '../src/security/session.js';
import {
  DEFAULT_AWARD_CONFIG,
  certificateNo,
  computeAwardCounts,
  getAwardConfig,
  getContestAwards,
  normalizeAwardConfig,
  setAwardConfig,
} from '../src/services/awards.js';
import {
  addParticipant,
  createContest,
  getContest,
  updateParticipant,
} from '../src/storage/repos/contests.js';
import { upsertOfficialScore } from '../src/storage/repos/official-scores.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { invalidateOfficialRanking } from '../src/services/official-ranking.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'awards-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let problemId = 0;
let adminId = 0;
let managerId = 0;
let contestantId = 0;
const users: number[] = [];

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  adminId = createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' });
  managerId = createUser(db, {
    username: 'manager',
    passwordHash: 'x',
    role: 'contestmanager',
  });
  contestantId = createUser(db, { username: 'viewer', passwordHash: 'x' });
  for (let index = 0; index < 12; index += 1) {
    users.push(
      createUser(db, {
        username: `award-user-${index}`,
        passwordHash: 'x',
        realName: `User ${index}`,
        className: '1班',
      }),
    );
  }
  problemId = createProblem(db, {
    title: 'Awards Problem',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [],
  });
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function cookieFor(userId: number): string {
  return `oij.sid=${signSession({ userId, version: 0 }, config.sessionSecret, 3600)}`;
}

function makeScoredContest(
  name: string,
  scores: number[],
  options: { hidden?: number[]; ended?: boolean } = {},
): number {
  const contestId = createContest(db, {
    name,
    mode: 'oi',
    problemIds: [problemId],
    startAt: 1000,
    endAt: 2000,
  });
  scores.forEach((score, index) => {
    const userId = users[index];
    addParticipant(db, contestId, userId);
    if (options.hidden?.includes(index)) {
      updateParticipant(db, contestId, userId, { hidden: true });
    }
    upsertOfficialScore(db, {
      contestId,
      userId,
      problemId,
      score,
      verdict: score >= 100 ? 'AC' : 'WA',
      source: 'batch',
      batchId: 1,
    });
  });
  if (options.ended !== false) {
    db.prepare("UPDATE contests SET status = 'ended' WHERE id = ?").run(contestId);
  }
  return contestId;
}

describe('award config', () => {
  it('defaults to 10/20/30 and stores {} for new contests', async () => {
    const contestId = makeScoredContest('Awards defaults', [100, 80]);
    const contest = getContest(db, contestId)!;
    expect(contest.award_config_json).toBe('{}');
    expect(getAwardConfig(contest)).toEqual(DEFAULT_AWARD_CONFIG);
    const awards = await getContestAwards(db, contestId, root);
    expect(awards?.config).toEqual(DEFAULT_AWARD_CONFIG);
  });

  it('falls back to defaults for malformed or out-of-range stored config', () => {
    const contestId = makeScoredContest('Awards bad stored', [100]);
    db.prepare('UPDATE contests SET award_config_json = ? WHERE id = ?').run(
      '{"goldPercent":120}',
      contestId,
    );
    expect(getAwardConfig(getContest(db, contestId)!)).toEqual(DEFAULT_AWARD_CONFIG);
    db.prepare('UPDATE contests SET award_config_json = ? WHERE id = ?').run(
      'not-json',
      contestId,
    );
    expect(getAwardConfig(getContest(db, contestId)!)).toEqual(DEFAULT_AWARD_CONFIG);
  });

  it('validates percentages between 0 and 100 with a sum of at most 100', () => {
    expect(
      normalizeAwardConfig({ goldPercent: 0, silverPercent: 20, bronzePercent: 30 }),
    ).toEqual({ goldPercent: 0, silverPercent: 20, bronzePercent: 30 });
    expect(
      normalizeAwardConfig({ goldPercent: 10.5, silverPercent: 20.25, bronzePercent: 30 }),
    ).toEqual({ goldPercent: 10.5, silverPercent: 20.25, bronzePercent: 30 });
    expect(
      normalizeAwardConfig({ goldPercent: -1, silverPercent: 20, bronzePercent: 30 }),
    ).toBeNull();
    expect(
      normalizeAwardConfig({ goldPercent: 101, silverPercent: 20, bronzePercent: 30 }),
    ).toBeNull();
    expect(
      normalizeAwardConfig({ goldPercent: 50, silverPercent: 30, bronzePercent: 30 }),
    ).toBeNull();
    expect(
      normalizeAwardConfig({ goldPercent: '10', silverPercent: 20, bronzePercent: 30 }),
    ).toBeNull();
    expect(normalizeAwardConfig({ goldPercent: 10 })).toBeNull();
    expect(normalizeAwardConfig(null)).toBeNull();
  });

  it('computes rounded counts with a minimum of one and caps at the field size', () => {
    expect(computeAwardCounts(10, DEFAULT_AWARD_CONFIG)).toEqual({
      gold: 1,
      silver: 2,
      bronze: 3,
      total: 6,
    });
    expect(computeAwardCounts(3, DEFAULT_AWARD_CONFIG)).toEqual({
      gold: 1,
      silver: 1,
      bronze: 1,
      total: 3,
    });
    expect(
      computeAwardCounts(2, { goldPercent: 100, silverPercent: 0, bronzePercent: 0 }),
    ).toEqual({ gold: 2, silver: 0, bronze: 0, total: 2 });
    expect(computeAwardCounts(0, DEFAULT_AWARD_CONFIG)).toEqual({
      gold: 0,
      silver: 0,
      bronze: 0,
      total: 0,
    });
    expect(
      computeAwardCounts(4, { goldPercent: 0, silverPercent: 20, bronzePercent: 30 }),
    ).toEqual({ gold: 0, silver: 1, bronze: 1, total: 2 });
  });
});

describe('contest awards service', () => {
  it('awards the default bands by cumulative rank and includes certificate data', async () => {
    const contestId = makeScoredContest('Default bands', [100, 90, 80, 70, 60, 50, 40, 30, 20, 10]);
    const awards = (await getContestAwards(db, contestId, root))!;
    expect(awards.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(awards.rows.map((row) => row.award)).toEqual([
      'gold',
      'silver',
      'silver',
      'bronze',
      'bronze',
      'bronze',
      null,
      null,
      null,
      null,
    ]);
    expect(awards.counts).toEqual({ gold: 1, silver: 2, bronze: 3, total: 6 });
    expect(awards.rows[0]).toMatchObject({
      userId: users[0],
      username: 'award-user-0',
      realName: 'User 0',
      className: '1班',
      totalScore: 100,
      solved: 1,
    });
    expect(awards.rows[0].certificateNo).toBe(certificateNo(contestId, users[0]));
    expect(awards.rows[0].certificateNo).toBe(`C${contestId}-${users[0]}`);
  });

  it('applies a custom config and records an audit entry', async () => {
    const contestId = makeScoredContest('Custom bands', [100, 90, 80, 70]);
    const saved = setAwardConfig(
      db,
      contestId,
      { goldPercent: 50, silverPercent: 30, bronzePercent: 20 },
      { actorId: adminId },
    );
    expect(saved).toEqual({ goldPercent: 50, silverPercent: 30, bronzePercent: 20 });
    const awards = (await getContestAwards(db, contestId, root))!;
    expect(awards.rows.map((row) => row.award)).toEqual([
      'gold',
      'gold',
      'silver',
      'bronze',
    ]);
    expect(awards.counts).toEqual({ gold: 2, silver: 1, bronze: 1, total: 4 });
    const audit = db
      .prepare(
        "SELECT target_type, target_id, actor_id, detail_json FROM audit_logs WHERE action = 'contest.awards.config.update' AND target_id = ? ORDER BY id DESC",
      )
      .get(String(contestId)) as
      | { target_type: string; target_id: string; actor_id: number; detail_json: string }
      | undefined;
    expect(audit).toMatchObject({ target_type: 'contest', actor_id: adminId });
    expect((JSON.parse(audit!.detail_json) as { config: unknown }).config).toEqual(saved);
  });

  it('keeps the same award for tied ranks', async () => {
    const contestId = makeScoredContest('Ties', [100, 90, 90, 80, 70]);
    const awards = (await getContestAwards(db, contestId, root))!;
    expect(awards.rows.map((row) => row.rank)).toEqual([1, 2, 2, 4, 5]);
    expect(awards.rows.map((row) => row.award)).toEqual([
      'gold',
      'silver',
      'silver',
      'bronze',
      null,
    ]);
    expect(awards.counts).toEqual({ gold: 1, silver: 2, bronze: 1, total: 4 });
  });

  it('excludes hidden participants from the awards table', async () => {
    const contestId = makeScoredContest('Hidden', [100, 90, 80], { hidden: [0] });
    const awards = (await getContestAwards(db, contestId, root))!;
    expect(awards.rows.map((row) => row.userId)).toEqual([users[1], users[2]]);
    expect(awards.rows.some((row) => row.userId === users[0])).toBe(false);
    expect(awards.rows.map((row) => row.rank)).toEqual([1, 2]);
    expect(awards.rows.map((row) => row.award)).toEqual(['gold', 'silver']);
    expect(awards.counts).toEqual({ gold: 1, silver: 1, bronze: 0, total: 2 });
  });

  it('supports zero percentages', async () => {
    const contestId = makeScoredContest('Zero bands', [100, 90, 80, 70, 60]);
    db.prepare('UPDATE contests SET award_config_json = ? WHERE id = ?').run(
      JSON.stringify({ goldPercent: 0, silverPercent: 20, bronzePercent: 0 }),
      contestId,
    );
    const awards = (await getContestAwards(db, contestId, root))!;
    expect(awards.rows.map((row) => row.award)).toEqual([
      'silver',
      null,
      null,
      null,
      null,
    ]);
    expect(awards.counts).toEqual({ gold: 0, silver: 1, bronze: 0, total: 1 });
  });

  it('keeps certificate numbers stable when ranks change', async () => {
    const contestId = makeScoredContest('Stable certificates', [100, 90, 80, 70]);
    const before = (await getContestAwards(db, contestId, root))!;
    const certificates = new Map(
      before.rows.map((row) => [row.userId, row.certificateNo] as const),
    );
    upsertOfficialScore(db, {
      contestId,
      userId: users[0],
      problemId,
      score: 0,
      verdict: 'WA',
      source: 'batch',
      batchId: 1,
    });
    upsertOfficialScore(db, {
      contestId,
      userId: users[3],
      problemId,
      score: 100,
      verdict: 'AC',
      source: 'batch',
      batchId: 1,
    });
    // The service paths that write official scores invalidate the cached
    // ranking, so simulate that for this direct repository write.
    invalidateOfficialRanking(db, contestId);
    const after = (await getContestAwards(db, contestId, root))!;
    expect(after.rows[0].userId).toBe(users[3]);
    for (const row of after.rows) {
      expect(row.certificateNo).toBe(certificates.get(row.userId));
    }
    expect(new Set(after.rows.map((row) => row.certificateNo)).size).toBe(4);
  });
});

describe('awards HTTP routes', () => {
  it('gates public awards until the contest ends but lets managers preview', async () => {
    const contestId = makeScoredContest('Running gate', [100, 90], { ended: false });

    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards`,
    });
    expect(anonymous.statusCode).toBe(401);

    const denied = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'AWARDS_NOT_READY' } });

    for (const userId of [adminId, managerId]) {
      const preview = await app.inject({
        method: 'GET',
        url: `/api/contests/${contestId}/awards`,
        headers: { cookie: cookieFor(userId) },
      });
      expect(preview.statusCode).toBe(200);
      expect(
        (preview.json() as { data: { rows: unknown[] } }).data.rows,
      ).toHaveLength(2);
    }

    db.prepare("UPDATE contests SET status = 'ended' WHERE id = ?").run(contestId);
    const visible = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(visible.statusCode).toBe(200);
    expect(
      (visible.json() as { data: { counts: { total: number } } }).data.counts.total,
    ).toBe(2);
  });

  it('validates and persists config through the admin API', async () => {
    const contestId = makeScoredContest('Admin config', [100, 90, 80, 70]);

    const invalid = await app.inject({
      method: 'PUT',
      url: `/api/admin/contests/${contestId}/awards/config`,
      headers: { cookie: cookieFor(adminId) },
      payload: { goldPercent: 60, silverPercent: 60, bronzePercent: 0 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_AWARD_CONFIG' } });
    expect(getContest(db, contestId)?.award_config_json).toBe('{}');

    const forbidden = await app.inject({
      method: 'PUT',
      url: `/api/admin/contests/${contestId}/awards/config`,
      headers: { cookie: cookieFor(contestantId) },
      payload: { goldPercent: 50, silverPercent: 30, bronzePercent: 20 },
    });
    expect(forbidden.statusCode).toBe(403);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/admin/contests/${contestId}/awards/config`,
      headers: { cookie: cookieFor(managerId) },
      payload: { goldPercent: 50, silverPercent: 30, bronzePercent: 20 },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      ok: true,
      data: { goldPercent: 50, silverPercent: 30, bronzePercent: 20 },
    });
    expect(JSON.parse(getContest(db, contestId)!.award_config_json)).toEqual({
      goldPercent: 50,
      silverPercent: 30,
      bronzePercent: 20,
    });

    const audit = db
      .prepare(
        "SELECT target_type, target_id, actor_id FROM audit_logs WHERE action = 'contest.awards.config.update' AND target_id = ? ORDER BY id DESC",
      )
      .get(String(contestId)) as
      | { target_type: string; target_id: string; actor_id: number }
      | undefined;
    expect(audit).toMatchObject({
      target_type: 'contest',
      target_id: String(contestId),
      actor_id: managerId,
    });

    const preview = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/awards`,
      headers: { cookie: cookieFor(managerId) },
    });
    expect(preview.statusCode).toBe(200);
    const data = (
      preview.json() as { data: { rows: Array<{ award: string | null }> } }
    ).data;
    expect(data.rows.map((row) => row.award)).toEqual([
      'gold',
      'gold',
      'silver',
      'bronze',
    ]);
  });

  it('returns 404 for missing contests', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/contests/999999/awards',
      headers: { cookie: cookieFor(adminId) },
    });
    expect(res.statusCode).toBe(404);
  });
});
