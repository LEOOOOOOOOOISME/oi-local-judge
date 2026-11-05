import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { signSession } from '../src/security/session.js';
import { listAuditLogs } from '../src/storage/repos/audit.js';
import {
  addParticipant,
  createContest,
  getContest,
  getParticipants,
  getVisibleParticipants,
  isContestParticipant,
  isRegistrationMode,
  updateContest,
  updateParticipant,
  type RegistrationMode,
} from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createUser } from '../src/storage/repos/users.js';
import { getContestRanking } from '../src/services/contests.js';
import {
  ContestRegistrationError,
  cancelRegistration,
  checkInParticipant,
  getMyRegistration,
  listRegistrations,
  registerForContest,
  reviewRegistration,
} from '../src/services/contest-registrations.js';

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

type Username = 'admin' | 'manager' | 'alice' | 'bob' | 'carol';

interface Ctx {
  dir: string;
  db: DatabaseSync;
  config: Config;
  problemId: number;
  users: Record<Username, number>;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'oij-contest-registration-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  ensureDataDirs(dir);
  const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const users: Record<Username, number> = {
    admin: createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' }),
    manager: createUser(db, { username: 'manager', passwordHash: 'x', role: 'contestmanager' }),
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
  mode: RegistrationMode = 'manual',
  times: {
    startAt?: number | null;
    endAt?: number | null;
    registrationOpenAt?: number | null;
    registrationCloseAt?: number | null;
  } = {},
): number {
  return createContest(ctx.db, {
    name: `Contest-${mode}`,
    registrationMode: mode,
    startAt: times.startAt ?? 1000,
    endAt: times.endAt ?? null,
    registrationOpenAt: times.registrationOpenAt ?? null,
    registrationCloseAt: times.registrationCloseAt ?? null,
    problemIds: [ctx.problemId],
  });
}

function expectRegistrationError(
  fn: () => unknown,
  code: string,
  status: number,
): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ContestRegistrationError);
  expect((caught as ContestRegistrationError).code).toBe(code);
  expect((caught as ContestRegistrationError).status).toBe(status);
}

function auditActions(db: DatabaseSync, action: string) {
  return listAuditLogs(db).filter((row) => row.action === action);
}

describe('contest registration settings', () => {
  it('defaults to manual and accepts registrationMode on create and update', () => {
    const ctx = setup();
    const plain = createContest(ctx.db, { name: 'Plain', problemIds: [ctx.problemId] });
    expect(getContest(ctx.db, plain)?.registration_mode).toBe('manual');

    const open = makeContest(ctx, 'open');
    expect(getContest(ctx.db, open)?.registration_mode).toBe('open');

    updateContest(ctx.db, open, { registrationMode: 'approval' });
    expect(getContest(ctx.db, open)?.registration_mode).toBe('approval');

    expect(isRegistrationMode('open')).toBe(true);
    expect(isRegistrationMode('manual')).toBe(true);
    expect(isRegistrationMode('approval')).toBe(true);
    expect(isRegistrationMode('closed')).toBe(false);
  });

  it('keeps legacy participant rows accepted and without check-in data', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'manual');
    ctx.db
      .prepare("INSERT INTO contest_participants(contest_id, user_id) VALUES (?, ?)")
      .run(contestId, ctx.users.alice);
    const row = getMyRegistration(ctx.db, contestId, ctx.users.alice);
    expect(row).toMatchObject({
      status: 'accepted',
      checkedInAt: null,
      reviewedAt: null,
      reviewedBy: null,
    });
    expect(row?.registeredAt).toBeNull();
  });
});

