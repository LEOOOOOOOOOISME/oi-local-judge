import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';
import {
  addClassCoach,
  addClassMember,
  addTeamMember,
  createClass,
  createTeam,
} from '../src/services/teams.js';

const root = mkdtempSync(join(tmpdir(), 'oij-training-plans-http-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

type Username = 'admin' | 'manager' | 'coach' | 'alice' | 'bob' | 'carol';

const ids: Record<Username, number> = {
  admin: 0,
  manager: 0,
  coach: 0,
  alice: 0,
  bob: 0,
  carol: 0,
};
const cookies: Record<string, string> = {};
let classId = 0;
/** A team owned by a student: neither an admin nor a contest manager belongs to it. */
let foreignTeamId = 0;
/** A second team, owned by another student, used to check captains are not global. */
let otherTeamId = 0;
let p1 = 0;
let p2 = 0;
let p3 = 0;

interface ApiError {
  ok: false;
  error: { code: string; message?: string };
}

interface PlanDetailBody {
  ok: true;
  data: {
    id: number;
    groupId: number;
    groupName: string;
    groupKind: 'team' | 'class';
    title: string;
    itemCount: number;
    canManage: boolean;
    myProgress: { itemCount: number; completedCount: number };
    items: Array<{ id: number; problemId: number; ordinal: number; targetScore: number }>;
    memberProgress?: Array<{
      userId: number;
      completedCount: number;
      lateCount: number;
      items: Array<{ problemId: number; completed: boolean; late: boolean }>;
    }>;
  };
}

interface PlanListBody {
  ok: true;
  data: Array<{
    id: number;
    title: string;
    canManage: boolean;
    itemCount: number;
    myProgress: { itemCount: number; completedCount: number };
  }>;
}

interface ProgressBody {
  ok: true;
  data: {
    planId: number;
    items: Array<{ id: number; problemId: number }>;
    members: Array<{
      userId: number;
      completedCount: number;
      lateCount: number;
      items: Array<{ problemId: number; completed: boolean; late: boolean }>;
    }>;
  };
}

function seedUser(username: string, role: 'admin' | 'contestmanager' | 'contestant'): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

function makeProblem(title: string): number {
  return createProblem(db, {
    title,
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [
      { inputPath: 'data/1.in', outputPath: 'data/1.out', points: 50 },
      { inputPath: 'data/2.in', outputPath: 'data/2.out', points: 50 },
    ],
  });
}

function addSubmission(input: {
  userId: number;
  problemId: number;
  score: number;
  verdict?: string;
  createdAt: number;
  hacked?: boolean;
}): void {
  const id = createSubmission(db, {
    problemId: input.problemId,
    userId: input.userId,
    language: 'cpp17',
    sourcePath: `submissions/${input.userId}/${input.createdAt}.cpp`,
    sourceHash: 'hash',
    createdAt: input.createdAt,
    phase: 'practice',
  });
  db.prepare(
    'UPDATE submissions SET status = ?, verdict = ?, score = ?, hacked_at = ? WHERE id = ?',
  ).run(
    'finished',
    input.verdict ?? 'WA',
    input.score,
    input.hacked ? input.createdAt + 1 : null,
    id,
  );
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  ids.admin = seedUser('admin', 'admin');
  ids.manager = seedUser('manager', 'contestmanager');
  ids.coach = seedUser('coach', 'contestant');
  ids.alice = seedUser('alice', 'contestant');
  ids.bob = seedUser('bob', 'contestant');
  ids.carol = seedUser('carol', 'contestant');
  for (const [name, id] of Object.entries(ids)) {
    cookies[name] = `oij.sid=${signSession({ userId: id, version: 0 }, config.sessionSecret, 3600)}`;
  }
  classId = createClass(db, {
    name: 'HTTP Class',
    ownerId: ids.manager,
    actorRole: 'contestmanager',
  });
  addClassCoach(db, { classId, actorId: ids.manager, username: 'coach' });
  addClassMember(db, { classId, actorId: ids.manager, username: 'alice' });
  addClassMember(db, { classId, actorId: ids.manager, username: 'bob' });
  foreignTeamId = createTeam(db, { name: 'Foreign Team', ownerId: ids.alice });
  addTeamMember(db, { teamId: foreignTeamId, actorId: ids.alice, username: 'bob' });
  otherTeamId = createTeam(db, { name: 'Other Team', ownerId: ids.bob });
  p1 = makeProblem('HTTP P1');
  p2 = makeProblem('HTTP P2');
  p3 = makeProblem('HTTP P3');
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function api(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  username: string | null,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: username ? { cookie: cookies[username] } : {},
    ...(payload === undefined ? {} : { payload }),
  });
}

function errorCode(body: unknown): string {
  return (body as ApiError).error.code;
}

async function createPlanInGroup(
  username: string,
  groupId: number,
  title: string,
  items: Array<{ problemId: number; targetScore?: number; dueAt?: number }> = [],
): Promise<number> {
  const response = await api('POST', '/api/training-plans', username, {
    groupId,
    title,
    items,
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { data: { id: number } }).data.id;
}

async function createPlan(
  username: string,
  title: string,
  items: Array<{ problemId: number; targetScore?: number; dueAt?: number }> = [],
): Promise<number> {
  return createPlanInGroup(username, classId, title, items);
}

describe('training plan HTTP API', () => {
  it('requires authentication on every training plan route', async () => {
    const routes: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/training-plans'],
      ['GET', '/api/training-plans/1'],
      ['POST', '/api/training-plans', { groupId: 1, title: 'Anonymous' }],
      ['PUT', '/api/training-plans/1', { title: 'Anonymous' }],
      ['DELETE', '/api/training-plans/1'],
      ['POST', '/api/training-plans/1/items', { problemId: 1 }],
      ['DELETE', '/api/training-plans/1/items/1'],
      ['PUT', '/api/training-plans/1/items', { itemIds: [1] }],
      ['GET', '/api/training-plans/1/progress'],
    ];
    for (const [method, url, payload] of routes) {
      const response = await api(method, url, null, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(errorCode(response.json())).toBe('UNAUTHORIZED');
    }
  });

  it('lets coaches create plans and validates the request body', async () => {
    const planId = await createPlan('coach', 'Week 1', [
      { problemId: p1 },
      { problemId: p2, targetScore: 60, dueAt: 2000 },
    ]);
    expect(planId).toBeGreaterThan(0);

    const detail = await api('GET', `/api/training-plans/${planId}`, 'coach');
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as PlanDetailBody;
    expect(body.data).toMatchObject({
      id: planId,
      groupId: classId,
      groupName: 'HTTP Class',
      groupKind: 'class',
      title: 'Week 1',
      itemCount: 2,
      canManage: true,
    });
    expect(body.data.items.map((item) => [item.problemId, item.ordinal, item.targetScore])).toEqual(
      [
        [p1, 1, 100],
        [p2, 2, 60],
      ],
    );

    // The class owner may create as well; a student may not.
    const byOwner = await api('POST', '/api/training-plans', 'manager', {
      groupId: classId,
      title: 'Owner plan',
    });
    expect(byOwner.statusCode).toBe(201);
    const byStudent = await api('POST', '/api/training-plans', 'alice', {
      groupId: classId,
      title: 'Nope',
    });
    expect(byStudent.statusCode).toBe(403);
    expect(errorCode(byStudent.json())).toBe('TRAINING_PLAN_FORBIDDEN');

    const missingGroup = await api('POST', '/api/training-plans', 'coach', { title: 'No group' });
    expect(missingGroup.statusCode).toBe(400);
    expect(errorCode(missingGroup.json())).toBe('TRAINING_PLAN_GROUP_INVALID');

    const unknownGroup = await api('POST', '/api/training-plans', 'coach', {
      groupId: 999999,
      title: 'Missing',
    });
    expect(unknownGroup.statusCode).toBe(404);
    expect(errorCode(unknownGroup.json())).toBe('TRAINING_PLAN_GROUP_NOT_FOUND');

    const badItem = await api('POST', '/api/training-plans', 'coach', {
      groupId: classId,
      title: 'Bad item',
      items: [{ problemId: 999999 }],
    });
    expect(badItem.statusCode).toBe(404);
    expect(errorCode(badItem.json())).toBe('TRAINING_PLAN_ITEM_NOT_FOUND');

    const duplicate = await api('POST', '/api/training-plans', 'coach', {
      groupId: classId,
      title: 'Duplicate',
      items: [{ problemId: p1 }, { problemId: p1 }],
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('TRAINING_PLAN_ITEM_EXISTS');
  });

  it('lists plans for members and hides the roster progress from students', async () => {
    const planId = await createPlan('coach', 'Visibility', [{ problemId: p1 }]);

    const studentList = await api('GET', '/api/training-plans', 'alice');
    expect(studentList.statusCode).toBe(200);
    const studentPlans = (studentList.json() as PlanListBody).data;
    const entry = studentPlans.find((plan) => plan.id === planId);
    expect(entry).toMatchObject({
      id: planId,
      title: 'Visibility',
      canManage: false,
      itemCount: 1,
    });
    expect(entry?.myProgress.itemCount).toBe(1);

    const outsiderList = await api('GET', '/api/training-plans', 'carol');
    expect((outsiderList.json() as PlanListBody).data).toEqual([]);

    const asStudent = await api('GET', `/api/training-plans/${planId}`, 'alice');
    expect(asStudent.statusCode).toBe(200);
    expect((asStudent.json() as PlanDetailBody).data.memberProgress).toBeUndefined();

    const asCoach = await api('GET', `/api/training-plans/${planId}`, 'coach');
    expect(asCoach.statusCode).toBe(200);
    expect((asCoach.json() as PlanDetailBody).data.memberProgress).toBeDefined();

    const asAdmin = await api('GET', `/api/training-plans/${planId}`, 'admin');
    expect(asAdmin.statusCode).toBe(200);
    expect((asAdmin.json() as PlanDetailBody).data.memberProgress).toBeDefined();

    const asOutsider = await api('GET', `/api/training-plans/${planId}`, 'carol');
    expect(asOutsider.statusCode).toBe(404);
    expect(errorCode(asOutsider.json())).toBe('TRAINING_PLAN_NOT_FOUND');
  });

  it('computes progress from AC, thresholds and lateness', async () => {
    const planId = await createPlan('coach', 'Progress', [
      { problemId: p1, dueAt: 2000 },
      { problemId: p2, targetScore: 60, dueAt: 2000 },
    ]);
    addSubmission({ userId: ids.alice, problemId: p1, score: 100, verdict: 'AC', createdAt: 1000 });
    addSubmission({ userId: ids.bob, problemId: p2, score: 70, createdAt: 3000 });
    // A hacked AC must not complete the item.
    addSubmission({
      userId: ids.bob,
      problemId: p1,
      score: 100,
      verdict: 'AC',
      createdAt: 1500,
      hacked: true,
    });

    const response = await api('GET', `/api/training-plans/${planId}/progress`, 'coach');
    expect(response.statusCode).toBe(200);
    const progress = (response.json() as ProgressBody).data;
    const alice = progress.members.find((entry) => entry.userId === ids.alice)!;
    const bob = progress.members.find((entry) => entry.userId === ids.bob)!;
    expect(alice.items.find((item) => item.problemId === p1)).toMatchObject({
      completed: true,
      late: false,
    });
    expect(alice.items.find((item) => item.problemId === p2)).toMatchObject({
      completed: false,
      late: false,
    });
    expect(bob.items.find((item) => item.problemId === p1)).toMatchObject({
      completed: false,
    });
    expect(bob.items.find((item) => item.problemId === p2)).toMatchObject({
      completed: true,
      late: true,
    });
    expect(bob).toMatchObject({ completedCount: 1, lateCount: 1 });

    const student = await api('GET', `/api/training-plans/${planId}/progress`, 'alice');
    expect(student.statusCode).toBe(403);
    expect(errorCode(student.json())).toBe('TRAINING_PLAN_FORBIDDEN');

    const admin = await api('GET', `/api/training-plans/${planId}/progress`, 'admin');
    expect(admin.statusCode).toBe(200);
  });

  it('adds, reorders and removes items through the API', async () => {
    const planId = await createPlan('coach', 'Items', [{ problemId: p1 }]);

    const add = await api('POST', `/api/training-plans/${planId}/items`, 'coach', {
      problemId: p2,
      targetScore: 70,
    });
    expect(add.statusCode).toBe(201);
    const addedId = (add.json() as { data: { id: number } }).data.id;
    const duplicate = await api('POST', `/api/training-plans/${planId}/items`, 'coach', {
      problemId: p2,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('TRAINING_PLAN_ITEM_EXISTS');
    const studentAdd = await api('POST', `/api/training-plans/${planId}/items`, 'alice', {
      problemId: p3,
    });
    expect(studentAdd.statusCode).toBe(403);

    const detail = await api('GET', `/api/training-plans/${planId}`, 'coach');
    const items = (detail.json() as PlanDetailBody).data.items;
    expect(items).toHaveLength(2);
    const reorder = await api('PUT', `/api/training-plans/${planId}/items`, 'coach', {
      itemIds: [items[1].id, items[0].id],
    });
    expect(reorder.statusCode).toBe(200);
    const reordered = await api('GET', `/api/training-plans/${planId}`, 'coach');
    expect(
      (reordered.json() as PlanDetailBody).data.items.map((item) => [item.problemId, item.ordinal]),
    ).toEqual([
      [p2, 1],
      [p1, 2],
    ]);

    const studentReorder = await api('PUT', `/api/training-plans/${planId}/items`, 'alice', {
      itemIds: [items[1].id, items[0].id],
    });
    expect(studentReorder.statusCode).toBe(403);
    const invalidReorder = await api('PUT', `/api/training-plans/${planId}/items`, 'coach', {
      itemIds: [items[0].id],
    });
    expect(invalidReorder.statusCode).toBe(400);
    expect(errorCode(invalidReorder.json())).toBe('TRAINING_PLAN_ITEM_INVALID');

    const remove = await api(
      'DELETE',
      `/api/training-plans/${planId}/items/${addedId}`,
      'coach',
    );
    expect(remove.statusCode).toBe(200);
    const afterRemove = await api('GET', `/api/training-plans/${planId}`, 'coach');
    expect((afterRemove.json() as PlanDetailBody).data.items.map((item) => item.problemId)).toEqual([
      p1,
    ]);
    const removeAgain = await api(
      'DELETE',
      `/api/training-plans/${planId}/items/${addedId}`,
      'coach',
    );
    expect(removeAgain.statusCode).toBe(404);
    expect(errorCode(removeAgain.json())).toBe('TRAINING_PLAN_ITEM_NOT_FOUND');
  });

  it('updates basic fields and deletes a plan', async () => {
    const planId = await createPlan('coach', 'Editable', [{ problemId: p1 }]);

    const update = await api('PUT', `/api/training-plans/${planId}`, 'coach', {
      title: 'Renamed',
      description: 'new description',
      startsAt: 1000,
      endsAt: 5000,
    });
    expect(update.statusCode).toBe(200);
    const detail = await api('GET', `/api/training-plans/${planId}`, 'coach');
    expect((detail.json() as PlanDetailBody).data).toMatchObject({
      title: 'Renamed',
      description: 'new description',
      startsAt: 1000,
      endsAt: 5000,
    });

    const studentUpdate = await api('PUT', `/api/training-plans/${planId}`, 'alice', {
      title: 'Hacked',
    });
    expect(studentUpdate.statusCode).toBe(403);
    const studentDelete = await api('DELETE', `/api/training-plans/${planId}`, 'alice');
    expect(studentDelete.statusCode).toBe(403);

    const remove = await api('DELETE', `/api/training-plans/${planId}`, 'coach');
    expect(remove.statusCode).toBe(200);
    const gone = await api('GET', `/api/training-plans/${planId}`, 'coach');
    expect(gone.statusCode).toBe(404);
    expect(errorCode(gone.json())).toBe('TRAINING_PLAN_NOT_FOUND');
  });

  it('lets contest managers manage a plan in any group', async () => {
    const planId = await createPlanInGroup('manager', foreignTeamId, 'Manager plan', [
      { problemId: p1 },
    ]);
    const planPath = `/api/training-plans/${planId}`;

    const detail = await api('GET', planPath, 'manager');
    expect(detail.statusCode, detail.body).toBe(200);
    const detailBody = (detail.json() as PlanDetailBody).data;
    expect(detailBody).toMatchObject({
      id: planId,
      groupId: foreignTeamId,
      groupKind: 'team',
      title: 'Manager plan',
      canManage: true,
    });
    expect(detailBody.memberProgress?.map((entry) => entry.userId).sort()).toEqual(
      [ids.alice, ids.bob].sort(),
    );

    const update = await api('PUT', planPath, 'manager', {
      title: 'Manager renamed',
      description: 'managed by a contest manager',
    });
    expect(update.statusCode, update.body).toBe(200);

    const add = await api('POST', `${planPath}/items`, 'manager', { problemId: p2 });
    expect(add.statusCode, add.body).toBe(201);
    const addedId = (add.json() as { data: { id: number } }).data.id;
    const afterAdd = await api('GET', planPath, 'manager');
    const itemIds = (afterAdd.json() as PlanDetailBody).data.items.map((item) => item.id);
    expect(itemIds).toHaveLength(2);

    const reorder = await api('PUT', `${planPath}/items`, 'manager', {
      itemIds: [itemIds[1], itemIds[0]],
    });
    expect(reorder.statusCode, reorder.body).toBe(200);
    const reordered = await api('GET', planPath, 'manager');
    expect(
      (reordered.json() as PlanDetailBody).data.items.map((item) => [
        item.problemId,
        item.ordinal,
      ]),
    ).toEqual([
      [p2, 1],
      [p1, 2],
    ]);

    const progress = await api('GET', `${planPath}/progress`, 'manager');
    expect(progress.statusCode, progress.body).toBe(200);
    expect(
      (progress.json() as ProgressBody).data.members.map((entry) => entry.userId).sort(),
    ).toEqual([ids.alice, ids.bob].sort());

    // A plain member of the target group stays read-only.
    const asMember = await api('GET', planPath, 'bob');
    expect(asMember.statusCode).toBe(200);
    const memberBody = (asMember.json() as PlanDetailBody).data;
    expect(memberBody.canManage).toBe(false);
    expect(memberBody.memberProgress).toBeUndefined();
    expect((await api('PUT', planPath, 'bob', { title: 'Nope' })).statusCode).toBe(403);
    expect(
      (await api('POST', `${planPath}/items`, 'bob', { problemId: p3 })).statusCode,
    ).toBe(403);
    expect((await api('GET', `${planPath}/progress`, 'bob')).statusCode).toBe(403);
    expect((await api('DELETE', planPath, 'bob')).statusCode).toBe(403);

    const removeItem = await api('DELETE', `${planPath}/items/${addedId}`, 'manager');
    expect(removeItem.statusCode, removeItem.body).toBe(200);
    const remove = await api('DELETE', planPath, 'manager');
    expect(remove.statusCode, remove.body).toBe(200);
    const gone = await api('GET', planPath, 'manager');
    expect(gone.statusCode).toBe(404);
  });

  it('keeps ordinary coaches limited to their own groups', async () => {
    const planId = await createPlanInGroup('manager', foreignTeamId, 'Foreign plan', [
      { problemId: p1 },
    ]);
    const planPath = `/api/training-plans/${planId}`;

    const create = await api('POST', '/api/training-plans', 'coach', {
      groupId: foreignTeamId,
      title: 'Not allowed',
    });
    expect(create.statusCode).toBe(403);
    expect(errorCode(create.json())).toBe('TRAINING_PLAN_FORBIDDEN');

    // An outsider cannot even read the plan.
    expect((await api('GET', planPath, 'coach')).statusCode).toBe(404);
    expect((await api('PUT', planPath, 'coach', { title: 'Nope' })).statusCode).toBe(403);
    expect((await api('DELETE', planPath, 'coach')).statusCode).toBe(403);
    expect(
      (await api('POST', `${planPath}/items`, 'coach', { problemId: p2 })).statusCode,
    ).toBe(403);
    expect((await api('GET', `${planPath}/progress`, 'coach')).statusCode).toBe(403);

    expect((await api('DELETE', planPath, 'manager')).statusCode).toBe(200);
  });

  it('keeps team captains limited to their own groups', async () => {
    const planId = await createPlanInGroup('manager', otherTeamId, 'Other team plan', [
      { problemId: p1 },
    ]);
    const planPath = `/api/training-plans/${planId}`;

    // Alice captains the foreign team, not this one.
    expect((await api('GET', planPath, 'alice')).statusCode).toBe(404);
    expect((await api('PUT', planPath, 'alice', { title: 'Nope' })).statusCode).toBe(403);
    expect((await api('DELETE', planPath, 'alice')).statusCode).toBe(403);
    expect(
      (await api('POST', `${planPath}/items`, 'alice', { problemId: p2 })).statusCode,
    ).toBe(403);
    expect((await api('GET', `${planPath}/progress`, 'alice')).statusCode).toBe(403);

    expect((await api('DELETE', planPath, 'manager')).statusCode).toBe(200);
  });

  it('keeps admin access to any group', async () => {
    const planId = await createPlanInGroup('admin', foreignTeamId, 'Admin plan', [
      { problemId: p1 },
    ]);
    const planPath = `/api/training-plans/${planId}`;

    const detail = await api('GET', planPath, 'admin');
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as PlanDetailBody).data).toMatchObject({
      groupId: foreignTeamId,
      canManage: true,
    });
    expect((detail.json() as PlanDetailBody).data.memberProgress).toBeDefined();
    expect((await api('PUT', planPath, 'admin', { title: 'Admin renamed' })).statusCode).toBe(
      200,
    );
    expect((await api('GET', `${planPath}/progress`, 'admin')).statusCode).toBe(200);
    expect((await api('DELETE', planPath, 'admin')).statusCode).toBe(200);
  });
});
