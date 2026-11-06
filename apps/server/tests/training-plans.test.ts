import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  addClassCoach,
  addClassMember,
  addTeamMember,
  createClass,
  createTeam,
} from '../src/services/teams.js';
import {
  addTrainingPlanItem,
  createTrainingPlan,
  deleteTrainingPlan,
  getTrainingPlan,
  getTrainingPlanProgress,
  listTrainingPlans,
  removeTrainingPlanItem,
  reorderTrainingPlanItems,
  TrainingPlanError,
  updateTrainingPlan,
  type TrainingPlanDetail,
  type TrainingPlanMemberProgress,
} from '../src/services/training-plans.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed by a test
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-training-plans-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  const admin = createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' });
  const manager = createUser(db, {
    username: 'manager',
    passwordHash: 'x',
    role: 'contestmanager',
  });
  const coach = createUser(db, { username: 'coach', passwordHash: 'x' });
  const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
  const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
  const carol = createUser(db, { username: 'carol', passwordHash: 'x' });

  const classId = createClass(db, {
    name: 'Class A',
    ownerId: manager,
    actorRole: 'contestmanager',
  });
  addClassCoach(db, { classId, actorId: manager, username: 'coach' });
  addClassMember(db, { classId, actorId: manager, username: 'alice' });
  addClassMember(db, { classId, actorId: manager, username: 'bob' });

  const problems = {
    p1: makeProblem(db, 'P1', [60, 40]),
    p2: makeProblem(db, 'P2', [50, 50]),
    p3: makeProblem(db, 'P3', [100]),
  };
  return { db, admin, manager, coach, alice, bob, carol, classId, problems };
}

function makeProblem(db: DatabaseSync, title: string, points: number[]): number {
  return createProblem(db, {
    title,
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: points.map((point, index) => ({
      inputPath: `data/${index}.in`,
      outputPath: `data/${index}.out`,
      points: point,
    })),
  });
}

interface SubmissionOptions {
  userId: number;
  problemId: number;
  score: number;
  verdict?: string | null;
  createdAt: number;
  phase?: 'practice' | 'contest';
  status?: 'finished' | 'failed' | 'queued';
  hacked?: boolean;
}

function addSubmission(db: DatabaseSync, options: SubmissionOptions): number {
  const id = createSubmission(db, {
    problemId: options.problemId,
    userId: options.userId,
    language: 'cpp17',
    sourcePath: `submissions/${options.userId}/${options.createdAt}.cpp`,
    sourceHash: 'hash',
    createdAt: options.createdAt,
    phase: options.phase ?? 'practice',
  });
  db.prepare(
    `UPDATE submissions SET status = ?, verdict = ?, score = ?, hacked_at = ? WHERE id = ?`,
  ).run(
    options.status ?? 'finished',
    options.verdict ?? 'WA',
    options.score,
    options.hacked ? options.createdAt + 1 : null,
    id,
  );
  return id;
}

function createPlan(
  db: DatabaseSync,
  input: {
    groupId: number;
    actorId: number;
    title?: string;
    description?: string;
    startsAt?: number | null;
    endsAt?: number | null;
    items?: Array<{ problemId: number; targetScore?: number; dueAt?: number | null }>;
    canManageAnyGroup?: boolean;
    now?: number;
  },
): number {
  return createTrainingPlan(db, {
    groupId: input.groupId,
    title: input.title ?? 'Weekly training',
    description: input.description ?? '',
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    items: input.items ?? [],
    actorId: input.actorId,
    canManageAnyGroup: input.canManageAnyGroup ?? false,
    now: input.now,
  });
}

function expectPlanError(fn: () => unknown, code: string, status: number) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TrainingPlanError);
  const error = caught as TrainingPlanError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
}

function requireDetail(detail: TrainingPlanDetail | null): TrainingPlanDetail {
  expect(detail).not.toBeNull();
  return detail as TrainingPlanDetail;
}

function member(
  members: TrainingPlanMemberProgress[],
  userId: number,
): TrainingPlanMemberProgress {
  const found = members.find((entry) => entry.userId === userId);
  expect(found, `member ${userId}`).toBeDefined();
  return found as TrainingPlanMemberProgress;
}

