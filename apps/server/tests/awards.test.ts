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
  getTeamContestAwards,
  normalizeAwardConfig,
  setAwardConfig,
  teamCertificateNo,
} from '../src/services/awards.js';
import { insertContestTeamRegistration } from '../src/storage/repos/contest-teams.js';
import {
  addParticipant,
  createContest,
  getContest,
  updateParticipant,
} from '../src/storage/repos/contests.js';
import { upsertOfficialScore } from '../src/storage/repos/official-scores.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { insertTeam, insertTeamMember } from '../src/storage/repos/teams.js';
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

interface TeamSpec {
  name: string;
  /** 队长在 `users` 中的下标。 */
  ownerIndex: number;
  /** 普通成员在 `users` 中的下标。 */
  memberIndexes?: number[];
  score: number;
}

interface ScoredTeamContest {
  contestId: number;
  teamIds: number[];
}

/** 写入一条已完成的团队赛提交。 */
function addTeamSubmission(
  contestId: number,
  teamId: number,
  userId: number,
  score: number,
  createdAt = 100,
): void {
  const submissionId = createSubmission(db, {
    contestId,
    problemId,
    userId,
    teamId,
    language: 'cpp17',
    sourcePath: 'x.cpp',
    sourceHash: 'h',
    createdAt,
  });
  db.prepare(
    `UPDATE submissions
       SET verdict = ?, score = ?, status = 'finished', phase = 'contest'
     WHERE id = ?`,
  ).run(score >= 100 ? 'AC' : 'WA', score, submissionId);
}

/**
 * 创建一个团队赛比赛，按名次写入团队提交并登记团队。
 * 只有登记过的团队会进入团队榜；提交通过 `submissions.team_id` 归属。
 */
