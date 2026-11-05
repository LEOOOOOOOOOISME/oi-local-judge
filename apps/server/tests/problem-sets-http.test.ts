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
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(tmpdir(), 'oij-problem-sets-http-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

const ids: Record<'admin' | 'alice' | 'bob' | 'carol' | 'dave', number> = {
  admin: 0,
  alice: 0,
  bob: 0,
  carol: 0,
  dave: 0,
};
const cookies: Record<string, string> = {};

interface ApiError {
  ok: false;
  error: { code: string; message?: string };
}

interface ProblemSetItem {
  problemId: number;
  ordinal: number;
  addedAt: number;
  title: string;
  type: string;
  difficulty: number | null;
  tags: string[];
  timeMs: number;
  memoryMb: number;
}

interface ProblemSetShare {
  granteeType: 'user' | 'team';
  granteeId: number;
  permission: 'read' | 'edit';
  createdBy: number;
  createdAt: number;
}

interface ProblemSetSummary {
  id: number;
  title: string;
  description: string;
  ownerType: 'user' | 'team';
  ownerId: number;
  visibility: 'private' | 'public';
  createdBy: number;
  createdAt: number;
  updatedAt: number;
  itemCount: number;
  canEdit: boolean;
  canManage: boolean;
  canDelete: boolean;
}

interface ProblemSetDetail extends ProblemSetSummary {
  items: ProblemSetItem[];
  shares: ProblemSetShare[];
}

interface DetailBody {
  ok: true;
  data: ProblemSetDetail;
}

interface ListBody {
  ok: true;
  data: ProblemSetSummary[];
}

function seedUser(username: string, role: 'admin' | 'contestant' = 'contestant'): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

function makeProblem(
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

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  ids.admin = seedUser('admin', 'admin');
  ids.alice = seedUser('alice');
  ids.bob = seedUser('bob');
  ids.carol = seedUser('carol');
  ids.dave = seedUser('dave');
  for (const [name, id] of Object.entries(ids)) {
    cookies[name] = `oij.sid=${signSession({ userId: id, version: 0 }, config.sessionSecret, 3600)}`;
  }
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

function detailOf(response: { json: () => unknown }): ProblemSetDetail {
  return (response.json() as DetailBody).data;
}

function listOf(response: { json: () => unknown }): ProblemSetSummary[] {
  return (response.json() as ListBody).data;
}

async function createSet(
  username: string,
  payload: Record<string, unknown> = { title: 'A set' },
): Promise<number> {
  const response = await api('POST', '/api/problem-sets', username, payload);
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { data: { id: number } }).data.id;
}

async function createTeam(username: string, name: string): Promise<number> {
  const response = await api('POST', '/api/teams', username, { name });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { data: { id: number } }).data.id;
}

async function addTeamMember(actor: string, teamId: number, username: string): Promise<void> {
  const response = await api('POST', `/api/teams/${teamId}/members`, actor, { username });
  expect(response.statusCode, response.body).toBe(201);
}