describe('contest registration service', () => {
  it('auto-accepts open registration and records registered_at', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'open');

    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 5000 }),
    ).toBe('accepted');

    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)).toMatchObject({
      contestId,
      userId: ctx.users.alice,
      username: 'alice',
      realName: 'Alice',
      className: '1班',
      status: 'accepted',
      registeredAt: 5000,
      checkedInAt: null,
      reviewedAt: null,
      reviewedBy: null,
      submissionCount: 0,
      lastSubmissionAt: null,
    });
  });

  it('keeps approval registration pending until reviewed', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval');

    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 5001 }),
    ).toBe('pending');
    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)).toMatchObject({
      status: 'pending',
      registeredAt: 5001,
    });
  });

  it('rejects self-registration in manual mode and for unknown contests', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'manual');

    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId, userId: ctx.users.alice }),
      'REGISTRATION_DISABLED',
      403,
    );
    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId: 999999, userId: ctx.users.alice }),
      'CONTEST_NOT_FOUND',
      404,
    );
  });

  it('rejects registration after the contest has ended', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'open', { startAt: 1000, endAt: 2000 });

    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 2000 }),
      'REGISTRATION_CLOSED',
      403,
    );
    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 1999 }),
    ).toBe('accepted');
  });

  it('rejects duplicate accepted and pending registrations with 409', () => {
    const ctx = setup();
    const open = makeContest(ctx, 'open');
    registerForContest(ctx.db, { contestId: open, userId: ctx.users.alice });
    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId: open, userId: ctx.users.alice }),
      'ALREADY_REGISTERED',
      409,
    );

    const approval = makeContest(ctx, 'approval');
    registerForContest(ctx.db, { contestId: approval, userId: ctx.users.bob });
    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId: approval, userId: ctx.users.bob }),
      'ALREADY_REGISTERED',
      409,
    );
  });

  it('lets a rejected applicant register again', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval');
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 100 });
    reviewRegistration(ctx.db, {
      contestId,
      userId: ctx.users.alice,
      action: 'reject',
      actorId: ctx.users.admin,
      now: 200,
    });

    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 300 }),
    ).toBe('pending');
    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)).toMatchObject({
      status: 'pending',
      registeredAt: 300,
      reviewedAt: null,
      reviewedBy: null,
    });
  });

  it('cancels pending registrations only', () => {
    const ctx = setup();
    const approval = makeContest(ctx, 'approval');
    registerForContest(ctx.db, { contestId: approval, userId: ctx.users.alice });
    cancelRegistration(ctx.db, { contestId: approval, userId: ctx.users.alice });
    expect(getMyRegistration(ctx.db, approval, ctx.users.alice)).toBeNull();
    expectRegistrationError(
      () => cancelRegistration(ctx.db, { contestId: approval, userId: ctx.users.alice }),
      'NOT_REGISTERED',
      404,
    );

    const open = makeContest(ctx, 'open');
    registerForContest(ctx.db, { contestId: open, userId: ctx.users.bob });
    expectRegistrationError(
      () => cancelRegistration(ctx.db, { contestId: open, userId: ctx.users.bob }),
      'CANNOT_CANCEL',
      409,
    );
  });

  it('approves and rejects pending registrations with audit entries', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval');
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice });
    registerForContest(ctx.db, { contestId, userId: ctx.users.bob });

    reviewRegistration(ctx.db, {
      contestId,
      userId: ctx.users.alice,
      action: 'approve',
      actorId: ctx.users.manager,
      now: 6100,
    });
    reviewRegistration(ctx.db, {
      contestId,
      userId: ctx.users.bob,
      action: 'reject',
      actorId: ctx.users.admin,
      now: 6200,
    });

    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)).toMatchObject({
      status: 'accepted',
      reviewedAt: 6100,
      reviewedBy: ctx.users.manager,
    });
    expect(getMyRegistration(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'rejected',
      reviewedAt: 6200,
      reviewedBy: ctx.users.admin,
    });

    const approvals = auditActions(ctx.db, 'contest.registration.approve');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      actor_id: ctx.users.manager,
      target_type: 'contest_participant',
      target_id: `${contestId}:${ctx.users.alice}`,
    });
    expect(JSON.parse(approvals[0]!.detail_json)).toMatchObject({
      contestId,
      userId: ctx.users.alice,
      status: 'accepted',
    });
    expect(auditActions(ctx.db, 'contest.registration.reject')).toHaveLength(1);

    expectRegistrationError(
      () =>
        reviewRegistration(ctx.db, {
          contestId,
          userId: ctx.users.alice,
          action: 'approve',
          actorId: ctx.users.admin,
        }),
      'NOT_PENDING',
      409,
    );
    expectRegistrationError(
      () =>
        reviewRegistration(ctx.db, {
          contestId,
          userId: ctx.users.carol,
          action: 'approve',
          actorId: ctx.users.admin,
        }),
      'NOT_REGISTERED',
      404,
    );
  });

  it('checks in accepted participants idempotently and rejects pending ones', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval');
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice });
    registerForContest(ctx.db, { contestId, userId: ctx.users.bob });
    reviewRegistration(ctx.db, {
      contestId,
      userId: ctx.users.alice,
      action: 'approve',
      actorId: ctx.users.admin,
      now: 100,
    });

    checkInParticipant(ctx.db, {
      contestId,
      userId: ctx.users.alice,
      actorId: ctx.users.manager,
      now: 7000,
    });
    checkInParticipant(ctx.db, {
      contestId,
      userId: ctx.users.alice,
      actorId: ctx.users.manager,
      now: 8000,
    });
    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)?.checkedInAt).toBe(7000);

    const audits = auditActions(ctx.db, 'contest.registration.check_in');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_id).toBe(ctx.users.manager);

    expectRegistrationError(
      () =>
        checkInParticipant(ctx.db, {
          contestId,
          userId: ctx.users.bob,
          actorId: ctx.users.admin,
        }),
      'NOT_ACCEPTED',
      403,
    );
    expectRegistrationError(
      () =>
        checkInParticipant(ctx.db, {
          contestId,
          userId: ctx.users.carol,
          actorId: ctx.users.admin,
        }),
      'NOT_REGISTERED',
      404,
    );
  });

  it('lets an administrator add a participant as accepted with registered_at', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval');
    addParticipant(ctx.db, contestId, ctx.users.bob, 4321);
    expect(getMyRegistration(ctx.db, contestId, ctx.users.bob)).toMatchObject({
      status: 'accepted',
      registeredAt: 4321,
    });
  });
});