describe('training plans service', () => {
  it('creates a plan whose items default to the problem full score', () => {
    const { db, coach, alice, classId, problems } = setup();
    const planId = createPlan(db, {
      groupId: classId,
      actorId: coach,
      title: '  Week 1  ',
      description: 'graphs',
      startsAt: 1000,
      endsAt: 9000,
      items: [{ problemId: problems.p1 }, { problemId: problems.p2, targetScore: 60, dueAt: 5000 }],
      now: 2000,
    });

    const detail = requireDetail(
      getTrainingPlan(db, { planId, userId: coach, canManageAnyGroup: false, now: 3000 }),
    );
    expect(detail).toMatchObject({
      id: planId,
      groupId: classId,
      groupName: 'Class A',
      groupKind: 'class',
      title: 'Week 1',
      description: 'graphs',
      startsAt: 1000,
      endsAt: 9000,
      createdBy: coach,
      createdAt: 2000,
      updatedAt: 2000,
      itemCount: 2,
      canManage: true,
      myProgress: { itemCount: 2, completedCount: 0, allCompleted: false },
    });
    expect(detail.items.map((item) => [item.problemId, item.ordinal, item.targetScore])).toEqual([
      [problems.p1, 1, 100],
      [problems.p2, 2, 60],
    ]);
    expect(detail.items[1].dueAt).toBe(5000);

    // A plain member sees the same plan but cannot manage it.
    const asMember = listTrainingPlans(db, { userId: alice, now: 3000 });
    expect(asMember).toHaveLength(1);
    expect(asMember[0]).toMatchObject({ id: planId, canManage: false, itemCount: 2 });
    expect(asMember[0].myProgress.itemCount).toBe(2);
  });

  it('enforces group ownership for create, update and delete', () => {
    const { db, admin, manager, coach, alice, carol, classId, problems } = setup();

    expectPlanError(
      () =>
        createTrainingPlan(db, {
          groupId: classId,
          title: 'Student plan',
          items: [],
          actorId: alice,
          canManageAnyGroup: false,
        }),
      'TRAINING_PLAN_FORBIDDEN',
      403,
    );
    expectPlanError(
      () =>
        createTrainingPlan(db, {
          groupId: classId,
          title: 'Outsider plan',
          items: [],
          actorId: carol,
          canManageAnyGroup: false,
        }),
      'TRAINING_PLAN_FORBIDDEN',
      403,
    );
    expectPlanError(
      () =>
        createTrainingPlan(db, {
          groupId: 999999,
          title: 'Missing group',
          items: [],
          actorId: coach,
          canManageAnyGroup: false,
        }),
      'TRAINING_PLAN_GROUP_NOT_FOUND',
      404,
    );

    const byCoach = createPlan(db, { groupId: classId, actorId: coach, items: [] });
    const byOwner = createPlan(db, { groupId: classId, actorId: manager, items: [] });
    // An administrator may manage a group they do not belong to.
    const byAdmin = createPlan(db, {
      groupId: classId,
      actorId: admin,
      items: [{ problemId: problems.p1 }],
      canManageAnyGroup: true,
    });

    expectPlanError(
      () =>
        updateTrainingPlan(db, {
          planId: byCoach,
          actorId: alice,
          canManageAnyGroup: false,
          patch: { title: 'Nope' },
        }),
      'TRAINING_PLAN_FORBIDDEN',
      403,
    );
    expectPlanError(
      () =>
        deleteTrainingPlan(db, { planId: byCoach, actorId: alice, canManageAnyGroup: false }),
      'TRAINING_PLAN_FORBIDDEN',
      403,
    );
    // An outsider cannot even read a plan.
    expect(getTrainingPlan(db, { planId: byCoach, userId: carol, canManageAnyGroup: false })).toBeNull();
    // Administrators can read any plan.
    expect(
      getTrainingPlan(db, { planId: byCoach, userId: admin, canManageAnyGroup: true })?.memberProgress,
    ).toBeDefined();

    updateTrainingPlan(db, {
      planId: byCoach,
      actorId: coach,
      canManageAnyGroup: false,
      patch: { title: 'Updated', description: 'new', startsAt: 10, endsAt: 20 },
    });
    expect(
      getTrainingPlan(db, { planId: byCoach, userId: coach, canManageAnyGroup: false })?.title,
    ).toBe('Updated');
    deleteTrainingPlan(db, { planId: byCoach, actorId: manager, canManageAnyGroup: false });
    expect(getTrainingPlan(db, { planId: byCoach, userId: coach, canManageAnyGroup: false })).toBeNull();
    expect(byOwner).toBeGreaterThan(0);
    expect(byAdmin).toBeGreaterThan(0);
  });

  it('shows plans only to members of the target group, for classes and teams', () => {
    const { db, coach, alice, bob, carol, classId, problems } = setup();
    createPlan(db, {
      groupId: classId,
      actorId: coach,
      title: 'Class plan',
      items: [{ problemId: problems.p1 }],
    });
    expect(listTrainingPlans(db, { userId: coach }).map((plan) => plan.title)).toEqual([
      'Class plan',
    ]);
    expect(listTrainingPlans(db, { userId: alice }).map((plan) => plan.title)).toEqual([
      'Class plan',
    ]);
    expect(listTrainingPlans(db, { userId: bob }).map((plan) => plan.title)).toEqual([
      'Class plan',
    ]);
    expect(listTrainingPlans(db, { userId: carol })).toEqual([]);

    // Ordinary teams are supported as training-plan targets too.
    const teamId = createTeam(db, { name: 'Team A', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    const teamPlan = createPlan(db, { groupId: teamId, actorId: alice, title: 'Team plan' });
    const teamDetail = requireDetail(
      getTrainingPlan(db, { planId: teamPlan, userId: bob, canManageAnyGroup: false }),
    );
    expect(teamDetail).toMatchObject({ groupId: teamId, groupKind: 'team', canManage: false });
    expect(listTrainingPlans(db, { userId: bob }).map((plan) => plan.title).sort()).toEqual([
      'Class plan',
      'Team plan',
    ]);
    expect(listTrainingPlans(db, { userId: carol })).toEqual([]);
  });

  it('lists every plan for platform managers and only joined groups otherwise', () => {
    const { db, admin, manager, coach, alice, carol, classId } = setup();
    const classPlan = createPlan(db, {
      groupId: classId,
      actorId: coach,
      title: 'Class plan',
    });
    // A team that neither the admin nor the contest manager belongs to.
    const teamId = createTeam(db, { name: 'Team A', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    const teamPlan = createPlan(db, { groupId: teamId, actorId: alice, title: 'Team plan' });

    const asAdmin = listTrainingPlans(db, { userId: admin, canManageAnyGroup: true });
    expect(asAdmin.map((plan) => plan.id).sort()).toEqual([classPlan, teamPlan].sort());
    expect(asAdmin.every((plan) => plan.canManage)).toBe(true);
    const adminTeamPlan = asAdmin.find((plan) => plan.id === teamPlan)!;
    expect(adminTeamPlan).toMatchObject({
      groupId: teamId,
      groupName: 'Team A',
      groupKind: 'team',
      memberCount: 2,
      canManage: true,
    });
    expect(asAdmin.find((plan) => plan.id === classPlan)).toMatchObject({
      groupName: 'Class A',
      groupKind: 'class',
      memberCount: 4,
    });
    // The detail DTO carries the same group metadata.
    expect(
      getTrainingPlan(db, { planId: teamPlan, userId: admin, canManageAnyGroup: true }),
    ).toMatchObject({ groupName: 'Team A', groupKind: 'team', memberCount: 2 });

    const asManager = listTrainingPlans(db, { userId: manager, canManageAnyGroup: true });
    expect(asManager.map((plan) => plan.id).sort()).toEqual([classPlan, teamPlan].sort());
    expect(asManager.find((plan) => plan.id === teamPlan)?.canManage).toBe(true);

    // An explicit mine scope restricts a manager to the groups they belong to.
    expect(
      listTrainingPlans(db, { userId: manager, canManageAnyGroup: true, scope: 'mine' }).map(
        (plan) => plan.id,
      ),
    ).toEqual([classPlan]);
    expect(
      listTrainingPlans(db, { userId: admin, canManageAnyGroup: true, scope: 'mine' }),
    ).toEqual([]);

    // Ordinary users keep the "groups I joined" list and cannot request all.
    expect(
      listTrainingPlans(db, { userId: alice })
        .map((plan) => plan.id)
        .sort(),
    ).toEqual([classPlan, teamPlan].sort());
    expect(listTrainingPlans(db, { userId: carol })).toEqual([]);
    expectPlanError(
      () => listTrainingPlans(db, { userId: alice, scope: 'all' }),
      'TRAINING_PLAN_SCOPE_FORBIDDEN',
      403,
    );
  });

  it('returns an empty list for managers when no plan exists', () => {
    const { db, admin, manager } = setup();
    expect(listTrainingPlans(db, { userId: admin, canManageAnyGroup: true })).toEqual([]);
    expect(listTrainingPlans(db, { userId: manager, canManageAnyGroup: true })).toEqual([]);
    expect(
      listTrainingPlans(db, { userId: admin, canManageAnyGroup: true, scope: 'mine' }),
    ).toEqual([]);
  });

  it('computes AC progress and ignores unfinished or hacked submissions', () => {
    const { db, coach, alice, bob, classId, problems } = setup();
    const planId = createPlan(db, {
      groupId: classId,
      actorId: coach,
      items: [{ problemId: problems.p1 }],
    });

    addSubmission(db, {
      userId: alice,
      problemId: problems.p1,
      score: 50,
      createdAt: 1000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problems.p1,
      score: 100,
      verdict: 'AC',
      createdAt: 2000,
    });
    // Unfinished and failed submissions never contribute.
    addSubmission(db, {
      userId: alice,
      problemId: problems.p1,
      score: 100,
      verdict: 'AC',
      status: 'queued',
      createdAt: 3000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problems.p1,
      score: 100,
      verdict: 'AC',
      status: 'failed',
      createdAt: 3500,
    });
    // A contest-phase submission does count.
    addSubmission(db, {
      userId: bob,
      problemId: problems.p1,
      score: 40,
      createdAt: 1200,
    });
    addSubmission(db, {
      userId: bob,
      problemId: problems.p1,
      score: 100,
      verdict: 'AC',
      phase: 'contest',
      createdAt: 1500,
      hacked: true,
    });

    const progress = getTrainingPlanProgress(db, {
      planId,
      actorId: coach,
      canManageAnyGroup: false,
      now: 5000,
    });
    const aliceProgress = member(progress.members, alice);
    expect(aliceProgress.items[0]).toMatchObject({
      bestScore: 100,
      accepted: true,
      completed: true,
      completedAt: 2000,
      late: false,
      status: 'completed',
    });
    expect(aliceProgress).toMatchObject({ completedCount: 1, allCompleted: true });

    const bobProgress = member(progress.members, bob);
    expect(bobProgress.items[0]).toMatchObject({
      bestScore: 40,
      accepted: false,
      completed: false,
      completedAt: null,
      status: 'pending',
    });
    expect(bobProgress).toMatchObject({ completedCount: 0, allCompleted: false });

    // The detail exposes my own item progress; students do not get the roster.
    const detail = requireDetail(
      getTrainingPlan(db, { planId, userId: alice, canManageAnyGroup: false, now: 5000 }),
    );
    expect(detail.myItems[0]).toMatchObject({ accepted: true, completed: true });
    expect(detail.memberProgress).toBeUndefined();

    // Only managers and administrators may read the whole progress table.
    expectPlanError(
      () => getTrainingPlanProgress(db, { planId, actorId: alice, canManageAnyGroup: false }),
      'TRAINING_PLAN_FORBIDDEN',
      403,
    );
  });

  it('completes an item by reaching the score threshold without AC', () => {
    const { db, coach, alice, classId, problems } = setup();
    const planId = createPlan(db, {
      groupId: classId,
      actorId: coach,
      items: [
        { problemId: problems.p2, targetScore: 60 },
        { problemId: problems.p3 },
      ],
    });
    addSubmission(db, {
      userId: alice,
      problemId: problems.p2,
      score: 55,
      createdAt: 1000,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problems.p2,
      score: 70,
      createdAt: 2000,
    });
    // A full-score item is not complete at 99 points.
    addSubmission(db, {
      userId: alice,
      problemId: problems.p3,
      score: 99,
      createdAt: 2500,
    });

    const detail = requireDetail(
      getTrainingPlan(db, { planId, userId: alice, canManageAnyGroup: false, now: 3000 }),
    );
    expect(detail.myItems[0]).toMatchObject({
      targetScore: 60,
      bestScore: 70,
      accepted: false,
      completed: true,
      completedAt: 2000,
      late: false,
    });
    expect(detail.myItems[1]).toMatchObject({
      targetScore: 100,
      bestScore: 99,
      completed: false,
      status: 'pending',
    });
    expect(detail.myProgress).toMatchObject({ itemCount: 2, completedCount: 1 });
  });

  it('marks late completions as completed but late, and unfinished due items as overdue', () => {
    const { db, coach, alice, bob, classId, problems } = setup();
    const planId = createPlan(db, {
      groupId: classId,
      actorId: coach,
      items: [
        { problemId: problems.p1, dueAt: 2000 },
        { problemId: problems.p2, targetScore: 60, dueAt: 2000 },
        { problemId: problems.p3, dueAt: 2000 },
      ],
    });
    // Alice completes p1 before the deadline and p2 after it; she never touches p3.
    addSubmission(db, {
      userId: alice,
      problemId: problems.p1,
      score: 100,
      verdict: 'AC',
      createdAt: 1500,
    });
    addSubmission(db, {
      userId: alice,
      problemId: problems.p2,
      score: 60,
      createdAt: 3000,
    });

    const progress = getTrainingPlanProgress(db, {
      planId,
      actorId: coach,
      canManageAnyGroup: false,
      now: 5000,
    });
    const aliceProgress = member(progress.members, alice);
    expect(aliceProgress.items[0]).toMatchObject({
      completed: true,
      completedAt: 1500,
      late: false,
      status: 'completed',
    });
    expect(aliceProgress.items[1]).toMatchObject({
      completed: true,
      completedAt: 3000,
      late: true,
      status: 'completed',
    });
    expect(aliceProgress.items[2]).toMatchObject({
      completed: false,
      late: false,
      status: 'overdue',
    });
    expect(aliceProgress).toMatchObject({
      completedCount: 2,
      lateCount: 1,
      overdueCount: 1,
      allCompleted: false,
    });

    // Bob has no submissions at all: everything is overdue once due.
    expect(member(progress.members, bob).overdueCount).toBe(3);
    // Before the due date the same items are merely pending.
    const early = getTrainingPlanProgress(db, {
      planId,
      actorId: coach,
      canManageAnyGroup: false,
      now: 1000,
    });
    expect(member(early.members, bob).items.every((item) => item.status === 'pending')).toBe(true);
  });

  it('adds, removes and reorders items, renumbering ordinals', () => {
    const { db, coach, alice, classId, problems } = setup();
    const planId = createPlan(db, {
      groupId: classId,
      actorId: coach,
      items: [{ problemId: problems.p1 }],
    });

    const second = addTrainingPlanItem(db, {
      planId,
      actorId: coach,
      canManageAnyGroup: false,
      problemId: problems.p2,
      targetScore: 70,
      dueAt: 8000,
      now: 900,
    });
    const third = addTrainingPlanItem(db, {
      planId,
      actorId: coach,
      canManageAnyGroup: false,
      problemId: problems.p3,
    });
    expectPlanError(
      () =>
        addTrainingPlanItem(db, {
          planId,
          actorId: coach,
          canManageAnyGroup: false,
          problemId: problems.p1,
        }),
      'TRAINING_PLAN_ITEM_EXISTS',
      409,
    );
    expectPlanError(
      () =>
        addTrainingPlanItem(db, {
          planId,
          actorId: alice,
          canManageAnyGroup: false,
          problemId: problems.p1,
        }),
      'TRAINING_PLAN_FORBIDDEN',
      403,
    );

    let detail = requireDetail(
      getTrainingPlan(db, { planId, userId: coach, canManageAnyGroup: false }),
    );
    expect(detail.items.map((item) => [item.problemId, item.ordinal])).toEqual([
      [problems.p1, 1],
      [problems.p2, 2],
      [problems.p3, 3],
    ]);
    expect(detail.items[1]).toMatchObject({ targetScore: 70, dueAt: 8000 });

    // Reorder to P3, P1, P2.
    const itemIds = detail.items.map((item) => item.id);
    reorderTrainingPlanItems(db, {
      planId,
      itemIds: [itemIds[2], itemIds[0], itemIds[1]],
      actorId: coach,
      canManageAnyGroup: false,
    });
    detail = requireDetail(getTrainingPlan(db, { planId, userId: coach, canManageAnyGroup: false }));
    expect(detail.items.map((item) => [item.problemId, item.ordinal])).toEqual([
      [problems.p3, 1],
      [problems.p1, 2],
      [problems.p2, 3],
    ]);

    expectPlanError(
      () =>
        reorderTrainingPlanItems(db, {
          planId,
          itemIds: [itemIds[0], itemIds[1]],
          actorId: coach,
          canManageAnyGroup: false,
        }),
      'TRAINING_PLAN_ITEM_INVALID',
      400,
    );
    expectPlanError(
      () =>
        reorderTrainingPlanItems(db, {
          planId,
          itemIds: [itemIds[0], itemIds[0], itemIds[1]],
          actorId: coach,
          canManageAnyGroup: false,
        }),
      'TRAINING_PLAN_ITEM_INVALID',
      400,
    );
    expectPlanError(
      () =>
        reorderTrainingPlanItems(db, {
          planId,
          itemIds: [itemIds[0], itemIds[1], 999999],
          actorId: coach,
          canManageAnyGroup: false,
        }),
      'TRAINING_PLAN_ITEM_NOT_FOUND',
      404,
    );

    // Removing the first item (P3 in the reordered list) compacts the rest to 1..n.
    removeTrainingPlanItem(db, {
      planId,
      itemId: itemIds[2],
      actorId: coach,
      canManageAnyGroup: false,
    });
    detail = requireDetail(getTrainingPlan(db, { planId, userId: coach, canManageAnyGroup: false }));
    expect(detail.items.map((item) => [item.problemId, item.ordinal])).toEqual([
      [problems.p1, 1],
      [problems.p2, 2],
    ]);
    expectPlanError(
      () =>
        removeTrainingPlanItem(db, {
          planId,
          itemId: 999999,
          actorId: coach,
          canManageAnyGroup: false,
        }),
      'TRAINING_PLAN_ITEM_NOT_FOUND',
      404,
    );

    // Re-adding a previously removed problem is allowed.
    const readded = addTrainingPlanItem(db, {
      planId,
      actorId: coach,
      canManageAnyGroup: false,
      problemId: problems.p3,
    });
    expect(readded).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
    expect(third).toBeGreaterThan(0);
  });

  it('deletes a plan together with its items and progress', () => {
    const { db, coach, alice, classId, problems } = setup();
    const planId = createPlan(db, {
      groupId: classId,
      actorId: coach,
      items: [{ problemId: problems.p1 }, { problemId: problems.p2 }],
    });
    deleteTrainingPlan(db, { planId, actorId: coach, canManageAnyGroup: false });

    expect(getTrainingPlan(db, { planId, userId: coach, canManageAnyGroup: false })).toBeNull();
    expect(listTrainingPlans(db, { userId: alice })).toEqual([]);
    expectPlanError(
      () => getTrainingPlanProgress(db, { planId, actorId: coach, canManageAnyGroup: false }),
      'TRAINING_PLAN_NOT_FOUND',
      404,
    );

    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM training_plan_items WHERE plan_id = ?')
      .get(planId) as { n: number };
    expect(Number(remaining.n)).toBe(0);
  });

  it('validates plan fields, windows and item thresholds', () => {
    const { db, coach, classId, problems } = setup();
    expectPlanError(
      () => createPlan(db, { groupId: classId, actorId: coach, title: '   ' }),
      'TRAINING_PLAN_TITLE_INVALID',
      400,
    );
    expectPlanError(
      () =>
        createPlan(db, {
          groupId: classId,
          actorId: coach,
          startsAt: 2000,
          endsAt: 1000,
        }),
      'TRAINING_PLAN_TIME_INVALID',
      400,
    );
    expectPlanError(
      () =>
        createPlan(db, {
          groupId: classId,
          actorId: coach,
          items: [{ problemId: 999999 }],
        }),
      'TRAINING_PLAN_ITEM_NOT_FOUND',
      404,
    );
    expectPlanError(
      () =>
        createPlan(db, {
          groupId: classId,
          actorId: coach,
          items: [{ problemId: problems.p1 }, { problemId: problems.p1 }],
        }),
      'TRAINING_PLAN_ITEM_EXISTS',
      409,
    );
    expectPlanError(
      () =>
        createPlan(db, {
          groupId: classId,
          actorId: coach,
          items: [{ problemId: problems.p1, targetScore: -1 }],
        }),
      'TRAINING_PLAN_ITEM_INVALID',
      400,
    );

    const planId = createPlan(db, {
      groupId: classId,
      actorId: coach,
      startsAt: 1000,
      endsAt: 5000,
    });
    expectPlanError(
      () =>
        updateTrainingPlan(db, {
          planId,
          actorId: coach,
          canManageAnyGroup: false,
          patch: { startsAt: 9000 },
        }),
      'TRAINING_PLAN_TIME_INVALID',
      400,
    );
    updateTrainingPlan(db, {
      planId,
      actorId: coach,
      canManageAnyGroup: false,
      patch: { endsAt: null },
    });
    expect(
      getTrainingPlan(db, { planId, userId: coach, canManageAnyGroup: false })?.endsAt,
    ).toBeNull();
  });
});
