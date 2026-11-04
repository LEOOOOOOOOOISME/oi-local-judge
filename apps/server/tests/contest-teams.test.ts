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
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import {
  addParticipant,
  createContest,
  getContest,
  updateContest,
  type TeamMode,
} from '../src/storage/repos/contests.js';
import { getRegistrationRow } from '../src/storage/repos/contest-registrations.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { getSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  addTeamMember,
  createTeam,
  getTeam,
  leaveTeam,
  removeTeamMember,
  TeamError,
} from '../src/services/teams.js';
import { registerForContest } from '../src/services/contest-registrations.js';
import {
  ContestTeamError,
  getRegisteredTeamForUser,
  listContestTeams,
  registerTeamForContest,
  removeTeamFromContest,
  resolveSubmissionTeam,
} from '../src/services/contest-teams.js';
import { submitSource, type SubmitInput } from '../src/services/submissions.js';

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

type Username = 'admin' | 'manager' | 'alice' | 'bob' | 'carol' | 'dave';

interface Ctx {
  dir: string;
  db: DatabaseSync;
  config: Config;
  problemId: number;
  users: Record<Username, number>;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'oij-contest-teams-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  ensureDataDirs(dir);
  const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const users: Record<Username, number> = {
    admin: createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' }),
    manager: createUser(db, { username: 'manager', passwordHash: 'x', role: 'contestmanager' }),
    alice: createUser(db, { username: 'alice', passwordHash: 'x' }),
    bob: createUser(db, { username: 'bob', passwordHash: 'x' }),
    carol: createUser(db, { username: 'carol', passwordHash: 'x' }),
    dave: createUser(db, { username: 'dave', passwordHash: 'x' }),
  };
  const problemId = createProblem(db, {
    title: 'P1',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  return { dir, db, config, problemId, users };
}

function makeContest(
  ctx: Ctx,
  teamMode: TeamMode = 'team',
  startAt = 1000,
  endAt = 2000,
): number {
  return createContest(ctx.db, {
    name: `Contest-${teamMode}-${startAt}`,
    teamMode,
    startAt,
    endAt,
    problemIds: [ctx.problemId],
  });
}

function setRunning(ctx: Ctx, contestId: number): void {
  ctx.db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);
}

function makeTeam(
  ctx: Ctx,
  owner: Username,
  name: string,
  members: Username[] = [],
): number {
  const ownerId = ctx.users[owner];
  const teamId = createTeam(ctx.db, { name, ownerId });
  for (const member of members) {
    addTeamMember(ctx.db, { teamId, actorId: ownerId, username: member });
  }
  return teamId;
}

function expectContestTeamError(fn: () => unknown, code: string, status: number): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ContestTeamError);
  expect((caught as ContestTeamError).code).toBe(code);
  expect((caught as ContestTeamError).status).toBe(status);
}

function submit(ctx: Ctx, userId: number, contestId: number, extra: Partial<SubmitInput> = {}) {
  return submitSource(
    { db: ctx.db, config: ctx.config },
    {
      userId,
      problemId: ctx.problemId,
      contestId,
      language: 'cpp17',
      code: 'int main(){return 0;}',
      now: 1500,
      ...extra,
    },
  );
}

