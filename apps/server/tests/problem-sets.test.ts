import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createProblem, getProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  ProblemSetError,
  addProblemSetItem,
  addProblemSetShare,
  createProblemSet,
  deleteProblemSet,
  getProblemSet,
  listProblemSets,
  removeProblemSetItem,
  removeProblemSetShare,
  reorderProblemSetItems,
  updateProblemSet,
  type ProblemSetDetail,
} from '../src/services/problem-sets.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'oij-problem-sets-'));
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
  title: string,
  visibility: 'public' | 'hidden' = 'public',
): number {
  return createProblem(db, {
    title,
    type: 'standard',
    difficulty: 2,
    tags: ['graphs'],
    timeMs: 1000,
    memoryMb: 128,
    visibility,
    testcases: [],
  });
}

function createPersonalSet(
  db: DatabaseSync,
  ownerId: number,
  overrides: Partial<{
    title: string;
    description: string;
    visibility: 'private' | 'public';
    now: number;
  }> = {},
): number {
  return createProblemSet(db, {
    title: overrides.title ?? 'My set',
    description: overrides.description ?? '',
    ownerType: 'user',
    ownerId,
    visibility: overrides.visibility ?? 'private',
    actorId: ownerId,
    now: overrides.now,
  });
}

function expectSetError(fn: () => unknown, code: string, status: number) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ProblemSetError);
  const error = caught as ProblemSetError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
}

function requireDetail(detail: ProblemSetDetail | null): ProblemSetDetail {
  expect(detail).not.toBeNull();
  return detail as ProblemSetDetail;
}

