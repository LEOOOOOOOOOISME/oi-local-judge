import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createProblem, getProblem, type ProblemRow } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  ProblemAclError,
  addProblemShare,
  canEditProblem,
  canManageProblemShares,
  canViewProblem,
  listProblemShares,
  listVisibleProblems,
  removeProblemShare,
  type ProblemActor,
} from '../src/services/problem-acl.js';
import {
  ProblemOwnerError,
  createProblemWithOwner,
  resolveProblemOwner,
  updateProblemWithOwner,
  type ProblemOwnerType,
} from '../src/services/problems.js';
import { addTeamMember, createTeam } from '../src/services/teams.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'oij-problem-acl-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
  const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
  const carol = createUser(db, { username: 'carol', passwordHash: 'x' });
  const dave = createUser(db, { username: 'dave', passwordHash: 'x' });
  const admin = createUser(db, { username: 'admin', passwordHash: 'x', role: 'admin' });
  return { db, alice, bob, carol, dave, admin };
}

function makeProblem(
  db: DatabaseSync,
  options: {
    title: string;
    visibility?: 'public' | 'hidden';
    ownerType?: ProblemOwnerType;
    ownerId?: number | null;
  },
): number {
  return createProblem(db, {
    title: options.title,
    type: 'standard',
    timeMs: 1000,
    memoryMb: 128,
    visibility: options.visibility ?? 'public',
    ownerType: options.ownerType ?? 'system',
    ownerId: options.ownerId ?? null,
    testcases: [],
  });
}

function requireProblem(db: DatabaseSync, id: number): ProblemRow {
  const row = getProblem(db, id);
  expect(row).not.toBeNull();
  return row as ProblemRow;
}

function actor(userId?: number, isAdmin = false): ProblemActor {
  return userId === undefined ? { isAdmin } : { userId, isAdmin };
}

function expectAclError(fn: () => unknown, code: string, status: number) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProblemAclError);
  const error = caught as ProblemAclError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
}

function expectOwnerError(fn: () => unknown) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProblemOwnerError);
}