describe('contest team registration service', () => {
  it('defaults contests to individual and accepts team/both updates', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, { name: 'Default', problemIds: [ctx.problemId] });
    expect(getContest(ctx.db, contestId)?.team_mode).toBe('individual');

    updateContest(ctx.db, contestId, { teamMode: 'team' });
    expect(getContest(ctx.db, contestId)?.team_mode).toBe('team');

    updateContest(ctx.db, contestId, { teamMode: 'both' });
    expect(getContest(ctx.db, contestId)?.team_mode).toBe('both');
  });

  it('lets a captain register their team and lists registrations with members', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);

    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    const registrations = listContestTeams(ctx.db, contestId);
    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      teamId: alpha,
      name: 'Alpha',
      ownerId: ctx.users.alice,
      registeredBy: ctx.users.alice,
      registeredAt: 1111,
    });
    expect(registrations[0]?.members.map((member) => member.username)).toEqual(['alice', 'bob']);
    expect(registrations[0]?.members[0]).toMatchObject({
      userId: ctx.users.alice,
      role: 'captain',
      realName: null,
    });
    expect(getRegisteredTeamForUser(ctx.db, contestId, ctx.users.bob)).toBe(alpha);
    expect(getRegisteredTeamForUser(ctx.db, contestId, ctx.users.carol)).toBeNull();
  });

  it('adds every team member as an accepted contest participant on registration', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);

    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    expect(getRegistrationRow(ctx.db, contestId, ctx.users.alice)).toMatchObject({
      status: 'accepted',
      registered_at: 1111,
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'accepted',
      registered_at: 1111,
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.carol)).toBeNull();
  });

  it('preserves an existing individual participant row when the team registers', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    addParticipant(ctx.db, contestId, ctx.users.bob, 500);

    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    // The individual registration wins: its accepted status and timestamp stay.
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'accepted',
      registered_at: 500,
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.alice)).toMatchObject({
      status: 'accepted',
      registered_at: 1111,
    });
  });

  it('does not duplicate participant rows when a team registration is repeated', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId,
          teamId: alpha,
          actorId: ctx.users.alice,
          isAdmin: false,
          now: 2222,
        }),
      'TEAM_ALREADY_REGISTERED',
      409,
    );

    const rows = ctx.db
      .prepare(
        `SELECT user_id, status, registered_at FROM contest_participants
         WHERE contest_id = ? ORDER BY user_id`,
      )
      .all(contestId) as Array<{
      user_id: number;
      status: string;
      registered_at: number | null;
    }>;
    expect(rows).toEqual([
      { user_id: ctx.users.alice, status: 'accepted', registered_at: 1111 },
      { user_id: ctx.users.bob, status: 'accepted', registered_at: 1111 },
    ]);
  });

  it('keeps participant rows after removing a team, including individual imports', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    // An administrator imported bob individually before the team registered.
    addParticipant(ctx.db, contestId, ctx.users.bob, 500);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    removeTeamFromContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.admin,
      isAdmin: true,
    });

    // The admin-imported row is never deleted, and the team-derived row is kept
    // so removing a team does not silently revoke existing participants.
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'accepted',
      registered_at: 500,
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.alice)).toMatchObject({
      status: 'accepted',
      registered_at: 1111,
    });
  });

  it('lets an administrator register a team without being its captain', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const beta = makeTeam(ctx, 'carol', 'Beta', ['dave']);

    registerTeamForContest(ctx.db, {
      contestId,
      teamId: beta,
      actorId: ctx.users.admin,
      isAdmin: true,
    });

    expect(listContestTeams(ctx.db, contestId).map((row) => row.teamId)).toEqual([beta]);
  });

  it('rejects registration by a non-captain member or outsider', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'both');
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);

    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId,
          teamId: alpha,
          actorId: ctx.users.bob,
          isAdmin: false,
        }),
      'TEAM_FORBIDDEN',
      403,
    );
    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId,
          teamId: alpha,
          actorId: ctx.users.carol,
          isAdmin: false,
        }),
      'TEAM_FORBIDDEN',
      403,
    );
  });

  it('rejects duplicate registration of the same team', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha');
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId,
          teamId: alpha,
          actorId: ctx.users.alice,
          isAdmin: false,
        }),
      'TEAM_ALREADY_REGISTERED',
      409,
    );
    expect(listContestTeams(ctx.db, contestId)).toHaveLength(1);
  });

  it('rejects a team whose member already represents another team in the contest', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    const gamma = makeTeam(ctx, 'dave', 'Gamma', ['bob']);

    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId,
          teamId: gamma,
          actorId: ctx.users.dave,
          isAdmin: false,
        }),
      'TEAM_MEMBER_CONFLICT',
      409,
    );
    expect(listContestTeams(ctx.db, contestId).map((row) => row.teamId)).toEqual([alpha]);
  });

  it('rejects registration for individual contests and unknown contests/teams', () => {
    const ctx = setup();
    const individualId = makeContest(ctx, 'individual');
    const teamContestId = makeContest(ctx, 'team');
    const alpha = makeTeam(ctx, 'alice', 'Alpha');

    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId: individualId,
          teamId: alpha,
          actorId: ctx.users.alice,
          isAdmin: false,
        }),
      'TEAM_MODE_DISABLED',
      409,
    );
    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId: 999999,
          teamId: alpha,
          actorId: ctx.users.alice,
          isAdmin: true,
        }),
      'CONTEST_NOT_FOUND',
      404,
    );
    expectContestTeamError(
      () =>
        registerTeamForContest(ctx.db, {
          contestId: teamContestId,
          teamId: 999999,
          actorId: ctx.users.alice,
          isAdmin: true,
        }),
      'TEAM_NOT_FOUND',
      404,
    );
  });

  it('removes a registration as administrator and keeps the removal idempotent-safe', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha');
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });

    expectContestTeamError(
      () =>
        removeTeamFromContest(ctx.db, {
          contestId,
          teamId: alpha,
          actorId: ctx.users.alice,
          isAdmin: false,
        }),
      'TEAM_FORBIDDEN',
      403,
    );

    removeTeamFromContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.manager,
      isAdmin: true,
    });
    expect(listContestTeams(ctx.db, contestId)).toEqual([]);

    expectContestTeamError(
      () =>
        removeTeamFromContest(ctx.db, {
          contestId,
          teamId: alpha,
          actorId: ctx.users.admin,
          isAdmin: true,
        }),
      'TEAM_NOT_REGISTERED',
      404,
    );
  });
});