function makeScoredTeamContest(
  name: string,
  teams: TeamSpec[],
  options: { ended?: boolean } = {},
): ScoredTeamContest {
  const contestId = createContest(db, {
    name,
    mode: 'oi',
    teamMode: 'team',
    startAt: 1000,
    endAt: 2000,
    problemIds: [problemId],
  });
  const teamIds: number[] = [];
  teams.forEach((team, index) => {
    const teamName = `${name} ${team.name}`;
    const teamId = insertTeam(db, {
      name: teamName,
      ownerId: users[team.ownerIndex],
      createdAt: 1,
    });
    insertTeamMember(db, {
      teamId,
      userId: users[team.ownerIndex],
      role: 'captain',
      joinedAt: 1,
    });
    addParticipant(db, contestId, users[team.ownerIndex]);
    for (const memberIndex of team.memberIndexes ?? []) {
      insertTeamMember(db, {
        teamId,
        userId: users[memberIndex],
        role: 'member',
        joinedAt: 1,
      });
      addParticipant(db, contestId, users[memberIndex]);
    }
    insertContestTeamRegistration(db, {
      contestId,
      teamId,
      registeredBy: null,
      registeredAt: 1,
    });
    addTeamSubmission(contestId, teamId, users[team.ownerIndex], team.score, 100 + index);
    teamIds.push(teamId);
  });
  if (options.ended !== false) {
    db.prepare("UPDATE contests SET status = 'ended' WHERE id = ?").run(contestId);
  }
  return { contestId, teamIds };
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

describe('team contest awards service', () => {
  it('awards team bands by team rank and attaches team certificate numbers', async () => {
    const specs: TeamSpec[] = Array.from({ length: 10 }, (_, index) => ({
      name: `Team ${index}`,
      ownerIndex: index,
      memberIndexes: index === 0 ? [10] : [],
      score: 100 - index * 10,
    }));
    const { contestId, teamIds } = makeScoredTeamContest('Team default bands', specs);

    const awards = (await getTeamContestAwards(db, contestId))!;
    expect(awards.scope).toBe('team');
    expect(awards.config).toEqual(DEFAULT_AWARD_CONFIG);
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
      teamId: teamIds[0],
      teamName: 'Team default bands Team 0',
      memberCount: 2,
      totalScore: 100,
      solved: 1,
    });
    expect(awards.rows[0].certificateNo).toBe(teamCertificateNo(contestId, teamIds[0]!));
    expect(awards.rows[0].certificateNo).toBe(`T${contestId}-${teamIds[0]}`);
    expect(awards.rows.every((row) => row.certificateNo.startsWith(`T${contestId}-`))).toBe(true);
  });

  it('keeps the same award for tied team ranks', async () => {
    const { contestId } = makeScoredTeamContest('Team ties', [
      { name: 'Alpha', ownerIndex: 0, score: 100 },
      { name: 'Beta', ownerIndex: 1, score: 90 },
      { name: 'Gamma', ownerIndex: 2, score: 90 },
      { name: 'Delta', ownerIndex: 3, score: 80 },
      { name: 'Epsilon', ownerIndex: 4, score: 70 },
    ]);

    const awards = (await getTeamContestAwards(db, contestId))!;
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

  it('returns an empty team awards table when no team is registered', async () => {
    const { contestId } = makeScoredTeamContest('Team empty', []);
    const awards = (await getTeamContestAwards(db, contestId))!;
    expect(awards.scope).toBe('team');
    expect(awards.rows).toEqual([]);
    expect(awards.counts).toEqual({ gold: 0, silver: 0, bronze: 0, total: 0 });
  });

  it('does not include teams that are not registered for the contest', async () => {
    const contestId = createContest(db, {
      name: 'Team unregistered',
      mode: 'oi',
      teamMode: 'team',
      startAt: 1000,
      endAt: 2000,
      problemIds: [problemId],
    });
    const registered = insertTeam(db, { name: 'Team registered', ownerId: users[0], createdAt: 1 });
    insertTeamMember(db, {
      teamId: registered,
      userId: users[0],
      role: 'captain',
      joinedAt: 1,
    });
    const unregistered = insertTeam(db, {
      name: 'Team unregistered',
      ownerId: users[1],
      createdAt: 1,
    });
    insertTeamMember(db, {
      teamId: unregistered,
      userId: users[1],
      role: 'captain',
      joinedAt: 1,
    });
    insertContestTeamRegistration(db, {
      contestId,
      teamId: registered,
      registeredBy: null,
      registeredAt: 1,
    });
    addTeamSubmission(contestId, registered, users[0], 60);
    addTeamSubmission(contestId, unregistered, users[1], 100, 200);

    const awards = (await getTeamContestAwards(db, contestId))!;
    expect(awards.rows.map((row) => row.teamId)).toEqual([registered]);
    expect(awards.rows[0]).toMatchObject({ teamName: 'Team registered', totalScore: 60 });
  });

  it('keeps individual and team scopes isolated', async () => {
    const { contestId, teamIds } = makeScoredTeamContest('Team scope isolation', [
      { name: 'Alpha', ownerIndex: 0, score: 100 },
      { name: 'Beta', ownerIndex: 1, score: 80 },
    ]);
    upsertOfficialScore(db, {
      contestId,
      userId: users[0],
      problemId,
      score: 100,
      verdict: 'AC',
      source: 'batch',
      batchId: 1,
    });
    upsertOfficialScore(db, {
      contestId,
      userId: users[1],
      problemId,
      score: 80,
      verdict: 'WA',
      source: 'batch',
      batchId: 1,
    });
    invalidateOfficialRanking(db, contestId);

    const individual = (await getContestAwards(db, contestId, root))!;
    expect(individual.scope).toBe('individual');
    expect(individual.rows.map((row) => row.userId)).toEqual([users[0], users[1]]);
    expect(individual.rows.some((row) => 'teamId' in row)).toBe(false);

    const team = (await getTeamContestAwards(db, contestId))!;
    expect(team.scope).toBe('team');
    expect(team.rows.map((row) => row.teamId)).toEqual(teamIds);
    expect(team.rows.some((row) => 'userId' in row)).toBe(false);
  });

  it('rejects the team scope for contests that do not accept teams', async () => {
    const contestId = makeScoredContest('Team scope individual only', [100, 90]);
    let error: unknown;
    try {
      getTeamContestAwards(db, contestId);
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ code: 'SCOPE_NOT_TEAM', status: 400 });
    expect(await getTeamContestAwards(db, 999999)).toBeNull();
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

describe('team awards HTTP routes', () => {
  it('serves team awards for ended team contests and gates unfinished ones', async () => {
    const { contestId, teamIds } = makeScoredTeamContest(
      'Team HTTP running',
      [
        { name: 'Alpha', ownerIndex: 0, score: 100 },
        { name: 'Beta', ownerIndex: 1, score: 80 },
      ],
      { ended: false },
    );

    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=team`,
    });
    expect(anonymous.statusCode).toBe(401);

    const denied = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=team`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: { code: 'AWARDS_NOT_READY' } });

    const preview = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=team`,
      headers: { cookie: cookieFor(managerId) },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ data: { scope: 'team' } });

    db.prepare("UPDATE contests SET status = 'ended' WHERE id = ?").run(contestId);
    const visible = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=team`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(visible.statusCode).toBe(200);
    const data = (
      visible.json() as {
        data: {
          scope: string;
          rows: Array<{ teamId: number; teamName: string; certificateNo: string }>;
          counts: { total: number };
        };
      }
    ).data;
    expect(data.scope).toBe('team');
    expect(data.rows.map((row) => row.teamId)).toEqual(teamIds);
    expect(data.rows.map((row) => row.teamName)).toEqual([
      'Team HTTP running Alpha',
      'Team HTTP running Beta',
    ]);
    expect(data.rows[0]?.certificateNo).toBe(`T${contestId}-${teamIds[0]}`);
    expect(data.counts.total).toBe(2);
  });

  it('defaults to individual scope and validates the scope parameter', async () => {
    const { contestId } = makeScoredTeamContest('Team HTTP scope', [
      { name: 'Alpha', ownerIndex: 0, score: 100 },
    ]);

    const byDefault = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(byDefault.statusCode).toBe(200);
    expect(byDefault.json()).toMatchObject({ data: { scope: 'individual' } });

    const explicitIndividual = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=individual`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(explicitIndividual.statusCode).toBe(200);
    expect(explicitIndividual.json()).toMatchObject({ data: { scope: 'individual' } });

    const team = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=team`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(team.statusCode).toBe(200);
    expect(team.json()).toMatchObject({ data: { scope: 'team' } });

    const adminTeam = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/awards?scope=team`,
      headers: { cookie: cookieFor(adminId) },
    });
    expect(adminTeam.statusCode).toBe(200);
    expect(adminTeam.json()).toMatchObject({ data: { scope: 'team' } });

    const invalid = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=squad`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: 'INVALID_SCOPE' } });
  });

  it('rejects team scope for a non-team contest', async () => {
    const contestId = makeScoredContest('Team HTTP individual only', [100, 90]);

    const publicRes = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards?scope=team`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(publicRes.statusCode).toBe(400);
    expect(publicRes.json()).toMatchObject({ error: { code: 'SCOPE_NOT_TEAM' } });

    const individualRes = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/awards`,
      headers: { cookie: cookieFor(contestantId) },
    });
    expect(individualRes.statusCode).toBe(200);

    const adminRes = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/awards?scope=team`,
      headers: { cookie: cookieFor(adminId) },
    });
    expect(adminRes.statusCode).toBe(400);
    expect(adminRes.json()).toMatchObject({ error: { code: 'SCOPE_NOT_TEAM' } });
  });
});