describe('registration window', () => {
  it('rejects self-registration before the window opens', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'open', {
      startAt: 1000,
      endAt: 100_000,
      registrationOpenAt: 5000,
      registrationCloseAt: 9000,
    });

    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 4999 }),
      'REGISTRATION_NOT_OPEN',
      403,
    );
    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 5000 }),
    ).toBe('accepted');
  });

  it('rejects self-registration after the window closes', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'open', {
      startAt: 1000,
      endAt: 100_000,
      registrationOpenAt: 2000,
      registrationCloseAt: 3000,
    });

    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 3001 }),
      'REGISTRATION_CLOSED',
      403,
    );
    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 3000 }),
    ).toBe('accepted');
  });

  it('leaves registration unrestricted when the window bounds are null', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'open', { registrationOpenAt: null, registrationCloseAt: null });

    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 1 }),
    ).toBe('accepted');
  });

  it('keeps approval registrations pending only inside the window', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval', {
      startAt: 1000,
      endAt: 100_000,
      registrationOpenAt: 2000,
      registrationCloseAt: 3000,
    });

    expectRegistrationError(
      () => registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 1999 }),
      'REGISTRATION_NOT_OPEN',
      403,
    );
    expect(
      registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 2500 }),
    ).toBe('pending');
  });

  it('lets administrators review pending registrations outside the window', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval', {
      startAt: 1000,
      endAt: 100_000,
      registrationOpenAt: 2000,
      registrationCloseAt: 3000,
    });
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 2500 });

    reviewRegistration(ctx.db, {
      contestId,
      userId: ctx.users.alice,
      action: 'approve',
      actorId: ctx.users.admin,
      now: 99_000,
    });

    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)?.status).toBe('accepted');
  });

  it('lets accepted participants cancel before the contest starts', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'open', { startAt: 5000, endAt: 9000 });
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 1000 });

    cancelRegistration(ctx.db, { contestId, userId: ctx.users.alice, now: 4999 });
    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)).toBeNull();

    registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 2000 });
    expectRegistrationError(
      () => cancelRegistration(ctx.db, { contestId, userId: ctx.users.alice, now: 5000 }),
      'CANNOT_CANCEL',
      409,
    );
  });

  it('rejects accepted cancellation once the contest is running or ended', () => {
    const ctx = setup();
    const runningId = makeContest(ctx, 'open', { startAt: 1000, endAt: 100_000 });
    registerForContest(ctx.db, { contestId: runningId, userId: ctx.users.alice, now: 500 });
    ctx.db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(runningId);
    expectRegistrationError(
      () => cancelRegistration(ctx.db, { contestId: runningId, userId: ctx.users.alice, now: 6000 }),
      'CANNOT_CANCEL',
      409,
    );

    const endedId = makeContest(ctx, 'open', { startAt: 1000, endAt: 100_000 });
    addParticipant(ctx.db, endedId, ctx.users.bob);
    ctx.db.prepare("UPDATE contests SET status = 'ended' WHERE id = ?").run(endedId);
    expectRegistrationError(
      () => cancelRegistration(ctx.db, { contestId: endedId, userId: ctx.users.bob, now: 6000 }),
      'CANNOT_CANCEL',
      409,
    );
  });

  it('still cancels pending registrations after the contest starts', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval', { startAt: 1000, endAt: 100_000 });
    ctx.db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 5000 });

    cancelRegistration(ctx.db, { contestId, userId: ctx.users.alice, now: 6000 });
    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)).toBeNull();
  });
});