describe('submission team attribution', () => {
  it('attributes a submission to the registered team in team mode', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    addParticipant(ctx.db, contestId, ctx.users.bob);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);

    const { id } = submit(ctx, ctx.users.bob, contestId);
    expect(getSubmission(ctx.db, id)?.team_id).toBe(alpha);
    expect(resolveSubmissionTeam(ctx.db, { contestId, userId: ctx.users.bob })).toBe(alpha);
  });

  it('lets every registered team member submit and attributes it to the team', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);

    // No manual addParticipant call: registration itself grants eligibility.
    const captainSubmission = submit(ctx, ctx.users.alice, contestId);
    const memberSubmission = submit(ctx, ctx.users.bob, contestId);
    expect(getSubmission(ctx.db, captainSubmission.id)?.team_id).toBe(alpha);
    expect(getSubmission(ctx.db, memberSubmission.id)?.team_id).toBe(alpha);
  });

  it('rejects a user who is neither a participant nor a team member', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);

    expect(() => submit(ctx, ctx.users.carol, contestId)).toThrowError(
      /not a participant/i,
    );
  });

  it('rejects an unregistered submission in team mode with TEAM_REQUIRED', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'team');
    addParticipant(ctx.db, contestId, ctx.users.carol);
    setRunning(ctx, contestId);

    expectContestTeamError(() => submit(ctx, ctx.users.carol, contestId), 'TEAM_REQUIRED', 403);
  });

  it('falls back to an individual submission in both mode when no team is registered', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'both');
    addParticipant(ctx.db, contestId, ctx.users.carol);
    setRunning(ctx, contestId);

    expect(resolveSubmissionTeam(ctx.db, { contestId, userId: ctx.users.carol })).toBeNull();
    const { id } = submit(ctx, ctx.users.carol, contestId);
    expect(getSubmission(ctx.db, id)?.team_id).toBeNull();
  });

  it('never attributes a team in individual contests', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'individual');
    addParticipant(ctx.db, contestId, ctx.users.alice);
    setRunning(ctx, contestId);

    expect(
      resolveSubmissionTeam(ctx.db, {
        contestId,
        userId: ctx.users.alice,
        requestedTeamId: 12345,
      }),
    ).toBeNull();
    const { id } = submit(ctx, ctx.users.alice, contestId);
    expect(getSubmission(ctx.db, id)?.team_id).toBeNull();
  });

  it('validates an explicit requestedTeamId against registration and membership', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'both');
    addParticipant(ctx.db, contestId, ctx.users.alice);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    const beta = makeTeam(ctx, 'carol', 'Beta', ['dave']);
    for (const teamId of [alpha, beta]) {
      registerTeamForContest(ctx.db, {
        contestId,
        teamId,
        actorId: ctx.users.admin,
        isAdmin: true,
      });
    }

    expect(
      resolveSubmissionTeam(ctx.db, {
        contestId,
        userId: ctx.users.bob,
        requestedTeamId: alpha,
      }),
    ).toBe(alpha);
    expectContestTeamError(
      () =>
        resolveSubmissionTeam(ctx.db, {
          contestId,
          userId: ctx.users.bob,
          requestedTeamId: 999999,
        }),
      'TEAM_NOT_REGISTERED',
      403,
    );
    expectContestTeamError(
      () =>
        resolveSubmissionTeam(ctx.db, {
          contestId,
          userId: ctx.users.dave,
          requestedTeamId: alpha,
        }),
      'TEAM_MEMBER_REQUIRED',
      403,
    );

    // A user who joined two registered teams cannot be attributed implicitly.
    addTeamMember(ctx.db, { teamId: beta, actorId: ctx.users.carol, username: 'alice' });
    expectContestTeamError(
      () => resolveSubmissionTeam(ctx.db, { contestId, userId: ctx.users.alice }),
      'TEAM_AMBIGUOUS',
      409,
    );
    expect(
      resolveSubmissionTeam(ctx.db, {
        contestId,
        userId: ctx.users.alice,
        requestedTeamId: beta,
      }),
    ).toBe(beta);
  });

  it('writes an explicit teamId passed by the caller in both mode', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'both');
    addParticipant(ctx.db, contestId, ctx.users.bob);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);

    const { id } = submit(ctx, ctx.users.bob, contestId, { teamId: alpha });
    expect(getSubmission(ctx.db, id)?.team_id).toBe(alpha);
  });

  it('keeps internal batch submissions unattributed by default', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'team');
    setRunning(ctx, contestId);

    const { id } = submit(ctx, ctx.users.carol, contestId, {
      phase: 'batch_draft',
      skipCooldown: true,
    });
    expect(getSubmission(ctx.db, id)?.team_id).toBeNull();
  });

  it('keeps team_id on existing submissions after the registration is removed', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha');
    addParticipant(ctx.db, contestId, ctx.users.alice);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);

    const { id } = submit(ctx, ctx.users.alice, contestId);
    removeTeamFromContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.admin,
      isAdmin: true,
    });

    expect(listContestTeams(ctx.db, contestId)).toEqual([]);
    expect(getSubmission(ctx.db, id)?.team_id).toBe(alpha);
  });

  it('requires a team again after removal in team mode, keeping the participant row', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'team');
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);
    removeTeamFromContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.admin,
      isAdmin: true,
    });

    // Removing a team does not revoke the participant rows (documented semantics),
    // but team mode still requires a currently registered team to submit.
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)?.status).toBe('accepted');
    expectContestTeamError(() => submit(ctx, ctx.users.bob, contestId), 'TEAM_REQUIRED', 403);
  });

  it('retains individual eligibility in both mode after the team is removed', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'both');
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);
    removeTeamFromContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.admin,
      isAdmin: true,
    });

    // The retained participant row lets the member fall back to an individual
    // submission in both mode; it no longer gets a team attribution.
    const { id } = submit(ctx, ctx.users.bob, contestId);
    expect(getSubmission(ctx.db, id)?.team_id).toBeNull();
  });
});