describe('problem sets service', () => {
  it('creates a personal set with a trimmed title and optional fields', () => {
    const { db, alice } = setup();
    const setId = createProblemSet(db, {
      title: '  My first set  ',
      description: 'graphs practice',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'private',
      actorId: alice,
      now: 1000,
    });

    const detail = requireDetail(getProblemSet(db, setId, alice, false));
    expect(detail).toMatchObject({
      id: setId,
      title: 'My first set',
      description: 'graphs practice',
      ownerType: 'user',
      ownerId: alice,
      visibility: 'private',
      createdBy: alice,
      createdAt: 1000,
      updatedAt: 1000,
      itemCount: 0,
      canEdit: true,
      canManage: true,
    });
    expect(detail.items).toEqual([]);
    expect(detail.shares).toEqual([]);
  });

  it('rejects invalid titles, owners and visibility', () => {
    const { db, alice, bob } = setup();

    for (const title of ['', '   ', 'x'.repeat(101)]) {
      expectSetError(
        () =>
          createProblemSet(db, {
            title,
            ownerType: 'user',
            ownerId: alice,
            actorId: alice,
          }),
        'SET_TITLE_INVALID',
        400,
      );
    }

    expectSetError(
      () =>
        createProblemSet(db, {
          title: 'Bad owner type',
          ownerType: 'group' as 'user',
          ownerId: alice,
          actorId: alice,
        }),
      'SET_OWNER_INVALID',
      400,
    );
    expectSetError(
      () =>
        createProblemSet(db, {
          title: 'Bad visibility',
          ownerType: 'user',
          ownerId: alice,
          actorId: alice,
          visibility: 'shared' as 'private',
        }),
      'SET_VISIBILITY_INVALID',
      400,
    );
    expectSetError(
      () =>
        createProblemSet(db, {
          title: 'Ghost owner',
          ownerType: 'user',
          ownerId: 999999,
          actorId: alice,
        }),
      'SET_OWNER_INVALID',
      400,
    );
    expectSetError(
      () =>
        createProblemSet(db, {
          title: 'Someone else',
          ownerType: 'user',
          ownerId: bob,
          actorId: alice,
        }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () =>
        createProblemSet(db, {
          title: 'Ghost team',
          ownerType: 'team',
          ownerId: 999999,
          actorId: alice,
        }),
      'SET_OWNER_INVALID',
      400,
    );
  });

  it('keeps a private set hidden from strangers', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice, { now: 1000 });

    expect(getProblemSet(db, setId, alice, false)).not.toBeNull();
    expect(getProblemSet(db, setId, bob, false)).toBeNull();
    expect(listProblemSets(db, { userId: alice }).map((set) => set.id)).toEqual([setId]);
    expect(listProblemSets(db, { userId: bob })).toEqual([]);
    expect(listProblemSets(db, { userId: 999999 })).toEqual([]);
  });

  it('exposes public sets to every user as read-only', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice, { visibility: 'public', now: 1000 });

    const detail = requireDetail(getProblemSet(db, setId, bob, false));
    expect(detail.canEdit).toBe(false);
    expect(detail.canManage).toBe(false);
    expect(detail.shares).toEqual([]);

    expect(listProblemSets(db, { userId: bob }).map((set) => set.id)).toEqual([setId]);
    expect(listProblemSets(db, { userId: bob, includePublic: false })).toEqual([]);

    expectSetError(
      () => updateProblemSet(db, { setId, actorId: bob, isAdmin: false, patch: { title: 'x' } }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () => deleteProblemSet(db, { setId, actorId: bob, isAdmin: false }),
      'SET_FORBIDDEN',
      403,
    );
  });

  it('updates and deletes a personal set for its owner', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice, { now: 1000 });

    updateProblemSet(db, {
      setId,
      actorId: alice,
      isAdmin: false,
      patch: { title: '  Renamed  ', description: 'new description', visibility: 'public' },
    });
    const detail = requireDetail(getProblemSet(db, setId, alice, false));
    expect(detail.title).toBe('Renamed');
    expect(detail.description).toBe('new description');
    expect(detail.visibility).toBe('public');
    expect(detail.updatedAt).toBeGreaterThanOrEqual(1000);

    deleteProblemSet(db, { setId, actorId: alice, isAdmin: false });
    expect(getProblemSet(db, setId, alice, false)).toBeNull();
    expect(getProblemSet(db, setId, bob, false)).toBeNull();
    expect(listProblemSets(db, { userId: alice })).toEqual([]);

    expectSetError(
      () => updateProblemSet(db, { setId, actorId: alice, isAdmin: false, patch: { title: 'x' } }),
      'SET_NOT_FOUND',
      404,
    );
    expectSetError(
      () => deleteProblemSet(db, { setId, actorId: alice, isAdmin: false }),
      'SET_NOT_FOUND',
      404,
    );
  });

  it('grants read-only access to a directly shared user', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice);
    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: alice,
      isAdmin: false,
    });

    const detail = requireDetail(getProblemSet(db, setId, bob, false));
    expect(detail.canEdit).toBe(false);
    expect(detail.canManage).toBe(false);
    expect(detail.shares).toEqual([]);
    expect(listProblemSets(db, { userId: bob }).map((set) => set.id)).toEqual([setId]);

    expectSetError(
      () => updateProblemSet(db, { setId, actorId: bob, isAdmin: false, patch: { title: 'x' } }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () =>
        addProblemSetItem(db, {
          setId,
          problemId: makeProblem(db, 'P'),
          actorId: bob,
          isAdmin: false,
        }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () => deleteProblemSet(db, { setId, actorId: bob, isAdmin: false }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'user',
          granteeId: 999999,
          permission: 'read',
          actorId: bob,
          isAdmin: false,
        }),
      'SET_FORBIDDEN',
      403,
    );
  });

  it('lets an edit share change content and order but not delete or share', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice);
    const first = makeProblem(db, 'First');
    const second = makeProblem(db, 'Second');
    addProblemSetItem(db, { setId, problemId: first, actorId: alice, isAdmin: false });
    addProblemSetItem(db, { setId, problemId: second, actorId: alice, isAdmin: false });
    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'edit',
      actorId: alice,
      isAdmin: false,
    });

    updateProblemSet(db, {
      setId,
      actorId: bob,
      isAdmin: false,
      patch: { title: 'Edited by bob', description: 'ok' },
    });
    const third = makeProblem(db, 'Third');
    addProblemSetItem(db, { setId, problemId: third, actorId: bob, isAdmin: false });
    reorderProblemSetItems(db, {
      setId,
      problemIds: [third, first, second],
      actorId: bob,
      isAdmin: false,
    });
    removeProblemSetItem(db, { setId, problemId: second, actorId: bob, isAdmin: false });

    const detail = requireDetail(getProblemSet(db, setId, bob, false));
    expect(detail.title).toBe('Edited by bob');
    expect(detail.items.map((item) => item.problemId)).toEqual([third, first]);
    expect(detail.items.map((item) => item.ordinal)).toEqual([1, 2]);
    expect(detail.canEdit).toBe(true);
    expect(detail.canManage).toBe(false);
    expect(detail.shares).toEqual([]);

    expectSetError(
      () =>
        updateProblemSet(db, {
          setId,
          actorId: bob,
          isAdmin: false,
          patch: { visibility: 'public' },
        }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () => deleteProblemSet(db, { setId, actorId: bob, isAdmin: false }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'user',
          granteeId: 999999,
          permission: 'read',
          actorId: bob,
          isAdmin: false,
        }),
      'SET_FORBIDDEN',
      403,
    );

    removeProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      actorId: alice,
      isAdmin: false,
    });
    expect(getProblemSet(db, setId, bob, false)).toBeNull();
    expect(listProblemSets(db, { userId: bob })).toEqual([]);
  });

  it('updates an existing share permission instead of duplicating it', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice);
    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: alice,
      isAdmin: false,
    });
    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'edit',
      actorId: alice,
      isAdmin: false,
    });

    const ownerView = requireDetail(getProblemSet(db, setId, alice, false));
    expect(ownerView.shares).toHaveLength(1);
    expect(ownerView.shares[0]).toMatchObject({
      granteeType: 'user',
      granteeId: bob,
      permission: 'edit',
      createdBy: alice,
    });
    expect(requireDetail(getProblemSet(db, setId, bob, false)).canEdit).toBe(true);
  });

  it('validates share grantees and permissions', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    const setId = createPersonalSet(db, alice);

    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'group' as 'user',
          granteeId: bob,
          permission: 'read',
          actorId: alice,
          isAdmin: false,
        }),
      'SET_SHARE_INVALID',
      400,
    );
    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'user',
          granteeId: bob,
          permission: 'owner' as 'read',
          actorId: alice,
          isAdmin: false,
        }),
      'SET_SHARE_INVALID',
      400,
    );
    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'user',
          granteeId: 999999,
          permission: 'read',
          actorId: alice,
          isAdmin: false,
        }),
      'SET_SHARE_INVALID',
      400,
    );
    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'team',
          granteeId: 999999,
          permission: 'read',
          actorId: alice,
          isAdmin: false,
        }),
      'SET_SHARE_INVALID',
      400,
    );
    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'user',
          granteeId: alice,
          permission: 'read',
          actorId: alice,
          isAdmin: false,
        }),
      'SET_SHARE_INVALID',
      400,
    );
    const teamSet = createProblemSet(db, {
      title: 'Team set',
      ownerType: 'team',
      ownerId: teamId,
      actorId: alice,
    });
    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId: teamSet,
          granteeType: 'team',
          granteeId: teamId,
          permission: 'read',
          actorId: alice,
          isAdmin: false,
        }),
      'SET_SHARE_INVALID',
      400,
    );
    expectSetError(
      () =>
        removeProblemSetShare(db, {
          setId,
          granteeType: 'user',
          granteeId: bob,
          actorId: alice,
          isAdmin: false,
        }),
      'SET_SHARE_INVALID',
      400,
    );
  });

  it('shares a set with a team so every member can read it', () => {
    const { db, alice, bob, carol, dave } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    const setId = createPersonalSet(db, bob);
    addProblemSetShare(db, {
      setId,
      granteeType: 'team',
      granteeId: teamId,
      permission: 'read',
      actorId: bob,
      isAdmin: false,
    });

    expect(requireDetail(getProblemSet(db, setId, alice, false)).canEdit).toBe(false);
    expect(getProblemSet(db, setId, carol, false)).toBeNull();
    expect(getProblemSet(db, setId, dave, false)).toBeNull();
    expect(listProblemSets(db, { userId: alice }).map((set) => set.id)).toEqual([setId]);
    expect(listProblemSets(db, { userId: dave })).toEqual([]);

    removeProblemSetShare(db, {
      setId,
      granteeType: 'team',
      granteeId: teamId,
      actorId: bob,
      isAdmin: false,
    });
    expect(getProblemSet(db, setId, alice, false)).toBeNull();
  });

  it('lets a team captain manage a team set while members only read it', () => {
    const { db, alice, bob, carol } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    const setId = createProblemSet(db, {
      title: 'Team set',
      ownerType: 'team',
      ownerId: teamId,
      visibility: 'private',
      actorId: alice,
      now: 2000,
    });
    const problemId = makeProblem(db, 'P');
    addProblemSetItem(db, { setId, problemId, actorId: alice, isAdmin: false });

    const captainView = requireDetail(getProblemSet(db, setId, alice, false));
    expect(captainView.canEdit).toBe(true);
    expect(captainView.canManage).toBe(true);

    const memberView = requireDetail(getProblemSet(db, setId, bob, false));
    expect(memberView.canEdit).toBe(false);
    expect(memberView.canManage).toBe(false);
    expect(memberView.shares).toEqual([]);

    expect(listProblemSets(db, { userId: bob }).map((set) => set.id)).toEqual([setId]);
    expect(getProblemSet(db, setId, carol, false)).toBeNull();

    expectSetError(
      () => updateProblemSet(db, { setId, actorId: bob, isAdmin: false, patch: { title: 'x' } }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () =>
        addProblemSetItem(db, {
          setId,
          problemId: makeProblem(db, 'P2'),
          actorId: bob,
          isAdmin: false,
        }),
      'SET_FORBIDDEN',
      403,
    );
    expectSetError(
      () => deleteProblemSet(db, { setId, actorId: bob, isAdmin: false }),
      'SET_FORBIDDEN',
      403,
    );

    updateProblemSet(db, {
      setId,
      actorId: alice,
      isAdmin: false,
      patch: { title: 'Captain renamed' },
    });
    expect(getProblemSet(db, setId, alice, false)?.title).toBe('Captain renamed');
  });

  it('rejects creating a team set as a regular member', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });

    expectSetError(
      () =>
        createProblemSet(db, {
          title: 'Bob team set',
          ownerType: 'team',
          ownerId: teamId,
          actorId: bob,
        }),
      'SET_FORBIDDEN',
      403,
    );
  });

  it('lets a team captain share and delete a team set', () => {
    const { db, alice, bob, dave } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    const setId = createProblemSet(db, {
      title: 'Team set',
      ownerType: 'team',
      ownerId: teamId,
      actorId: alice,
    });

    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: dave,
      permission: 'read',
      actorId: alice,
      isAdmin: false,
    });
    expect(getProblemSet(db, setId, dave, false)).not.toBeNull();

    expectSetError(
      () =>
        addProblemSetShare(db, {
          setId,
          granteeType: 'user',
          granteeId: dave,
          permission: 'edit',
          actorId: bob,
          isAdmin: false,
        }),
      'SET_FORBIDDEN',
      403,
    );

    deleteProblemSet(db, { setId, actorId: alice, isAdmin: false });
    expect(getProblemSet(db, setId, alice, false)).toBeNull();
    expect(getProblemSet(db, setId, dave, false)).toBeNull();
  });

  it('adds items in order and rejects duplicate or missing problems', () => {
    const { db, alice } = setup();
    const setId = createPersonalSet(db, alice);
    const first = makeProblem(db, 'First');
    const second = makeProblem(db, 'Second');

    addProblemSetItem(db, { setId, problemId: first, actorId: alice, isAdmin: false, now: 3000 });
    addProblemSetItem(db, { setId, problemId: second, actorId: alice, isAdmin: false, now: 3001 });

    const detail = requireDetail(getProblemSet(db, setId, alice, false));
    expect(detail.items.map((item) => ({ id: item.problemId, ordinal: item.ordinal }))).toEqual([
      { id: first, ordinal: 1 },
      { id: second, ordinal: 2 },
    ]);
    expect(detail.items[0]).toMatchObject({
      title: 'First',
      type: 'standard',
      difficulty: 2,
      tags: ['graphs'],
      timeMs: 1000,
      memoryMb: 128,
      addedAt: 3000,
    });
    expect(detail.itemCount).toBe(2);

    expectSetError(
      () => addProblemSetItem(db, { setId, problemId: first, actorId: alice, isAdmin: false }),
      'SET_ITEM_EXISTS',
      409,
    );
    expectSetError(
      () => addProblemSetItem(db, { setId, problemId: 999999, actorId: alice, isAdmin: false }),
      'SET_ITEM_NOT_FOUND',
      404,
    );
    expectSetError(
      () => addProblemSetItem(db, { setId: 999999, problemId: first, actorId: alice, isAdmin: false }),
      'SET_NOT_FOUND',
      404,
    );
  });

  it('reorders and removes items while keeping ordinals compact', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice);
    const first = makeProblem(db, 'First');
    const second = makeProblem(db, 'Second');
    const third = makeProblem(db, 'Third');
    for (const problemId of [first, second, third]) {
      addProblemSetItem(db, { setId, problemId, actorId: alice, isAdmin: false });
    }

    reorderProblemSetItems(db, {
      setId,
      problemIds: [third, first, second],
      actorId: alice,
      isAdmin: false,
    });
    let detail = requireDetail(getProblemSet(db, setId, alice, false));
    expect(detail.items.map((item) => item.problemId)).toEqual([third, first, second]);
    expect(detail.items.map((item) => item.ordinal)).toEqual([1, 2, 3]);

    removeProblemSetItem(db, { setId, problemId: first, actorId: alice, isAdmin: false });
    detail = requireDetail(getProblemSet(db, setId, alice, false));
    expect(detail.items.map((item) => item.problemId)).toEqual([third, second]);
    expect(detail.items.map((item) => item.ordinal)).toEqual([1, 2]);

    expectSetError(
      () => removeProblemSetItem(db, { setId, problemId: first, actorId: alice, isAdmin: false }),
      'SET_ITEM_NOT_FOUND',
      404,
    );
    expectSetError(
      () =>
        reorderProblemSetItems(db, {
          setId,
          problemIds: [third, 999999],
          actorId: alice,
          isAdmin: false,
        }),
      'SET_ITEM_NOT_FOUND',
      404,
    );
    expectSetError(
      () =>
        reorderProblemSetItems(db, {
          setId,
          problemIds: [third],
          actorId: alice,
          isAdmin: false,
        }),
      'SET_ITEM_INVALID',
      400,
    );
    expectSetError(
      () =>
        reorderProblemSetItems(db, {
          setId,
          problemIds: [third, second, second],
          actorId: alice,
          isAdmin: false,
        }),
      'SET_ITEM_INVALID',
      400,
    );
    expectSetError(
      () =>
        reorderProblemSetItems(db, {
          setId,
          problemIds: [third, second],
          actorId: bob,
          isAdmin: false,
        }),
      'SET_FORBIDDEN',
      403,
    );
  });

  it('only lets the owner, team captain or an admin add hidden problems', () => {
    const { db, alice, bob, admin } = setup();
    const hidden = makeProblem(db, 'Hidden', 'hidden');
    const setId = createPersonalSet(db, alice);
    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'edit',
      actorId: alice,
      isAdmin: false,
    });

    expectSetError(
      () => addProblemSetItem(db, { setId, problemId: hidden, actorId: bob, isAdmin: false }),
      'SET_FORBIDDEN',
      403,
    );

    addProblemSetItem(db, { setId, problemId: hidden, actorId: alice, isAdmin: false });
    expect(getProblem(db, hidden)?.visibility).toBe('hidden');

    const adminSet = createPersonalSet(db, alice, { title: 'Admin set' });
    addProblemSetItem(db, { setId: adminSet, problemId: hidden, actorId: admin, isAdmin: true });
    expect(getProblemSet(db, adminSet, admin, true)?.items.map((item) => item.problemId)).toEqual([
      hidden,
    ]);
  });

  it('lets an administrator manage any set without being the owner', () => {
    const { db, alice, bob, admin } = setup();
    const setId = createPersonalSet(db, alice);
    const problemId = makeProblem(db, 'P');
    addProblemSetItem(db, { setId, problemId, actorId: alice, isAdmin: false });

    const adminView = requireDetail(getProblemSet(db, setId, admin, true));
    expect(adminView.canEdit).toBe(true);
    expect(adminView.canManage).toBe(true);

    updateProblemSet(db, {
      setId,
      actorId: admin,
      isAdmin: true,
      patch: { title: 'Admin renamed', visibility: 'public' },
    });
    expect(getProblemSet(db, setId, bob, false)?.title).toBe('Admin renamed');

    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: admin,
      isAdmin: true,
    });
    expect(getProblemSet(db, setId, bob, false)).not.toBeNull();

    const second = makeProblem(db, 'Second');
    addProblemSetItem(db, { setId, problemId: second, actorId: admin, isAdmin: true });
    removeProblemSetItem(db, { setId, problemId, actorId: admin, isAdmin: true });
    expect(getProblemSet(db, setId, admin, true)?.items.map((item) => item.problemId)).toEqual([
      second,
    ]);

    deleteProblemSet(db, { setId, actorId: admin, isAdmin: true });
    expect(getProblemSet(db, setId, admin, true)).toBeNull();
  });

  it('removes items and shares when a set is deleted', () => {
    const { db, alice, bob } = setup();
    const setId = createPersonalSet(db, alice);
    const problemId = makeProblem(db, 'P');
    addProblemSetItem(db, { setId, problemId, actorId: alice, isAdmin: false });
    addProblemSetShare(db, {
      setId,
      granteeType: 'user',
      granteeId: bob,
      permission: 'read',
      actorId: alice,
      isAdmin: false,
    });
    expect(listProblemSets(db, { userId: bob }).map((set) => set.id)).toEqual([setId]);

    deleteProblemSet(db, { setId, actorId: alice, isAdmin: false });

    const itemCount = db
      .prepare('SELECT COUNT(*) AS n FROM problem_set_items WHERE set_id = ?')
      .get(setId) as { n: number };
    const shareCount = db
      .prepare('SELECT COUNT(*) AS n FROM problem_set_shares WHERE set_id = ?')
      .get(setId) as { n: number };
    expect(itemCount.n).toBe(0);
    expect(shareCount.n).toBe(0);
    expect(listProblemSets(db, { userId: bob })).toEqual([]);
  });

  it('lists personal, team, public and shared sets once each', () => {
    const { db, alice, bob, carol, dave } = setup();
    const alpha = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId: alpha, actorId: alice, username: 'bob' });
    const beta = createTeam(db, { name: 'Beta', ownerId: dave });
    addTeamMember(db, { teamId: beta, actorId: dave, username: 'alice' });

    const personal = createPersonalSet(db, alice, { title: 'Personal', now: 10 });
    const teamSet = createProblemSet(db, {
      title: 'Team set',
      ownerType: 'team',
      ownerId: alpha,
      actorId: alice,
      now: 11,
    });
    const publicSet = createPersonalSet(db, bob, {
      title: 'Public',
      visibility: 'public',
      now: 12,
    });
    const sharedUser = createPersonalSet(db, bob, { title: 'Shared user', now: 13 });
    addProblemSetShare(db, {
      setId: sharedUser,
      granteeType: 'user',
      granteeId: alice,
      permission: 'read',
      actorId: bob,
      isAdmin: false,
    });
    const sharedTeam = createPersonalSet(db, bob, { title: 'Shared team', now: 14 });
    addProblemSetShare(db, {
      setId: sharedTeam,
      granteeType: 'team',
      granteeId: alpha,
      permission: 'read',
      actorId: bob,
      isAdmin: false,
    });
    // The same set is also shared directly; the list must not duplicate it.
    addProblemSetShare(db, {
      setId: sharedTeam,
      granteeType: 'user',
      granteeId: alice,
      permission: 'edit',
      actorId: bob,
      isAdmin: false,
    });
    const sharedEdit = createPersonalSet(db, bob, { title: 'Shared edit', now: 15 });
    addProblemSetShare(db, {
      setId: sharedEdit,
      granteeType: 'user',
      granteeId: alice,
      permission: 'edit',
      actorId: bob,
      isAdmin: false,
    });
    const memberTeamSet = createProblemSet(db, {
      title: 'Beta team set',
      ownerType: 'team',
      ownerId: beta,
      actorId: dave,
      now: 16,
    });
    const hiddenFromAlice = createPersonalSet(db, carol, { title: 'Carol private', now: 17 });

    const visible = listProblemSets(db, { userId: alice });
    const ids = visible.map((set) => set.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort((a, b) => a - b)).toEqual(
      [personal, teamSet, publicSet, sharedUser, sharedTeam, sharedEdit, memberTeamSet].sort(
        (a, b) => a - b,
      ),
    );
    expect(ids).not.toContain(hiddenFromAlice);
    expect(visible.find((set) => set.id === teamSet)?.canManage).toBe(true);
    expect(visible.find((set) => set.id === memberTeamSet)?.canEdit).toBe(false);
    expect(visible.find((set) => set.id === sharedTeam)?.canEdit).toBe(true);

    const withoutPublic = listProblemSets(db, { userId: alice, includePublic: false });
    expect(withoutPublic.map((set) => set.id)).not.toContain(publicSet);
    expect(withoutPublic.map((set) => set.id)).toContain(sharedUser);
    expect(new Set(withoutPublic.map((set) => set.id)).size).toBe(withoutPublic.length);
  });
});
