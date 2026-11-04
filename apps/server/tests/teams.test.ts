import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  addTeamMember,
  createTeam,
  dissolveTeam,
  getTeam,
  leaveTeam,
  listTeamsForUser,
  removeTeamMember,
  searchTeams,
  transferCaptain,
  TeamError,
} from '../src/services/teams.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'oij-teams-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
  const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
  const carol = createUser(db, { username: 'carol', passwordHash: 'x' });
  return { db, alice, bob, carol };
}

function expectTeamError(fn: () => unknown, code: string, status: number) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TeamError);
  const error = caught as TeamError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
}

describe('teams service', () => {
  it('creates a team with the owner as captain', () => {
    const { db, alice } = setup();
    const teamId = createTeam(db, { name: '  Alpha  ', ownerId: alice, now: 1000 });
    const team = getTeam(db, teamId);
    expect(team).not.toBeNull();
    expect(team?.name).toBe('Alpha');
    expect(team?.ownerId).toBe(alice);
    expect(team?.createdAt).toBe(1000);
    expect(team?.members).toHaveLength(1);
    expect(team?.members[0]).toMatchObject({
      userId: alice,
      username: 'alice',
      role: 'captain',
      joinedAt: 1000,
    });
  });

  it('rejects invalid team names', () => {
    const { db, alice } = setup();
    for (const name of ['', '   ', 'A', 'x'.repeat(41)]) {
      expectTeamError(() => createTeam(db, { name, ownerId: alice }), 'TEAM_NAME_INVALID', 400);
    }
  });

  it('rejects duplicate team names after trimming', () => {
    const { db, alice, bob } = setup();
    createTeam(db, { name: 'Alpha', ownerId: alice });
    expectTeamError(
      () => createTeam(db, { name: ' Alpha ', ownerId: bob }),
      'TEAM_NAME_TAKEN',
      409,
    );
  });

  it('rejects a team owner that does not exist or is inactive', () => {
    const { db, alice } = setup();
    expectTeamError(
      () => createTeam(db, { name: 'Ghost', ownerId: 999999 }),
      'USER_NOT_FOUND',
      404,
    );
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(alice);
    expectTeamError(() => createTeam(db, { name: 'Frozen', ownerId: alice }), 'USER_INACTIVE', 403);
  });

  it('adds a member by username', () => {
    const { db, alice } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: ' bob ', now: 2000 });
    const team = getTeam(db, teamId);
    expect(team?.members).toHaveLength(2);
    expect(team?.members.find((member) => member.username === 'bob')).toMatchObject({
      role: 'member',
      joinedAt: 2000,
    });
  });

  it('rejects duplicate members, unknown users and non-captain actors', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    expectTeamError(
      () => addTeamMember(db, { teamId, actorId: alice, username: 'bob' }),
      'TEAM_MEMBER_EXISTS',
      409,
    );
    expectTeamError(
      () => addTeamMember(db, { teamId, actorId: alice, username: 'nobody' }),
      'USER_NOT_FOUND',
      404,
    );
    expectTeamError(
      () => addTeamMember(db, { teamId, actorId: bob, username: 'carol' }),
      'TEAM_FORBIDDEN',
      403,
    );
    expectTeamError(
      () => addTeamMember(db, { teamId: 999999, actorId: alice, username: 'carol' }),
      'TEAM_NOT_FOUND',
      404,
    );
  });

  it('rejects adding an inactive user', () => {
    const { db, alice, carol } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(carol);
    expectTeamError(
      () => addTeamMember(db, { teamId, actorId: alice, username: 'carol' }),
      'USER_INACTIVE',
      403,
    );
  });

  it('removes a member as captain', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    removeTeamMember(db, { teamId, actorId: alice, userId: bob });
    expect(getTeam(db, teamId)?.members.map((member) => member.userId)).toEqual([alice]);
    expectTeamError(
      () => removeTeamMember(db, { teamId, actorId: alice, userId: bob }),
      'TEAM_MEMBER_NOT_FOUND',
      404,
    );
    expectTeamError(
      () => removeTeamMember(db, { teamId, actorId: alice, userId: alice }),
      'TEAM_FORBIDDEN',
      403,
    );
  });

  it('rejects removal by a non-captain member', () => {
    const { db, alice, bob, carol } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    addTeamMember(db, { teamId, actorId: alice, username: 'carol' });
    expectTeamError(
      () => removeTeamMember(db, { teamId, actorId: bob, userId: carol }),
      'TEAM_FORBIDDEN',
      403,
    );
  });

  it('lets an ordinary member leave', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    leaveTeam(db, teamId, bob);
    expect(getTeam(db, teamId)?.members.map((member) => member.userId)).toEqual([alice]);
    expectTeamError(() => leaveTeam(db, teamId, bob), 'TEAM_MEMBER_NOT_FOUND', 404);
    expectTeamError(() => leaveTeam(db, 999999, bob), 'TEAM_NOT_FOUND', 404);
  });

  it('rejects leaving for the captain', () => {
    const { db, alice } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    expectTeamError(() => leaveTeam(db, teamId, alice), 'TEAM_CAPTAIN_LAST', 409);
    expect(getTeam(db, teamId)?.members[0]?.role).toBe('captain');
  });

  it('transfers the captain role within one transaction', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    transferCaptain(db, { teamId, actorId: alice, userId: bob });

    const team = getTeam(db, teamId);
    expect(team?.ownerId).toBe(bob);
    expect(team?.members.find((member) => member.userId === bob)?.role).toBe('captain');
    expect(team?.members.find((member) => member.userId === alice)?.role).toBe('member');

    leaveTeam(db, teamId, alice);
    expect(getTeam(db, teamId)?.members.map((member) => member.userId)).toEqual([bob]);
  });

  it('rejects forbidden or invalid transfers', () => {
    const { db, alice, bob, carol } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    expectTeamError(
      () => transferCaptain(db, { teamId, actorId: bob, userId: alice }),
      'TEAM_FORBIDDEN',
      403,
    );
    expectTeamError(
      () => transferCaptain(db, { teamId, actorId: alice, userId: carol }),
      'TEAM_MEMBER_NOT_FOUND',
      404,
    );
    expectTeamError(
      () => transferCaptain(db, { teamId, actorId: alice, userId: alice }),
      'TEAM_TRANSFER_SELF',
      400,
    );
  });

  it('dissolves a team and its memberships', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    dissolveTeam(db, { teamId, actorId: alice, isAdmin: false });
    expect(getTeam(db, teamId)).toBeNull();
    const members = db
      .prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?')
      .get(teamId) as { n: number };
    expect(members.n).toBe(0);
    expectTeamError(
      () => dissolveTeam(db, { teamId, actorId: alice, isAdmin: false }),
      'TEAM_NOT_FOUND',
      404,
    );
  });

  it('rejects dissolving a team without ownership', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
    expectTeamError(
      () => dissolveTeam(db, { teamId, actorId: bob, isAdmin: false }),
      'TEAM_FORBIDDEN',
      403,
    );
  });

  it('lets an administrator dissolve any team and writes an audit record', () => {
    const { db, alice, bob } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    dissolveTeam(db, { teamId, actorId: bob, isAdmin: true });
    expect(getTeam(db, teamId)).toBeNull();
    const audit = db
      .prepare("SELECT actor_id, action, target_id FROM audit_logs WHERE action = 'team.dissolve'")
      .get() as { actor_id: number; action: string; target_id: string } | undefined;
    expect(audit).toMatchObject({ actor_id: bob, target_id: String(teamId) });
  });

  it('lets an administrator add, remove and transfer without being captain', () => {
    const { db, alice, bob, carol } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });

    addTeamMember(db, { teamId, actorId: bob, username: 'carol', isAdmin: true });
    expect(getTeam(db, teamId)?.members.map((member) => member.username)).toEqual([
      'alice',
      'carol',
    ]);

    removeTeamMember(db, { teamId, actorId: bob, userId: carol, isAdmin: true });
    expect(getTeam(db, teamId)?.members.map((member) => member.username)).toEqual(['alice']);

    addTeamMember(db, { teamId, actorId: bob, username: 'carol', isAdmin: true });
    transferCaptain(db, { teamId, actorId: bob, userId: carol, isAdmin: true });
    const team = getTeam(db, teamId);
    expect(team?.ownerId).toBe(carol);
    expect(team?.members.find((member) => member.userId === carol)?.role).toBe('captain');
    expect(team?.members.find((member) => member.userId === alice)?.role).toBe('member');
  });

  it('supports one user in multiple teams', () => {
    const { db, alice, bob } = setup();
    const alpha = createTeam(db, { name: 'Alpha', ownerId: alice });
    const beta = createTeam(db, { name: 'Beta', ownerId: alice });
    addTeamMember(db, { teamId: alpha, actorId: alice, username: 'bob' });
    addTeamMember(db, { teamId: beta, actorId: alice, username: 'bob' });

    const aliceTeams = listTeamsForUser(db, alice);
    expect(aliceTeams.map((team) => team.name)).toEqual(['Alpha', 'Beta']);
    expect(aliceTeams.every((team) => team.role === 'captain' && team.memberCount === 2)).toBe(true);

    const bobTeams = listTeamsForUser(db, bob);
    expect(bobTeams.map((team) => team.name)).toEqual(['Alpha', 'Beta']);
    expect(bobTeams.every((team) => team.role === 'member' && team.memberCount === 2)).toBe(true);
  });

  it('returns empty results for unknown users and teams', () => {
    const { db } = setup();
    expect(listTeamsForUser(db, 999999)).toEqual([]);
    expect(getTeam(db, 999999)).toBeNull();
  });
});