describe('problem set HTTP API', () => {
  it('requires authentication on every problem set route', async () => {
    const routes: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/problem-sets'],
      ['GET', '/api/problem-sets/1'],
      ['POST', '/api/problem-sets', { title: 'Anonymous' }],
      ['PUT', '/api/problem-sets/1', { title: 'Anonymous' }],
      ['DELETE', '/api/problem-sets/1'],
      ['POST', '/api/problem-sets/1/items', { problemId: 1 }],
      ['DELETE', '/api/problem-sets/1/items/1'],
      ['PUT', '/api/problem-sets/1/items', { problemIds: [1] }],
      ['POST', '/api/problem-sets/1/shares', {
        granteeType: 'user',
        granteeId: 2,
        permission: 'read',
      }],
      ['DELETE', '/api/problem-sets/1/shares/user/2'],
    ];
    for (const [method, url, payload] of routes) {
      const response = await api(method, url, null, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(errorCode(response.json())).toBe('UNAUTHORIZED');
    }
  });

  it('creates a personal set with defaults and returns an editable detail', async () => {
    const setId = await createSet('alice', { title: '  My list  ', description: 'desc' });
    expect(setId).toBeGreaterThan(0);

    const response = await api('GET', `/api/problem-sets/${setId}`, 'alice');
    expect(response.statusCode, response.body).toBe(200);
    const detail = detailOf(response);
    expect(detail).toMatchObject({
      id: setId,
      title: 'My list',
      description: 'desc',
      ownerType: 'user',
      ownerId: ids.alice,
      visibility: 'private',
      createdBy: ids.alice,
      itemCount: 0,
      canEdit: true,
      canManage: true,
      canDelete: true,
    });
    expect(detail.items).toEqual([]);
    expect(detail.shares).toEqual([]);

    const createBody = await api('POST', '/api/problem-sets', 'alice', {
      title: 'Team-ish',
      ownerType: 'team',
      ownerId: 999999,
    });
    expect(createBody.statusCode).toBe(400);
    expect(errorCode(createBody.json())).toBe('SET_OWNER_INVALID');
  });

  it('validates create and update payloads with mapped error codes', async () => {
    const missingTitle = await api('POST', '/api/problem-sets', 'alice', {});
    expect(missingTitle.statusCode).toBe(400);
    expect(errorCode(missingTitle.json())).toBe('SET_TITLE_INVALID');

    const blankTitle = await api('POST', '/api/problem-sets', 'alice', { title: '   ' });
    expect(blankTitle.statusCode).toBe(400);
    expect(errorCode(blankTitle.json())).toBe('SET_TITLE_INVALID');

    const badDescription = await api('POST', '/api/problem-sets', 'alice', {
      title: 'Bad desc',
      description: 42,
    });
    expect(badDescription.statusCode).toBe(400);
    expect(errorCode(badDescription.json())).toBe('SET_DESCRIPTION_INVALID');

    const badOwnerType = await api('POST', '/api/problem-sets', 'alice', {
      title: 'Bad owner',
      ownerType: 'group',
    });
    expect(badOwnerType.statusCode).toBe(400);
    expect(errorCode(badOwnerType.json())).toBe('SET_OWNER_INVALID');

    const badVisibility = await api('POST', '/api/problem-sets', 'alice', {
      title: 'Bad visibility',
      visibility: 'shared',
    });
    expect(badVisibility.statusCode).toBe(400);
    expect(errorCode(badVisibility.json())).toBe('SET_VISIBILITY_INVALID');

    const otherOwner = await api('POST', '/api/problem-sets', 'alice', {
      title: 'Someone else',
      ownerId: ids.bob,
    });
    expect(otherOwner.statusCode).toBe(403);
    expect(errorCode(otherOwner.json())).toBe('SET_FORBIDDEN');

    const setId = await createSet('alice', { title: 'Patch target' });
    const badPatchTitle = await api('PUT', `/api/problem-sets/${setId}`, 'alice', {
      title: '   ',
    });
    expect(badPatchTitle.statusCode).toBe(400);
    expect(errorCode(badPatchTitle.json())).toBe('SET_TITLE_INVALID');

    const badPatchDescription = await api('PUT', `/api/problem-sets/${setId}`, 'alice', {
      description: 42,
    });
    expect(badPatchDescription.statusCode).toBe(400);
    expect(errorCode(badPatchDescription.json())).toBe('SET_DESCRIPTION_INVALID');

    const badPatchVisibility = await api('PUT', `/api/problem-sets/${setId}`, 'alice', {
      visibility: 'shared',
    });
    expect(badPatchVisibility.statusCode).toBe(400);
    expect(errorCode(badPatchVisibility.json())).toBe('SET_VISIBILITY_INVALID');
  });

  it('lists own, team, public and shared sets without leaking private sets', async () => {
    const personal = await createSet('alice', { title: 'Personal' });
    const publicSet = await createSet('bob', { title: 'Public', visibility: 'public' });
    const shared = await createSet('bob', { title: 'Shared' });
    const shareResponse = await api('POST', `/api/problem-sets/${shared}/shares`, 'bob', {
      granteeType: 'user',
      granteeId: ids.alice,
      permission: 'read',
    });
    expect(shareResponse.statusCode, shareResponse.body).toBe(201);
    const carolPrivate = await createSet('carol', { title: 'Carol private' });

    const teamId = await createTeam('alice', 'List team');
    const teamSet = await createSet('alice', {
      title: 'Team list',
      ownerType: 'team',
      ownerId: teamId,
    });

    const aliceList = await api('GET', '/api/problem-sets', 'alice');
    expect(aliceList.statusCode, aliceList.body).toBe(200);
    const aliceIds = listOf(aliceList).map((set) => set.id);
    expect(aliceIds).toEqual(expect.arrayContaining([personal, publicSet, shared, teamSet]));
    expect(aliceIds).not.toContain(carolPrivate);
    expect(listOf(aliceList).find((set) => set.id === shared)?.canEdit).toBe(false);
    expect(listOf(aliceList).find((set) => set.id === teamSet)?.canEdit).toBe(true);

    const daveList = await api('GET', '/api/problem-sets', 'dave');
    expect(daveList.statusCode, daveList.body).toBe(200);
    const daveIds = listOf(daveList).map((set) => set.id);
    expect(daveIds).toContain(publicSet);
    expect(daveIds).not.toContain(personal);
    expect(daveIds).not.toContain(shared);
    expect(daveIds).not.toContain(carolPrivate);
  });

  it('hides private sets from strangers and exposes public sets read-only', async () => {
    const privateSet = await createSet('alice', { title: 'Private' });
    const hidden = await api('GET', `/api/problem-sets/${privateSet}`, 'bob');
    expect(hidden.statusCode).toBe(404);
    expect(errorCode(hidden.json())).toBe('SET_NOT_FOUND');

    const publicSet = await createSet('alice', { title: 'Public', visibility: 'public' });
    const publicView = await api('GET', `/api/problem-sets/${publicSet}`, 'bob');
    expect(publicView.statusCode, publicView.body).toBe(200);
    const publicDetail = detailOf(publicView);
    expect(publicDetail).toMatchObject({
      id: publicSet,
      canEdit: false,
      canManage: false,
      canDelete: false,
    });
    expect(publicDetail.shares).toEqual([]);

    const writeAttempt = await api('PUT', `/api/problem-sets/${publicSet}`, 'bob', {
      title: 'Not mine',
    });
    expect(writeAttempt.statusCode).toBe(403);
    expect(errorCode(writeAttempt.json())).toBe('SET_FORBIDDEN');

    const deleteAttempt = await api('DELETE', `/api/problem-sets/${publicSet}`, 'bob');
    expect(deleteAttempt.statusCode).toBe(403);
    expect(errorCode(deleteAttempt.json())).toBe('SET_FORBIDDEN');

    const missing = await api('GET', '/api/problem-sets/999999', 'alice');
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('SET_NOT_FOUND');

    const invalidId = await api('GET', '/api/problem-sets/not-a-number', 'alice');
    expect(invalidId.statusCode).toBe(404);
    expect(errorCode(invalidId.json())).toBe('SET_NOT_FOUND');
  });

  it('lets an edit share change content but not visibility, deletion or shares', async () => {
    const setId = await createSet('alice', { title: 'Editable' });
    const shared = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'edit',
    });
    expect(shared.statusCode, shared.body).toBe(201);

    const update = await api('PUT', `/api/problem-sets/${setId}`, 'bob', {
      title: 'Edited by bob',
      description: 'ok',
    });
    expect(update.statusCode, update.body).toBe(200);

    const bobView = await api('GET', `/api/problem-sets/${setId}`, 'bob');
    expect(detailOf(bobView)).toMatchObject({
      title: 'Edited by bob',
      description: 'ok',
      canEdit: true,
      canManage: false,
      canDelete: false,
    });
    expect(detailOf(bobView).shares).toEqual([]);

    const visibilityAttempt = await api('PUT', `/api/problem-sets/${setId}`, 'bob', {
      visibility: 'public',
    });
    expect(visibilityAttempt.statusCode).toBe(403);
    expect(errorCode(visibilityAttempt.json())).toBe('SET_FORBIDDEN');

    const deleteAttempt = await api('DELETE', `/api/problem-sets/${setId}`, 'bob');
    expect(deleteAttempt.statusCode).toBe(403);
    expect(errorCode(deleteAttempt.json())).toBe('SET_FORBIDDEN');

    const shareAttempt = await api('POST', `/api/problem-sets/${setId}/shares`, 'bob', {
      granteeType: 'user',
      granteeId: ids.carol,
      permission: 'read',
    });
    expect(shareAttempt.statusCode).toBe(403);
    expect(errorCode(shareAttempt.json())).toBe('SET_FORBIDDEN');

    const ownerView = await api('GET', `/api/problem-sets/${setId}`, 'alice');
    expect(detailOf(ownerView).shares).toEqual([
      expect.objectContaining({
        granteeType: 'user',
        granteeId: ids.bob,
        permission: 'edit',
      }),
    ]);
  });

  it('updates, deletes and lets administrators manage any set', async () => {
    const setId = await createSet('alice', { title: 'Admin target' });
    const asAdmin = await api('PUT', `/api/problem-sets/${setId}`, 'admin', {
      title: 'Admin renamed',
      visibility: 'public',
    });
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);

    const strangerView = await api('GET', `/api/problem-sets/${setId}`, 'carol');
    expect(strangerView.statusCode, strangerView.body).toBe(200);
    expect(detailOf(strangerView).title).toBe('Admin renamed');
    expect(detailOf(strangerView).canEdit).toBe(false);

    const deleted = await api('DELETE', `/api/problem-sets/${setId}`, 'admin');
    expect(deleted.statusCode, deleted.body).toBe(200);

    const gone = await api('GET', `/api/problem-sets/${setId}`, 'alice');
    expect(gone.statusCode).toBe(404);
    expect(errorCode(gone.json())).toBe('SET_NOT_FOUND');
  });

  it('adds, removes and reorders items with duplicate and missing errors', async () => {
    const setId = await createSet('alice', { title: 'Items' });
    const first = makeProblem('First');
    const second = makeProblem('Second');
    const third = makeProblem('Third');

    for (const problemId of [first, second]) {
      const added = await api('POST', `/api/problem-sets/${setId}/items`, 'alice', {
        problemId,
      });
      expect(added.statusCode, added.body).toBe(201);
    }

    const duplicate = await api('POST', `/api/problem-sets/${setId}/items`, 'alice', {
      problemId: first,
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorCode(duplicate.json())).toBe('SET_ITEM_EXISTS');

    const missingProblem = await api('POST', `/api/problem-sets/${setId}/items`, 'alice', {
      problemId: 999999,
    });
    expect(missingProblem.statusCode).toBe(404);
    expect(errorCode(missingProblem.json())).toBe('SET_ITEM_NOT_FOUND');

    const invalidProblem = await api('POST', `/api/problem-sets/${setId}/items`, 'alice', {
      problemId: 'nope',
    });
    expect(invalidProblem.statusCode).toBe(400);
    expect(errorCode(invalidProblem.json())).toBe('SET_ITEM_INVALID');

    const reordered = await api('PUT', `/api/problem-sets/${setId}/items`, 'alice', {
      problemIds: [second, first],
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(detailOf(await api('GET', `/api/problem-sets/${setId}`, 'alice')).items).toMatchObject([
      { problemId: second, ordinal: 1 },
      { problemId: first, ordinal: 2 },
    ]);

    const incomplete = await api('PUT', `/api/problem-sets/${setId}/items`, 'alice', {
      problemIds: [second],
    });
    expect(incomplete.statusCode).toBe(400);
    expect(errorCode(incomplete.json())).toBe('SET_ITEM_INVALID');

    const unknown = await api('PUT', `/api/problem-sets/${setId}/items`, 'alice', {
      problemIds: [second, third],
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown.json())).toBe('SET_ITEM_NOT_FOUND');

    const removed = await api(
      'DELETE',
      `/api/problem-sets/${setId}/items/${first}`,
      'alice',
    );
    expect(removed.statusCode, removed.body).toBe(200);
    const afterRemove = detailOf(await api('GET', `/api/problem-sets/${setId}`, 'alice'));
    expect(afterRemove.items).toMatchObject([{ problemId: second, ordinal: 1 }]);

    const removedAgain = await api(
      'DELETE',
      `/api/problem-sets/${setId}/items/${first}`,
      'alice',
    );
    expect(removedAgain.statusCode).toBe(404);
    expect(errorCode(removedAgain.json())).toBe('SET_ITEM_NOT_FOUND');

    const strangerAdd = await api('POST', `/api/problem-sets/${setId}/items`, 'bob', {
      problemId: third,
    });
    expect(strangerAdd.statusCode).toBe(403);
    expect(errorCode(strangerAdd.json())).toBe('SET_FORBIDDEN');

    const invalidItemId = await api(
      'DELETE',
      `/api/problem-sets/${setId}/items/not-a-number`,
      'alice',
    );
    expect(invalidItemId.statusCode).toBe(404);
    expect(errorCode(invalidItemId.json())).toBe('SET_ITEM_NOT_FOUND');
  });

  it('only lets the owner or an admin add hidden problems', async () => {
    const hidden = makeProblem('Hidden', 'hidden');
    const setId = await createSet('alice', { title: 'Hidden items' });
    const shared = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'edit',
    });
    expect(shared.statusCode, shared.body).toBe(201);

    const forbidden = await api('POST', `/api/problem-sets/${setId}/items`, 'bob', {
      problemId: hidden,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden.json())).toBe('SET_FORBIDDEN');

    const allowed = await api('POST', `/api/problem-sets/${setId}/items`, 'alice', {
      problemId: hidden,
    });
    expect(allowed.statusCode, allowed.body).toBe(201);

    const adminSet = await createSet('alice', { title: 'Admin hidden' });
    const adminAllowed = await api('POST', `/api/problem-sets/${adminSet}/items`, 'admin', {
      problemId: hidden,
    });
    expect(adminAllowed.statusCode, adminAllowed.body).toBe(201);
  });

  it('manages shares and validates their grantees', async () => {
    const setId = await createSet('alice', { title: 'Shares' });
    const teamId = await createTeam('alice', 'Share team');
    await addTeamMember('alice', teamId, 'dave');

    const toBob = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'read',
    });
    expect(toBob.statusCode, toBob.body).toBe(201);
    expect(
      (await api('GET', `/api/problem-sets/${setId}`, 'bob')).statusCode,
    ).toBe(200);

    const toTeam = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'team',
      granteeId: teamId,
      permission: 'read',
    });
    expect(toTeam.statusCode, toTeam.body).toBe(201);
    expect(
      (await api('GET', `/api/problem-sets/${setId}`, 'dave')).statusCode,
    ).toBe(200);
    expect(
      (await api('GET', `/api/problem-sets/${setId}`, 'carol')).statusCode,
    ).toBe(404);

    const upgrade = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'edit',
    });
    expect(upgrade.statusCode, upgrade.body).toBe(201);
    expect(detailOf(await api('GET', `/api/problem-sets/${setId}`, 'bob')).canEdit).toBe(true);

    const badGranteeType = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'group',
      granteeId: ids.bob,
      permission: 'read',
    });
    expect(badGranteeType.statusCode).toBe(400);
    expect(errorCode(badGranteeType.json())).toBe('SET_SHARE_INVALID');

    const badGrantee = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: 999999,
      permission: 'read',
    });
    expect(badGrantee.statusCode).toBe(400);
    expect(errorCode(badGrantee.json())).toBe('SET_SHARE_INVALID');

    const badPermission = await api('POST', `/api/problem-sets/${setId}/shares`, 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'owner',
    });
    expect(badPermission.statusCode).toBe(400);
    expect(errorCode(badPermission.json())).toBe('SET_SHARE_INVALID');

    const nonManager = await api('POST', `/api/problem-sets/${setId}/shares`, 'bob', {
      granteeType: 'user',
      granteeId: ids.carol,
      permission: 'read',
    });
    expect(nonManager.statusCode).toBe(403);
    expect(errorCode(nonManager.json())).toBe('SET_FORBIDDEN');

    const removedUserShare = await api(
      'DELETE',
      `/api/problem-sets/${setId}/shares/user/${ids.bob}`,
      'alice',
    );
    expect(removedUserShare.statusCode, removedUserShare.body).toBe(200);
    expect(
      (await api('GET', `/api/problem-sets/${setId}`, 'bob')).statusCode,
    ).toBe(404);

    const removedAgain = await api(
      'DELETE',
      `/api/problem-sets/${setId}/shares/user/${ids.bob}`,
      'alice',
    );
    expect(removedAgain.statusCode).toBe(400);
    expect(errorCode(removedAgain.json())).toBe('SET_SHARE_INVALID');

    const removedTeamShare = await api(
      'DELETE',
      `/api/problem-sets/${setId}/shares/team/${teamId}`,
      'alice',
    );
    expect(removedTeamShare.statusCode, removedTeamShare.body).toBe(200);
    expect(
      (await api('GET', `/api/problem-sets/${setId}`, 'dave')).statusCode,
    ).toBe(404);

    const badShareType = await api(
      'DELETE',
      `/api/problem-sets/${setId}/shares/group/${ids.bob}`,
      'alice',
    );
    expect(badShareType.statusCode).toBe(400);
    expect(errorCode(badShareType.json())).toBe('SET_SHARE_INVALID');

    const missingSet = await api('POST', '/api/problem-sets/999999/shares', 'alice', {
      granteeType: 'user',
      granteeId: ids.bob,
      permission: 'read',
    });
    expect(missingSet.statusCode).toBe(404);
    expect(errorCode(missingSet.json())).toBe('SET_NOT_FOUND');
  });

  it('lets a team captain manage a team set while members only read it', async () => {
    const teamId = await createTeam('alice', 'Captain team');
    await addTeamMember('alice', teamId, 'bob');
    const setId = await createSet('alice', {
      title: 'Team set',
      ownerType: 'team',
      ownerId: teamId,
    });

    const captainView = await api('GET', `/api/problem-sets/${setId}`, 'alice');
    expect(captainView.statusCode, captainView.body).toBe(200);
    expect(detailOf(captainView)).toMatchObject({
      canEdit: true,
      canManage: true,
      canDelete: true,
    });

    const memberView = await api('GET', `/api/problem-sets/${setId}`, 'bob');
    expect(memberView.statusCode, memberView.body).toBe(200);
    expect(detailOf(memberView)).toMatchObject({
      canEdit: false,
      canManage: false,
      canDelete: false,
    });

    const memberUpdate = await api('PUT', `/api/problem-sets/${setId}`, 'bob', {
      title: 'Member edit',
    });
    expect(memberUpdate.statusCode).toBe(403);
    expect(errorCode(memberUpdate.json())).toBe('SET_FORBIDDEN');

    const memberDelete = await api('DELETE', `/api/problem-sets/${setId}`, 'bob');
    expect(memberDelete.statusCode).toBe(403);

    const memberShare = await api('POST', `/api/problem-sets/${setId}/shares`, 'bob', {
      granteeType: 'user',
      granteeId: ids.carol,
      permission: 'read',
    });
    expect(memberShare.statusCode).toBe(403);

    const memberItem = await api('POST', `/api/problem-sets/${setId}/items`, 'bob', {
      problemId: makeProblem('Team item'),
    });
    expect(memberItem.statusCode).toBe(403);

    const outsiderView = await api('GET', `/api/problem-sets/${setId}`, 'carol');
    expect(outsiderView.statusCode).toBe(404);
    expect(errorCode(outsiderView.json())).toBe('SET_NOT_FOUND');

    const captainUpdate = await api('PUT', `/api/problem-sets/${setId}`, 'alice', {
      title: 'Captain edit',
    });
    expect(captainUpdate.statusCode, captainUpdate.body).toBe(200);

    const memberCreate = await api('POST', '/api/problem-sets', 'bob', {
      title: 'Bob team set',
      ownerType: 'team',
      ownerId: teamId,
    });
    expect(memberCreate.statusCode).toBe(403);
    expect(errorCode(memberCreate.json())).toBe('SET_FORBIDDEN');

    const captainDelete = await api('DELETE', `/api/problem-sets/${setId}`, 'alice');
    expect(captainDelete.statusCode, captainDelete.body).toBe(200);
  });
});