describe('accepted-only participation', () => {
  it('only counts accepted participants in participant lists and rankings', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval');
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice });
    addParticipant(ctx.db, contestId, ctx.users.bob);
    registerForContest(ctx.db, { contestId, userId: ctx.users.carol });
    reviewRegistration(ctx.db, {
      contestId,
      userId: ctx.users.carol,
      action: 'reject',
      actorId: ctx.users.admin,
    });

    expect(getParticipants(ctx.db, contestId)).toEqual([ctx.users.bob]);
    expect(getVisibleParticipants(ctx.db, contestId)).toEqual([ctx.users.bob]);
    expect(isContestParticipant(ctx.db, contestId, ctx.users.alice)).toBe(false);
    expect(isContestParticipant(ctx.db, contestId, ctx.users.bob)).toBe(true);
    expect(isContestParticipant(ctx.db, contestId, ctx.users.carol)).toBe(false);

    const ranking = getContestRanking(ctx.db, contestId);
    expect(ranking?.rows.map((row) => row.userId)).toEqual([ctx.users.bob]);

    updateParticipant(ctx.db, contestId, ctx.users.bob, { hidden: true });
    expect(getVisibleParticipants(ctx.db, contestId)).toEqual([]);
    expect(getParticipants(ctx.db, contestId)).toEqual([ctx.users.bob]);
  });

  it('lists user profile, status timestamps and submission stats', () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'open');
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: 5000 });
    addParticipant(ctx.db, contestId, ctx.users.bob, 5100);
    createSubmission(ctx.db, {
      contestId,
      problemId: ctx.problemId,
      userId: ctx.users.bob,
      language: 'cpp17',
      sourcePath: 'bob-1.cpp',
      sourceHash: 'h1',
      createdAt: 6000,
    });
    createSubmission(ctx.db, {
      contestId,
      problemId: ctx.problemId,
      userId: ctx.users.bob,
      language: 'cpp17',
      sourcePath: 'bob-2.cpp',
      sourceHash: 'h2',
      createdAt: 7000,
    });
    checkInParticipant(ctx.db, {
      contestId,
      userId: ctx.users.bob,
      actorId: ctx.users.manager,
      now: 8000,
    });

    const rows = listRegistrations(ctx.db, contestId);
    const alice = rows.find((row) => row.userId === ctx.users.alice);
    expect(alice).toMatchObject({
      username: 'alice',
      realName: 'Alice',
      className: '1班',
      status: 'accepted',
      registeredAt: 5000,
      checkedInAt: null,
      reviewedAt: null,
      submissionCount: 0,
      lastSubmissionAt: null,
    });
    const bob = rows.find((row) => row.userId === ctx.users.bob);
    expect(bob).toMatchObject({
      username: 'bob',
      realName: 'Bob',
      className: '1班',
      status: 'accepted',
      registeredAt: 5100,
      checkedInAt: 8000,
      submissionCount: 2,
      lastSubmissionAt: 7000,
    });
  });
});

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

function makeRunningContest(
  ctx: Ctx,
  mode: RegistrationMode,
  now = Date.now(),
): number {
  const contestId = makeContest(ctx, mode, {
    startAt: now - 60_000,
    endAt: now + 3_600_000,
  });
  ctx.db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);
  return contestId;
}