describe('searchTeams', () => {
  it('matches team names case-insensitively and sorts by name', () => {
    const { db, alice, bob } = setup();
    createTeam(db, { name: 'Beta', ownerId: alice });
    createTeam(db, { name: 'alpha', ownerId: alice });
    const gamma = createTeam(db, { name: 'Gamma', ownerId: alice });
    addTeamMember(db, { teamId: gamma, actorId: alice, username: 'bob' });

    const all = searchTeams(db);
    expect(all.map((team) => team.name)).toEqual(['alpha', 'Beta', 'Gamma']);
    expect(all[1]).toMatchObject({ ownerId: alice, memberCount: 1 });
    expect(all.find((team) => team.name === 'Gamma')?.memberCount).toBe(2);
    expect(all.find((team) => team.name === 'Gamma')?.ownerId).toBe(alice);
    expect(all.find((team) => team.name === 'Gamma')?.createdAt).toBeGreaterThan(0);
    expect(all.map((team) => team.id)).toContain(gamma);

    const matched = searchTeams(db, { query: 'ALP' });
    expect(matched.map((team) => team.name)).toEqual(['alpha']);

    const missing = searchTeams(db, { query: 'nothing-here' });
    expect(missing).toEqual([]);
    // 去掉首尾空白后再匹配。
    expect(searchTeams(db, { query: '  Beta  ' }).map((team) => team.name)).toEqual(['Beta']);
  });

  it('treats SQL LIKE wildcards in the query as literal characters', () => {
    const { db, alice } = setup();
    createTeam(db, { name: '100% Pure', ownerId: alice });
    createTeam(db, { name: 'under_score', ownerId: alice });
    createTeam(db, { name: '100x Pure', ownerId: alice });

    expect(searchTeams(db, { query: '%' }).map((team) => team.name)).toEqual(['100% Pure']);
    expect(searchTeams(db, { query: '_' }).map((team) => team.name)).toEqual(['under_score']);
    expect(searchTeams(db, { query: '\\' })).toEqual([]);
  });

  it('defaults to 20 rows and clamps limit to 100', () => {
    const { db, alice } = setup();
    const insert = db.prepare('INSERT INTO teams(name, owner_id, created_at) VALUES (?, ?, ?)');
    for (let i = 0; i < 105; i += 1) {
      insert.run(`Team ${String(i).padStart(3, '0')}`, alice, i + 1);
    }

    expect(searchTeams(db)).toHaveLength(20);
    expect(searchTeams(db, { limit: 5 })).toHaveLength(5);
    expect(searchTeams(db, { limit: 500 })).toHaveLength(100);
    expect(searchTeams(db, { limit: 0 })).toHaveLength(1);
    expect(searchTeams(db, { limit: 3 }).map((team) => team.name)).toEqual([
      'Team 000',
      'Team 001',
      'Team 002',
    ]);
  });
});