describe('team membership contest sync', () => {
  it('grants participation when a new member joins a registered team', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha');
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toBeNull();

    const sync = addTeamMember(ctx.db, {
      teamId: alpha,
      actorId: ctx.users.alice,
      username: 'bob',
      now: 2000,
    });

    expect(sync).toEqual({ linkedContestIds: [contestId], skipped: [] });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'accepted',
      source: 'team',
      registered_at: 2000,
    });
  });

  it('returns an empty report when the team has no contest registration', () => {
    const ctx = setup();
    const alpha = makeTeam(ctx, 'alice', 'Alpha');
    const sync = addTeamMember(ctx.db, {
      teamId: alpha,
      actorId: ctx.users.alice,
      username: 'bob',
    });
    expect(sync).toEqual({ linkedContestIds: [], skipped: [] });
  });

  it('tracks participant provenance: manual, self and team', () => {
    const ctx = setup();
    const manualContest = makeContest(ctx);
    addParticipant(ctx.db, manualContest, ctx.users.carol, 400);
    expect(getRegistrationRow(ctx.db, manualContest, ctx.users.carol)).toMatchObject({
      status: 'accepted',
      source: 'manual',
    });

    const selfContest = createContest(ctx.db, {
      name: 'SelfOpen',
      teamMode: 'both',
      registrationMode: 'open',
      startAt: 10_000,
      endAt: 20_000,
      problemIds: [ctx.problemId],
    });
    expect(
      registerForContest(ctx.db, { contestId: selfContest, userId: ctx.users.dave, now: 500 }),
    ).toBe('accepted');
    expect(getRegistrationRow(ctx.db, selfContest, ctx.users.dave)).toMatchObject({
      status: 'accepted',
      source: 'self',
      registered_at: 500,
    });

    const teamContest = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId: teamContest,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });
    expect(getRegistrationRow(ctx.db, teamContest, ctx.users.alice)?.source).toBe('team');
    expect(getRegistrationRow(ctx.db, teamContest, ctx.users.bob)?.source).toBe('team');
  });

  it('revokes team-sourced participation when a member leaves or is removed', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    leaveTeam(ctx.db, alpha, ctx.users.bob);
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toBeNull();
    // The captain is still a member, so their participation stays.
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.alice)?.source).toBe('team');

    // Rejoining restores participation, and a captain removal revokes it again.
    addTeamMember(ctx.db, { teamId: alpha, actorId: ctx.users.alice, username: 'bob', now: 2000 });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)?.source).toBe('team');
    removeTeamMember(ctx.db, { teamId: alpha, actorId: ctx.users.alice, userId: ctx.users.bob });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toBeNull();
  });

  it('preserves administrator imports and self-registrations when membership ends', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'OpenTeamCup',
      teamMode: 'both',
      registrationMode: 'open',
      startAt: 100_000,
      endAt: 200_000,
      problemIds: [ctx.problemId],
    });
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob', 'carol']);
    // An administrator imported bob individually before the team registered.
    addParticipant(ctx.db, contestId, ctx.users.bob, 500);
    // carol registered herself.
    registerForContest(ctx.db, { contestId, userId: ctx.users.carol, now: 600 });
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    removeTeamMember(ctx.db, { teamId: alpha, actorId: ctx.users.alice, userId: ctx.users.bob });
    leaveTeam(ctx.db, alpha, ctx.users.carol);

    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'accepted',
      source: 'manual',
      registered_at: 500,
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.carol)).toMatchObject({
      status: 'accepted',
      source: 'self',
      registered_at: 600,
    });
  });

  it('keeps an explicit administrator add authoritative over team-derived rows', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)?.source).toBe('team');

    addParticipant(ctx.db, contestId, ctx.users.bob, 2222);
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'accepted',
      source: 'manual',
    });

    // Overwriting the provenance protects the row from the team removal path.
    removeTeamMember(ctx.db, { teamId: alpha, actorId: ctx.users.alice, userId: ctx.users.bob });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)?.source).toBe('manual');
  });

  it('skips contests where the user already represents another registered team', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha', ['bob']);
    const gamma = makeTeam(ctx, 'dave', 'Gamma');
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: gamma,
      actorId: ctx.users.dave,
      isAdmin: false,
      now: 1222,
    });

    const sync = addTeamMember(ctx.db, {
      teamId: gamma,
      actorId: ctx.users.dave,
      username: 'bob',
      now: 2000,
    });
    expect(sync).toEqual({
      linkedContestIds: [],
      skipped: [{ contestId, teamId: alpha, teamName: 'Alpha' }],
    });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      source: 'team',
      registered_at: 1111,
    });

    // Leaving Gamma does not revoke the row while Alpha still justifies it.
    removeTeamMember(ctx.db, { teamId: gamma, actorId: ctx.users.dave, userId: ctx.users.bob });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).not.toBeNull();

    // Once no registered team is left, the team-sourced row is removed.
    removeTeamMember(ctx.db, { teamId: alpha, actorId: ctx.users.alice, userId: ctx.users.bob });
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toBeNull();
  });

  it('keeps membership sync transactional and idempotent', () => {
    const ctx = setup();
    const contestId = makeContest(ctx);
    const alpha = makeTeam(ctx, 'alice', 'Alpha');
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
      now: 1111,
    });

    // Force the participant insert to fail: the membership insert must roll back.
    ctx.db.exec(
      `CREATE TRIGGER boom_participant_insert BEFORE INSERT ON contest_participants
       WHEN NEW.user_id = ${ctx.users.bob} BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() =>
      addTeamMember(ctx.db, {
        teamId: alpha,
        actorId: ctx.users.alice,
        username: 'bob',
        now: 2000,
      }),
    ).toThrow(/boom/);
    expect(getTeam(ctx.db, alpha)?.members.map((member) => member.username)).toEqual(['alice']);
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toBeNull();
    ctx.db.exec('DROP TRIGGER boom_participant_insert');

    const sync = addTeamMember(ctx.db, {
      teamId: alpha,
      actorId: ctx.users.alice,
      username: 'bob',
      now: 2000,
    });
    expect(sync.linkedContestIds).toEqual([contestId]);

    // A duplicate add is rejected and never duplicates participant rows.
    let duplicateAdd: unknown;
    try {
      addTeamMember(ctx.db, {
        teamId: alpha,
        actorId: ctx.users.alice,
        username: 'bob',
      });
    } catch (err) {
      duplicateAdd = err;
    }
    expect(duplicateAdd).toBeInstanceOf(TeamError);
    expect((duplicateAdd as TeamError).code).toBe('TEAM_MEMBER_EXISTS');
    const participantCount = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM contest_participants WHERE contest_id = ?')
      .get(contestId) as { n: number };
    expect(participantCount.n).toBe(2);

    // Leaving twice is rejected the second time and leaves no dangling rows.
    leaveTeam(ctx.db, alpha, ctx.users.bob);
    expect(getRegistrationRow(ctx.db, contestId, ctx.users.bob)).toBeNull();
    let duplicateLeave: unknown;
    try {
      leaveTeam(ctx.db, alpha, ctx.users.bob);
    } catch (err) {
      duplicateLeave = err;
    }
    expect(duplicateLeave).toBeInstanceOf(TeamError);
    expect((duplicateLeave as TeamError).code).toBe('TEAM_MEMBER_NOT_FOUND');
  });
});

describe('contest team HTTP API', () => {
  function sid(ctx: Ctx, username: Username): string {
    return `oij.sid=${signSession(
      { userId: ctx.users[username], version: 0 },
      ctx.config.sessionSecret,
      3600,
    )}`;
  }

  async function buildCtxApp(ctx: Ctx): Promise<FastifyInstance> {
    const app = await buildApp({ db: ctx.db, config: ctx.config });
    apps.push(app);
    return app;
  }

  async function api(
    app: FastifyInstance,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    ctx: Ctx,
    username: Username | null,
    payload?: unknown,
  ) {
    return app.inject({
      method,
      url,
      headers: username ? { cookie: sid(ctx, username) } : {},
      ...(payload === undefined ? {} : { payload }),
    });
  }

  function errorCode(body: unknown): string {
    return (body as { error: { code: string } }).error.code;
  }

  it('accepts teamMode on contest create and update', async () => {
    const ctx = setup();
    const app = await buildCtxApp(ctx);

    const created = await api(app, 'POST', '/api/admin/contests', ctx, 'admin', {
      name: 'HTTP Cup',
      teamMode: 'team',
      problemIds: [ctx.problemId],
    });
    expect(created.statusCode, created.body).toBe(201);
    const contestId = (created.json() as { data: { id: number } }).data.id;

    const detail = await api(app, 'GET', `/api/contests/${contestId}`, ctx, 'alice');
    expect(detail.statusCode).toBe(200);
    expect(
      (detail.json() as { data: { contest: { team_mode: string } } }).data.contest.team_mode,
    ).toBe('team');

    const updated = await api(app, 'PUT', `/api/admin/contests/${contestId}`, ctx, 'admin', {
      teamMode: 'both',
    });
    expect(updated.statusCode).toBe(200);
    const afterUpdate = await api(app, 'GET', `/api/contests/${contestId}`, ctx, 'alice');
    expect(
      (afterUpdate.json() as { data: { contest: { team_mode: string } } }).data.contest.team_mode,
    ).toBe('both');

    const invalid = await api(app, 'PUT', `/api/admin/contests/${contestId}`, ctx, 'admin', {
      teamMode: 'squad',
    });
    expect(invalid.statusCode).toBe(400);
    expect(errorCode(invalid.json())).toBe('INVALID_TEAM_MODE');

    const defaulted = await api(app, 'POST', '/api/admin/contests', ctx, 'admin', {
      name: 'HTTP Individual Cup',
      problemIds: [ctx.problemId],
    });
    const defaultId = (defaulted.json() as { data: { id: number } }).data.id;
    const defaultDetail = await api(app, 'GET', `/api/contests/${defaultId}`, ctx, 'alice');
    expect(
      (defaultDetail.json() as { data: { contest: { team_mode: string } } }).data.contest.team_mode,
    ).toBe('individual');
  });

  it('registers and removes teams through the HTTP routes with role checks', async () => {
    const ctx = setup();
    const app = await buildCtxApp(ctx);

    const createdTeam = await api(app, 'POST', '/api/teams', ctx, 'alice', { name: 'HttpAlpha' });
    expect(createdTeam.statusCode, createdTeam.body).toBe(201);
    const alpha = (createdTeam.json() as { data: { id: number } }).data.id;
    const added = await api(app, 'POST', `/api/teams/${alpha}/members`, ctx, 'alice', {
      username: 'bob',
    });
    expect(added.statusCode).toBe(201);

    const betaTeam = await api(app, 'POST', '/api/teams', ctx, 'carol', { name: 'HttpBeta' });
    const beta = (betaTeam.json() as { data: { id: number } }).data.id;

    const createdContest = await api(app, 'POST', '/api/admin/contests', ctx, 'admin', {
      name: 'Team Cup',
      teamMode: 'team',
      problemIds: [ctx.problemId],
    });
    const contestId = (createdContest.json() as { data: { id: number } }).data.id;

    const anonymous = await api(app, 'POST', `/api/contests/${contestId}/teams`, ctx, null, {
      teamId: alpha,
    });
    expect(anonymous.statusCode).toBe(401);
    expect(errorCode(anonymous.json())).toBe('UNAUTHORIZED');

    const nonCaptain = await api(app, 'POST', `/api/contests/${contestId}/teams`, ctx, 'bob', {
      teamId: alpha,
    });
    expect(nonCaptain.statusCode).toBe(403);
    expect(errorCode(nonCaptain.json())).toBe('TEAM_FORBIDDEN');

    const registered = await api(app, 'POST', `/api/contests/${contestId}/teams`, ctx, 'alice', {
      teamId: alpha,
    });
    expect(registered.statusCode, registered.body).toBe(201);

    const duplicate = await api(app, 'POST', `/api/contests/${contestId}/teams`, ctx, 'alice', {
      teamId: alpha,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('TEAM_ALREADY_REGISTERED');

    const memberView = await api(app, 'GET', `/api/contests/${contestId}/teams`, ctx, 'bob');
    expect(memberView.statusCode).toBe(200);
    expect((memberView.json() as { data: Array<{ teamId: number }> }).data).toEqual([
      expect.objectContaining({ teamId: alpha }),
    ]);

    const outsiderView = await api(app, 'GET', `/api/contests/${contestId}/teams`, ctx, 'carol');
    expect(outsiderView.statusCode).toBe(403);

    const managerView = await api(app, 'GET', `/api/contests/${contestId}/teams`, ctx, 'manager');
    expect(managerView.statusCode).toBe(200);

    const adminRegistered = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/teams`,
      ctx,
      'manager',
      { teamId: beta },
    );
    expect(adminRegistered.statusCode, adminRegistered.body).toBe(201);

    const removed = await api(
      app,
      'DELETE',
      `/api/admin/contests/${contestId}/teams/${beta}`,
      ctx,
      'manager',
    );
    expect(removed.statusCode).toBe(200);

    const removedAgain = await api(
      app,
      'DELETE',
      `/api/admin/contests/${contestId}/teams/${beta}`,
      ctx,
      'admin',
    );
    expect(removedAgain.statusCode).toBe(404);
    expect(errorCode(removedAgain.json())).toBe('TEAM_NOT_REGISTERED');

    const list = await api(app, 'GET', `/api/contests/${contestId}/teams`, ctx, 'admin');
    expect((list.json() as { data: Array<{ teamId: number }> }).data).toEqual([
      expect.objectContaining({ teamId: alpha }),
    ]);
  });

  it('attributes HTTP submissions and rejects unregistered team-only submissions', async () => {
    const ctx = setup();
    const app = await buildCtxApp(ctx);
    const now = Date.now();
    const contestId = makeContest(ctx, 'team', now - 60_000, now + 3_600_000);
    addParticipant(ctx.db, contestId, ctx.users.alice);
    addParticipant(ctx.db, contestId, ctx.users.carol);
    const alpha = makeTeam(ctx, 'alice', 'Alpha');
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: alpha,
      actorId: ctx.users.alice,
      isAdmin: false,
    });
    setRunning(ctx, contestId);

    const accepted = await api(app, 'POST', '/api/submissions', ctx, 'alice', {
      problemId: ctx.problemId,
      contestId,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
    const submissionId = (accepted.json() as { data: { id: number } }).data.id;
    expect(getSubmission(ctx.db, submissionId)?.team_id).toBe(alpha);

    const rejected = await api(app, 'POST', '/api/submissions', ctx, 'carol', {
      problemId: ctx.problemId,
      contestId,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(rejected.statusCode).toBe(403);
    expect(errorCode(rejected.json())).toBe('TEAM_REQUIRED');

    updateContest(ctx.db, contestId, { teamMode: 'both' });
    const individual = await api(app, 'POST', '/api/submissions', ctx, 'carol', {
      problemId: ctx.problemId,
      contestId,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(individual.statusCode, individual.body).toBe(201);
    const individualId = (individual.json() as { data: { id: number } }).data.id;
    expect(getSubmission(ctx.db, individualId)?.team_id).toBeNull();

    const wrongTeam = await api(app, 'POST', '/api/submissions', ctx, 'carol', {
      problemId: ctx.problemId,
      contestId,
      teamId: alpha,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(wrongTeam.statusCode).toBe(403);
    expect(errorCode(wrongTeam.json())).toBe('TEAM_MEMBER_REQUIRED');
  });
});