describe('contest registration HTTP API', () => {
  it('accepts registrationMode on contest create and update', async () => {
    const ctx = setup();
    const app = await buildCtxApp(ctx);

    const created = await api(app, 'POST', '/api/admin/contests', ctx, 'admin', {
      name: 'Open Cup',
      registrationMode: 'open',
      problemIds: [ctx.problemId],
    });
    expect(created.statusCode, created.body).toBe(201);
    const contestId = (created.json() as { data: { id: number } }).data.id;

    const detail = await api(app, 'GET', `/api/contests/${contestId}`, ctx, 'alice');
    expect(
      (detail.json() as { data: { contest: { registration_mode: string } } }).data.contest
        .registration_mode,
    ).toBe('open');

    const updated = await api(app, 'PUT', `/api/admin/contests/${contestId}`, ctx, 'admin', {
      registrationMode: 'approval',
    });
    expect(updated.statusCode).toBe(200);
    const updatedDetail = await api(app, 'GET', `/api/contests/${contestId}`, ctx, 'alice');
    expect(
      (updatedDetail.json() as { data: { contest: { registration_mode: string } } }).data.contest
        .registration_mode,
    ).toBe('approval');

    const invalidUpdate = await api(app, 'PUT', `/api/admin/contests/${contestId}`, ctx, 'admin', {
      registrationMode: 'closed',
    });
    expect(invalidUpdate.statusCode).toBe(400);
    expect(errorCode(invalidUpdate.json())).toBe('INVALID_REGISTRATION_MODE');

    const invalidCreate = await api(app, 'POST', '/api/admin/contests', ctx, 'admin', {
      name: 'Bad Cup',
      registrationMode: 'closed',
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(errorCode(invalidCreate.json())).toBe('INVALID_REGISTRATION_MODE');
  });

  it('lets contestants register, read and cancel their own registration', async () => {
    const ctx = setup();
    const openId = makeContest(ctx, 'open');
    const approvalId = makeContest(ctx, 'approval');
    const manualId = makeContest(ctx, 'manual');
    const app = await buildCtxApp(ctx);

    const anonymous = await api(app, 'GET', `/api/contests/${openId}/registration`, ctx, null);
    expect(anonymous.statusCode).toBe(401);

    const before = await api(app, 'GET', `/api/contests/${openId}/registration`, ctx, 'alice');
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toMatchObject({ data: { mode: 'open', registration: null } });

    const registered = await api(app, 'POST', `/api/contests/${openId}/register`, ctx, 'alice');
    expect(registered.statusCode, registered.body).toBe(200);
    expect((registered.json() as { data: { status: string } }).data.status).toBe('accepted');

    const mine = await api(app, 'GET', `/api/contests/${openId}/registration`, ctx, 'alice');
    expect(mine.json()).toMatchObject({
      data: {
        mode: 'open',
        registration: {
          status: 'accepted',
          username: 'alice',
          realName: 'Alice',
          className: '1班',
        },
      },
    });

    const duplicate = await api(
      app,
      'POST',
      `/api/contests/${openId}/register`,
      ctx,
      'alice',
    );
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('ALREADY_REGISTERED');

    const cannotCancel = await api(
      app,
      'DELETE',
      `/api/contests/${openId}/register`,
      ctx,
      'alice',
    );
    expect(cannotCancel.statusCode).toBe(409);
    expect(errorCode(cannotCancel.json())).toBe('CANNOT_CANCEL');

    const pending = await api(
      app,
      'POST',
      `/api/contests/${approvalId}/register`,
      ctx,
      'bob',
    );
    expect(pending.statusCode, pending.body).toBe(200);
    expect((pending.json() as { data: { status: string } }).data.status).toBe('pending');
    const cancelled = await api(
      app,
      'DELETE',
      `/api/contests/${approvalId}/register`,
      ctx,
      'bob',
    );
    expect(cancelled.statusCode).toBe(200);
    const afterCancel = await api(
      app,
      'GET',
      `/api/contests/${approvalId}/registration`,
      ctx,
      'bob',
    );
    expect((afterCancel.json() as { data: { registration: unknown } }).data.registration).toBeNull();

    const disabled = await api(app, 'POST', `/api/contests/${manualId}/register`, ctx, 'carol');
    expect(disabled.statusCode).toBe(403);
    expect(errorCode(disabled.json())).toBe('REGISTRATION_DISABLED');
  });

  it('lets managers review, check in and see pending participants but blocks them from submitting', async () => {
    const ctx = setup();
    const contestId = makeRunningContest(ctx, 'approval');
    const app = await buildCtxApp(ctx);

    expect(
      (await api(app, 'POST', `/api/contests/${contestId}/register`, ctx, 'bob')).statusCode,
    ).toBe(200);
    expect(
      (await api(app, 'POST', `/api/contests/${contestId}/register`, ctx, 'alice')).statusCode,
    ).toBe(200);
    expect(
      (await api(app, 'POST', `/api/contests/${contestId}/register`, ctx, 'carol')).statusCode,
    ).toBe(200);

    const anonymousList = await api(
      app,
      'GET',
      `/api/admin/contests/${contestId}/registrations`,
      ctx,
      null,
    );
    expect(anonymousList.statusCode).toBe(401);
    const contestantList = await api(
      app,
      'GET',
      `/api/admin/contests/${contestId}/registrations`,
      ctx,
      'alice',
    );
    expect(contestantList.statusCode).toBe(403);
    expect(errorCode(contestantList.json())).toBe('FORBIDDEN');

    const managerList = await api(
      app,
      'GET',
      `/api/admin/contests/${contestId}/registrations`,
      ctx,
      'manager',
    );
    expect(managerList.statusCode, managerList.body).toBe(200);
    const listed = (managerList.json() as {
      data: Array<{ userId: number; status: string; submissionCount: number }>;
    }).data;
    expect(listed).toHaveLength(3);
    expect(listed.every((row) => row.status === 'pending')).toBe(true);

    const pendingSubmit = await api(app, 'POST', '/api/submissions', ctx, 'bob', {
      problemId: ctx.problemId,
      contestId,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(pendingSubmit.statusCode).toBe(403);
    expect(errorCode(pendingSubmit.json())).toBe('NOT_ACCEPTED');

    const approved = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/registrations/${ctx.users.bob}/approve`,
      ctx,
      'manager',
    );
    expect(approved.statusCode, approved.body).toBe(200);
    const approvedMine = await api(
      app,
      'GET',
      `/api/contests/${contestId}/registration`,
      ctx,
      'bob',
    );
    expect(approvedMine.json()).toMatchObject({
      data: { registration: { status: 'accepted', reviewedBy: ctx.users.manager } },
    });

    const acceptedSubmit = await api(app, 'POST', '/api/submissions', ctx, 'bob', {
      problemId: ctx.problemId,
      contestId,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(acceptedSubmit.statusCode, acceptedSubmit.body).toBe(201);

    const rejected = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/registrations/${ctx.users.carol}/reject`,
      ctx,
      'manager',
    );
    expect(rejected.statusCode).toBe(200);
    const rejectedSubmit = await api(app, 'POST', '/api/submissions', ctx, 'carol', {
      problemId: ctx.problemId,
      contestId,
      language: 'cpp17',
      code: 'int main(){return 0;}',
    });
    expect(rejectedSubmit.statusCode).toBe(403);
    expect(errorCode(rejectedSubmit.json())).toBe('NOT_ACCEPTED');

    const checkedIn = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/registrations/${ctx.users.bob}/check-in`,
      ctx,
      'manager',
    );
    expect(checkedIn.statusCode, checkedIn.body).toBe(200);
    const pendingCheckIn = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/registrations/${ctx.users.alice}/check-in`,
      ctx,
      'manager',
    );
    expect(pendingCheckIn.statusCode).toBe(403);
    expect(errorCode(pendingCheckIn.json())).toBe('NOT_ACCEPTED');

    const finalList = await api(
      app,
      'GET',
      `/api/admin/contests/${contestId}/registrations`,
      ctx,
      'manager',
    );
    const bobRow = (finalList.json() as {
      data: Array<{ userId: number; checkedInAt: number | null; submissionCount: number }>;
    }).data.find((row) => row.userId === ctx.users.bob);
    expect(bobRow?.checkedInAt).toEqual(expect.any(Number));
    expect(bobRow?.submissionCount).toBe(1);

    const actions = listAuditLogs(ctx.db).map((row) => row.action);
    expect(actions).toContain('contest.registration.approve');
    expect(actions).toContain('contest.registration.reject');
    expect(actions).toContain('contest.registration.check_in');
  });

  it('keeps admin manual participant adds accepted and reports their submission stats', async () => {
    const ctx = setup();
    const contestId = makeContest(ctx, 'approval');
    const app = await buildCtxApp(ctx);

    const added = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/participants`,
      ctx,
      'manager',
      { userIds: [ctx.users.bob] },
    );
    expect(added.statusCode, added.body).toBe(200);

    createSubmission(ctx.db, {
      contestId,
      problemId: ctx.problemId,
      userId: ctx.users.bob,
      language: 'cpp17',
      sourcePath: 'bob.cpp',
      sourceHash: 'h1',
      createdAt: 7000,
    });

    const listed = await api(
      app,
      'GET',
      `/api/admin/contests/${contestId}/registrations`,
      ctx,
      'manager',
    );
    const row = (listed.json() as {
      data: Array<{
        userId: number;
        status: string;
        registeredAt: number | null;
        submissionCount: number;
        lastSubmissionAt: number | null;
      }>;
    }).data.find((entry) => entry.userId === ctx.users.bob);
    expect(row).toMatchObject({
      status: 'accepted',
      registeredAt: expect.any(Number),
      submissionCount: 1,
      lastSubmissionAt: 7000,
    });
  });

  it('validates and stores the registration window on create and update', async () => {
    const ctx = setup();
    const app = await buildCtxApp(ctx);

    const invalidCreate = await api(app, 'POST', '/api/admin/contests', ctx, 'admin', {
      name: 'Bad Window',
      registrationOpenAt: 2000,
      registrationCloseAt: 1000,
      problemIds: [ctx.problemId],
    });
    expect(invalidCreate.statusCode).toBe(400);
    expect(errorCode(invalidCreate.json())).toBe('INVALID_REGISTRATION_WINDOW');

    const created = await api(app, 'POST', '/api/admin/contests', ctx, 'admin', {
      name: 'Window Cup',
      registrationMode: 'open',
      registrationOpenAt: 2000,
      registrationCloseAt: 5000,
      problemIds: [ctx.problemId],
    });
    expect(created.statusCode, created.body).toBe(201);
    const contestId = (created.json() as { data: { id: number } }).data.id;
    const createdDetail = await api(app, 'GET', `/api/contests/${contestId}`, ctx, 'alice');
    expect(
      (
        createdDetail.json() as {
          data: { contest: { registration_open_at: number; registration_close_at: number } };
        }
      ).data.contest,
    ).toMatchObject({ registration_open_at: 2000, registration_close_at: 5000 });

    // Partial update must compare against the stored counterpart.
    const invalidUpdate = await api(app, 'PUT', `/api/admin/contests/${contestId}`, ctx, 'admin', {
      registrationOpenAt: 6000,
    });
    expect(invalidUpdate.statusCode).toBe(400);
    expect(errorCode(invalidUpdate.json())).toBe('INVALID_REGISTRATION_WINDOW');

    const validUpdate = await api(app, 'PUT', `/api/admin/contests/${contestId}`, ctx, 'admin', {
      registrationCloseAt: 9000,
    });
    expect(validUpdate.statusCode, validUpdate.body).toBe(200);
    const updatedDetail = await api(app, 'GET', `/api/contests/${contestId}`, ctx, 'alice');
    expect(
      (
        updatedDetail.json() as {
          data: { contest: { registration_open_at: number; registration_close_at: number } };
        }
      ).data.contest,
    ).toMatchObject({ registration_open_at: 2000, registration_close_at: 9000 });

    const cleared = await api(app, 'PUT', `/api/admin/contests/${contestId}`, ctx, 'admin', {
      registrationOpenAt: null,
      registrationCloseAt: null,
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    const clearedDetail = await api(app, 'GET', `/api/contests/${contestId}`, ctx, 'alice');
    expect(
      (
        clearedDetail.json() as {
          data: { contest: { registration_open_at: null; registration_close_at: null } };
        }
      ).data.contest,
    ).toMatchObject({ registration_open_at: null, registration_close_at: null });
  });

  it('blocks self-registration outside the registration window', async () => {
    const ctx = setup();
    const now = Date.now();
    const app = await buildCtxApp(ctx);

    const futureId = createContest(ctx.db, {
      name: 'Future Window',
      registrationMode: 'open',
      registrationOpenAt: now + 3_600_000,
      problemIds: [ctx.problemId],
    });
    const notOpen = await api(app, 'POST', `/api/contests/${futureId}/register`, ctx, 'alice');
    expect(notOpen.statusCode).toBe(403);
    expect(errorCode(notOpen.json())).toBe('REGISTRATION_NOT_OPEN');

    const pastId = createContest(ctx.db, {
      name: 'Past Window',
      registrationMode: 'open',
      registrationOpenAt: now - 7_200_000,
      registrationCloseAt: now - 3_600_000,
      problemIds: [ctx.problemId],
    });
    const closed = await api(app, 'POST', `/api/contests/${pastId}/register`, ctx, 'bob');
    expect(closed.statusCode).toBe(403);
    expect(errorCode(closed.json())).toBe('REGISTRATION_CLOSED');

    const openId = createContest(ctx.db, {
      name: 'Open Window',
      registrationMode: 'open',
      registrationOpenAt: now - 1000,
      registrationCloseAt: now + 3_600_000,
      problemIds: [ctx.problemId],
    });
    const accepted = await api(app, 'POST', `/api/contests/${openId}/register`, ctx, 'carol');
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect((accepted.json() as { data: { status: string } }).data.status).toBe('accepted');
  });

  it('lets accepted participants self-cancel before the start but not after', async () => {
    const ctx = setup();
    const now = Date.now();
    const app = await buildCtxApp(ctx);

    const upcomingId = createContest(ctx.db, {
      name: 'Upcoming Cup',
      registrationMode: 'open',
      startAt: now + 3_600_000,
      endAt: now + 7_200_000,
      problemIds: [ctx.problemId],
    });
    expect(
      (await api(app, 'POST', `/api/contests/${upcomingId}/register`, ctx, 'alice')).statusCode,
    ).toBe(200);
    const cancelled = await api(
      app,
      'DELETE',
      `/api/contests/${upcomingId}/register`,
      ctx,
      'alice',
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(
      (
        (await api(app, 'GET', `/api/contests/${upcomingId}/registration`, ctx, 'alice')).json() as {
          data: { registration: unknown };
        }
      ).data.registration,
    ).toBeNull();

    const runningId = makeRunningContest(ctx, 'open');
    expect(
      (await api(app, 'POST', `/api/contests/${runningId}/register`, ctx, 'bob')).statusCode,
    ).toBe(200);
    const cannotCancel = await api(
      app,
      'DELETE',
      `/api/contests/${runningId}/register`,
      ctx,
      'bob',
    );
    expect(cannotCancel.statusCode).toBe(409);
    expect(errorCode(cannotCancel.json())).toBe('CANNOT_CANCEL');
  });

  it('lets administrators import and review outside the registration window', async () => {
    const ctx = setup();
    const now = Date.now();
    const app = await buildCtxApp(ctx);
    const contestId = createContest(ctx.db, {
      name: 'Past Approval',
      registrationMode: 'approval',
      registrationOpenAt: now - 7_200_000,
      registrationCloseAt: now - 3_600_000,
      problemIds: [ctx.problemId],
    });
    registerForContest(ctx.db, { contestId, userId: ctx.users.alice, now: now - 5_400_000 });

    const approved = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/registrations/${ctx.users.alice}/approve`,
      ctx,
      'manager',
    );
    expect(approved.statusCode, approved.body).toBe(200);

    const imported = await api(
      app,
      'POST',
      `/api/admin/contests/${contestId}/participants`,
      ctx,
      'manager',
      { userIds: [ctx.users.bob] },
    );
    expect(imported.statusCode, imported.body).toBe(200);
    expect(getMyRegistration(ctx.db, contestId, ctx.users.bob)?.status).toBe('accepted');
    expect(getMyRegistration(ctx.db, contestId, ctx.users.alice)?.status).toBe('accepted');
  });
});