describe('problem ACL service', () => {
  it('exposes system public problems to everyone and hides system hidden ones', () => {
    const { db, alice, bob, admin } = setup();
    const publicId = makeProblem(db, { title: 'Public system' });
    const hiddenId = makeProblem(db, { title: 'Hidden system', visibility: 'hidden' });
    const publicProblem = requireProblem(db, publicId);
    const hiddenProblem = requireProblem(db, hiddenId);

    expect(publicProblem.owner_type).toBe('system');
    expect(publicProblem.owner_id).toBeNull();

    expect(canViewProblem(db, publicProblem, actor())).toBe(true);
    expect(canViewProblem(db, publicProblem, actor(alice))).toBe(true);
    expect(canViewProblem(db, publicProblem, actor(bob))).toBe(true);
    expect(canEditProblem(db, publicProblem, actor(alice))).toBe(false);
    expect(canEditProblem(db, publicProblem, actor(admin, true))).toBe(true);
    expect(canManageProblemShares(db, publicProblem, actor(alice))).toBe(false);

    expect(canViewProblem(db, hiddenProblem, actor())).toBe(false);
    expect(canViewProblem(db, hiddenProblem, actor(alice))).toBe(false);
    expect(canViewProblem(db, hiddenProblem, actor(bob))).toBe(false);
    expect(canViewProblem(db, hiddenProblem, actor(admin, true))).toBe(true);
    expect(canEditProblem(db, hiddenProblem, actor(admin, true))).toBe(true);
  });

  it('lets a user own a private problem while public user problems stay readable', () => {
    const { db, alice, bob } = setup();
    const privateId = makeProblem(db, {
      title: 'Alice private',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'hidden',
    });
    const publicId = makeProblem(db, {
      title: 'Alice public',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'public',
    });
    const privateProblem = requireProblem(db, privateId);
    const publicProblem = requireProblem(db, publicId);

    expect(canViewProblem(db, privateProblem, actor(alice))).toBe(true);
    expect(canEditProblem(db, privateProblem, actor(alice))).toBe(true);
    expect(canManageProblemShares(db, privateProblem, actor(alice))).toBe(true);
    expect(canViewProblem(db, privateProblem, actor(bob))).toBe(false);
    expect(canEditProblem(db, privateProblem, actor(bob))).toBe(false);

    expect(canViewProblem(db, publicProblem, actor(bob))).toBe(true);
    expect(canViewProblem(db, publicProblem, actor())).toBe(true);
    expect(canEditProblem(db, publicProblem, actor(bob))).toBe(false);
    expect(canManageProblemShares(db, publicProblem, actor(bob))).toBe(false);
  });

  it('gives a team captain edit rights and members read-only rights', () => {
    const { db, alice, bob, carol } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    const problemId = makeProblem(db, {
      title: 'Team private',
      ownerType: 'team',
      ownerId: teamId,
      visibility: 'hidden',
    });
    const problem = requireProblem(db, problemId);

    expect(canViewProblem(db, problem, actor(alice))).toBe(true);
    expect(canEditProblem(db, problem, actor(alice))).toBe(true);
    expect(canManageProblemShares(db, problem, actor(alice))).toBe(true);

    expect(canViewProblem(db, problem, actor(bob))).toBe(true);
    expect(canEditProblem(db, problem, actor(bob))).toBe(false);
    expect(canManageProblemShares(db, problem, actor(bob))).toBe(false);

    expect(canViewProblem(db, problem, actor(carol))).toBe(false);
    expect(canEditProblem(db, problem, actor(carol))).toBe(false);
  });

  it('enforces read and edit shares', () => {
    const { db, alice, bob, dave } = setup();
    const problemId = makeProblem(db, {
      title: 'Alice private',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'hidden',
    });
    addProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: alice,
    });
    addProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: dave,
      permission: 'edit',
      actorId: alice,
    });
    const problem = requireProblem(db, problemId);

    expect(canViewProblem(db, problem, actor(bob))).toBe(true);
    expect(canEditProblem(db, problem, actor(bob))).toBe(false);
    expect(canManageProblemShares(db, problem, actor(bob))).toBe(false);

    expect(canViewProblem(db, problem, actor(dave))).toBe(true);
    expect(canEditProblem(db, problem, actor(dave))).toBe(true);
    expect(canManageProblemShares(db, problem, actor(dave))).toBe(false);

    const shares = listProblemShares(db, problemId);
    expect(shares).toHaveLength(2);
    expect(shares).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          granteeType: 'user',
          granteeId: bob,
          permission: 'read',
          createdBy: alice,
        }),
        expect.objectContaining({
          granteeType: 'user',
          granteeId: dave,
          permission: 'edit',
          createdBy: alice,
        }),
      ]),
    );
  });

  it('denies unrelated users and denies share management to edit grantees', () => {
    const { db, alice, bob, carol, dave } = setup();
    const problemId = makeProblem(db, {
      title: 'Alice private',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'hidden',
    });
    addProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: alice,
    });
    addProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: dave,
      permission: 'edit',
      actorId: alice,
    });
    const problem = requireProblem(db, problemId);

    expect(canViewProblem(db, problem, actor(carol))).toBe(false);
    expect(canEditProblem(db, problem, actor(carol))).toBe(false);
    expect(canManageProblemShares(db, problem, actor(carol))).toBe(false);

    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: carol,
          permission: 'read',
          actorId: carol,
        }),
      'PROBLEM_FORBIDDEN',
      403,
    );
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: carol,
          permission: 'edit',
          actorId: bob,
        }),
      'PROBLEM_FORBIDDEN',
      403,
    );
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: carol,
          permission: 'read',
          actorId: dave,
        }),
      'PROBLEM_FORBIDDEN',
      403,
    );
    expectAclError(
      () =>
        removeProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: bob,
          actorId: bob,
        }),
      'PROBLEM_FORBIDDEN',
      403,
    );
  });

  it('shares a problem with a whole team', () => {
    const { db, alice, bob, carol } = setup();
    const teamId = createTeam(db, { name: 'Beta', ownerId: bob });
    addTeamMember(db, { teamId, actorId: bob, username: 'alice' });
    const problemId = makeProblem(db, {
      title: 'Bob private',
      ownerType: 'user',
      ownerId: bob,
      visibility: 'hidden',
    });
    addProblemShare(db, {
      problemId,
      granteeType: 'team',
      granteeId: teamId,
      permission: 'read',
      actorId: bob,
    });
    const problem = requireProblem(db, problemId);

    expect(canViewProblem(db, problem, actor(alice))).toBe(true);
    expect(canEditProblem(db, problem, actor(alice))).toBe(false);
    expect(canViewProblem(db, problem, actor(carol))).toBe(false);

    removeProblemShare(db, {
      problemId,
      granteeType: 'team',
      granteeId: teamId,
      actorId: bob,
    });
    expect(canViewProblem(db, problem, actor(alice))).toBe(false);
  });

  it('lists each visible problem once and excludes invisible hidden problems', () => {
    const { db, alice, bob, carol, admin } = setup();
    const alpha = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId: alpha, actorId: alice, username: 'bob' });

    const personal = makeProblem(db, {
      title: 'Alice personal',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'hidden',
    });
    const teamProblem = makeProblem(db, {
      title: 'Alpha team',
      ownerType: 'team',
      ownerId: alpha,
      visibility: 'hidden',
    });
    const systemPublic = makeProblem(db, { title: 'System public' });
    const bobPublic = makeProblem(db, {
      title: 'Bob public',
      ownerType: 'user',
      ownerId: bob,
      visibility: 'public',
    });
    const sharedTwice = makeProblem(db, {
      title: 'Shared twice',
      ownerType: 'user',
      ownerId: bob,
      visibility: 'hidden',
    });
    addProblemShare(db, {
      problemId: sharedTwice,
      granteeType: 'user',
      granteeId: alice,
      permission: 'read',
      actorId: bob,
    });
    addProblemShare(db, {
      problemId: sharedTwice,
      granteeType: 'team',
      granteeId: alpha,
      permission: 'edit',
      actorId: bob,
    });
    const carolPrivate = makeProblem(db, {
      title: 'Carol private',
      ownerType: 'user',
      ownerId: carol,
      visibility: 'hidden',
    });
    const systemHidden = makeProblem(db, {
      title: 'System hidden',
      visibility: 'hidden',
    });

    const visible = listVisibleProblems(db, actor(alice));
    const ids = visible.map((problem) => problem.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort((a, b) => a - b)).toEqual(
      [personal, teamProblem, systemPublic, bobPublic, sharedTwice].sort((a, b) => a - b),
    );
    expect(ids).not.toContain(carolPrivate);
    expect(ids).not.toContain(systemHidden);

    const anonymousIds = listVisibleProblems(db, actor()).map((problem) => problem.id);
    expect(anonymousIds.sort((a, b) => a - b)).toEqual(
      [systemPublic, bobPublic].sort((a, b) => a - b),
    );

    const adminIds = listVisibleProblems(db, actor(admin, true)).map((problem) => problem.id);
    expect(adminIds).toContain(systemHidden);
    expect(adminIds).toContain(carolPrivate);
    expect(new Set(adminIds).size).toBe(adminIds.length);
  });

  it('gives admins full control and lets them manage shares', () => {
    const { db, alice, bob, admin } = setup();
    const problemId = makeProblem(db, {
      title: 'Alice private',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'hidden',
    });
    const problem = requireProblem(db, problemId);

    expect(canViewProblem(db, problem, actor(admin, true))).toBe(true);
    expect(canEditProblem(db, problem, actor(admin, true))).toBe(true);
    expect(canManageProblemShares(db, problem, actor(admin, true))).toBe(true);

    addProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: admin,
      isAdmin: true,
    });
    expect(canViewProblem(db, problem, actor(bob))).toBe(true);

    removeProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: bob,
      actorId: admin,
      isAdmin: true,
    });
    expect(canViewProblem(db, problem, actor(bob))).toBe(false);
  });

  it('validates share grantees and permissions and supports upserts', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    const problemId = makeProblem(db, {
      title: 'Alice private',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'hidden',
    });

    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'group' as 'user',
          granteeId: bob,
          permission: 'read',
          actorId: alice,
        }),
      'PROBLEM_SHARE_INVALID',
      400,
    );
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: bob,
          permission: 'owner' as 'read',
          actorId: alice,
        }),
      'PROBLEM_SHARE_INVALID',
      400,
    );
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: 999999,
          permission: 'read',
          actorId: alice,
        }),
      'PROBLEM_SHARE_INVALID',
      400,
    );
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'team',
          granteeId: 999999,
          permission: 'read',
          actorId: alice,
        }),
      'PROBLEM_SHARE_INVALID',
      400,
    );
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: alice,
          permission: 'read',
          actorId: alice,
        }),
      'PROBLEM_SHARE_INVALID',
      400,
    );
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId: 999999,
          granteeType: 'user',
          granteeId: bob,
          permission: 'read',
          actorId: alice,
        }),
      'PROBLEM_NOT_FOUND',
      404,
    );
    expectAclError(
      () =>
        removeProblemShare(db, {
          problemId,
          granteeType: 'user',
          granteeId: bob,
          actorId: alice,
        }),
      'PROBLEM_SHARE_INVALID',
      400,
    );

    addProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: alice,
    });
    addProblemShare(db, {
      problemId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'edit',
      actorId: alice,
    });
    const shares = listProblemShares(db, problemId);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({ granteeType: 'user', granteeId: bob, permission: 'edit' });
    expect(canEditProblem(db, requireProblem(db, problemId), actor(bob))).toBe(true);

    // A team cannot be shared with itself when it owns the problem.
    const teamProblemId = makeProblem(db, {
      title: 'Team private',
      ownerType: 'team',
      ownerId: teamId,
      visibility: 'hidden',
    });
    expectAclError(
      () =>
        addProblemShare(db, {
          problemId: teamProblemId,
          granteeType: 'team',
          granteeId: teamId,
          permission: 'read',
          actorId: alice,
        }),
      'PROBLEM_SHARE_INVALID',
      400,
    );
  });

  it('stores and validates ownership on create and update', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });

    const userProblemId = createProblemWithOwner(db, {
      title: 'User problem',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 128,
      ownerType: 'user',
      ownerId: alice,
      testcases: [],
    });
    expect(requireProblem(db, userProblemId).owner_type).toBe('user');
    expect(requireProblem(db, userProblemId).owner_id).toBe(alice);

    const teamProblemId = createProblemWithOwner(db, {
      title: 'Team problem',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 128,
      ownerType: 'team',
      ownerId: teamId,
      testcases: [],
    });
    expect(requireProblem(db, teamProblemId).owner_type).toBe('team');
    expect(requireProblem(db, teamProblemId).owner_id).toBe(teamId);

    // Import/seed style creation defaults to system ownership.
    const systemId = createProblem(db, {
      title: 'Imported',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 128,
      testcases: [],
    });
    expect(requireProblem(db, systemId).owner_type).toBe('system');
    expect(requireProblem(db, systemId).owner_id).toBeNull();

    expectOwnerError(() =>
      resolveProblemOwner(db, { ownerType: 'group', ownerId: alice }),
    );
    expectOwnerError(() => resolveProblemOwner(db, { ownerType: 'system', ownerId: alice }));
    expectOwnerError(() => resolveProblemOwner(db, { ownerType: 'user', ownerId: 999999 }));
    expectOwnerError(() => resolveProblemOwner(db, { ownerType: 'team', ownerId: 999999 }));
    expectOwnerError(() => resolveProblemOwner(db, { ownerType: 'user', ownerId: 1.5 }));
    expectOwnerError(() => resolveProblemOwner(db, { ownerType: 'user' }));

    expectOwnerError(() =>
      createProblemWithOwner(db, {
        title: 'Bad owner',
        type: 'standard',
        timeMs: 1000,
        memoryMb: 128,
        ownerType: 'user',
        ownerId: 999999,
        testcases: [],
      }),
    );

    expect(
      updateProblemWithOwner(db, systemId, {
        ownerType: 'user',
        ownerId: bob,
      }),
    ).toBe(true);
    expect(requireProblem(db, systemId).owner_type).toBe('user');
    expect(requireProblem(db, systemId).owner_id).toBe(bob);

    expect(
      updateProblemWithOwner(db, systemId, {
        ownerType: 'team',
        ownerId: teamId,
      }),
    ).toBe(true);
    expect(requireProblem(db, systemId).owner_type).toBe('team');
    expect(requireProblem(db, systemId).owner_id).toBe(teamId);

    expect(updateProblemWithOwner(db, systemId, { ownerType: 'system' })).toBe(true);
    expect(requireProblem(db, systemId).owner_type).toBe('system');
    expect(requireProblem(db, systemId).owner_id).toBeNull();

    expectOwnerError(() =>
      updateProblemWithOwner(db, systemId, { ownerType: 'team', ownerId: 999999 }),
    );
    expect(requireProblem(db, systemId).owner_type).toBe('system');
  });
});
