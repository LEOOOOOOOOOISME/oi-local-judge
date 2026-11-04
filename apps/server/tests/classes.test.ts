import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { getRegistrationRow } from '../src/storage/repos/contest-registrations.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  addClassCoach,
  addClassMember,
  canManageCoaches,
  canManageGroup,
  canTeachGroup,
  createClass,
  createTeam,
  deleteClass,
  getClass,
  getTeam,
  listClassesForUser,
  listTeamsForUser,
  removeClassCoach,
  removeClassMember,
  transferCaptain,
  TeamError,
  updateClass,
} from '../src/services/teams.js';
import {
  ContestTeamError,
  registerTeamForContest,
} from '../src/services/contest-teams.js';

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
  const dir = mkdtempSync(join(tmpdir(), 'oij-classes-'));
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
  const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
  const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
  const carol = createUser(db, { username: 'carol', passwordHash: 'x' });
  const dave = createUser(db, { username: 'dave', passwordHash: 'x' });
  return { db, admin, manager, alice, bob, carol, dave };
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

function expectContestTeamError(fn: () => unknown, code: string, status: number) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ContestTeamError);
  const error = caught as ContestTeamError;
  expect(error.code).toBe(code);
  expect(error.status).toBe(status);
}

function makeContest(db: DatabaseSync): number {
  return createContest(db, { name: 'Team Contest', teamMode: 'team' });
}

describe('class groups', () => {
  it('defaults existing and legacy teams to kind team and contests allowed', () => {
    const { db, alice } = setup();
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    const detail = getTeam(db, teamId);
    expect(detail).toMatchObject({ kind: 'team', allowContest: true });

    // A row written by the pre-kind schema (no kind/allow_contest columns).
    db.prepare('INSERT INTO teams(name, owner_id, created_at) VALUES (?, ?, ?)').run(
      'Legacy',
      alice,
      1,
    );
    const legacy = db
      .prepare("SELECT kind, allow_contest FROM teams WHERE name = 'Legacy'")
      .get() as { kind: string; allow_contest: number };
    expect(legacy).toEqual({ kind: 'team', allow_contest: 1 });
  });

  it('creates a class with the owner as coach', () => {
    const { db, manager } = setup();
    const classId = createClass(db, {
      name: '  Class A  ',
      ownerId: manager,
      actorRole: 'contestmanager',
      now: 1000,
    });
    const detail = getClass(db, classId);
    expect(detail).toMatchObject({
      name: 'Class A',
      kind: 'class',
      ownerId: manager,
      allowContest: true,
      createdAt: 1000,
    });
    expect(detail?.members).toEqual([
      expect.objectContaining({ userId: manager, role: 'coach', username: 'manager' }),
    ]);
    expect(getClass(db, classId)?.members).toHaveLength(1);
  });

  it('only lets admins and contest managers create classes', () => {
    const { db, admin, alice } = setup();
    expect(
      createClass(db, { name: 'Admin Class', ownerId: admin, actorRole: 'admin' }),
    ).toBeGreaterThan(0);
    expectTeamError(
      () => createClass(db, { name: 'Student Class', ownerId: alice, actorRole: 'contestant' }),
      'CLASS_FORBIDDEN',
      403,
    );
    expectTeamError(
      () => createClass(db, { name: 'Setter Class', ownerId: alice, actorRole: 'setter' }),
      'CLASS_FORBIDDEN',
      403,
    );
  });

  it('supports multiple coaches and students in multiple classes without a primary class', () => {
    const { db, manager, alice, bob, carol } = setup();
    const classA = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    const classB = createClass(db, {
      name: 'Class B',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId: classA, actorId: manager, username: 'alice' });
    addClassCoach(db, { classId: classA, actorId: manager, username: 'bob' });

    addClassMember(db, { classId: classA, actorId: alice, username: 'carol' });
    addClassMember(db, { classId: classB, actorId: manager, username: 'carol' });

    const detail = getClass(db, classA);
    expect(
      detail?.members.map((member) => [member.username, member.role]).sort((a, b) =>
        a[0]!.localeCompare(b[0]!),
      ),
    ).toEqual([
      ['alice', 'coach'],
      ['bob', 'coach'],
      ['carol', 'member'],
      ['manager', 'coach'],
    ]);

    // No primary class: the same student belongs to two classes at once.
    expect(listClassesForUser(db, carol).map((group) => group.name)).toEqual([
      'Class A',
      'Class B',
    ]);
    expect(listClassesForUser(db, carol).every((group) => group.role === 'member')).toBe(true);
    expect(listClassesForUser(db, alice).map((group) => group.name)).toEqual(['Class A']);
    expect(listClassesForUser(db, alice)[0]).toMatchObject({ role: 'coach', kind: 'class' });
  });

  it('lets coaches add and remove students and assistants but not coaches', () => {
    const { db, manager, alice, bob, carol, dave } = setup();
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });

    addClassMember(db, { classId, actorId: alice, username: 'bob' });
    addClassMember(db, { classId, actorId: alice, username: 'carol', role: 'assistant' });
    expectTeamError(
      () => addClassMember(db, { classId, actorId: alice, username: 'dave', role: 'coach' }),
      'CLASS_FORBIDDEN',
      403,
    );
    expectTeamError(
      () => addClassCoach(db, { classId, actorId: alice, username: 'dave' }),
      'CLASS_FORBIDDEN',
      403,
    );
    expectTeamError(
      () =>
        addClassMember(db, {
          classId,
          actorId: bob,
          username: 'dave',
        }),
      'CLASS_FORBIDDEN',
      403,
    );
    expectTeamError(
      () => addClassMember(db, { classId, actorId: alice, username: 'nobody' }),
      'USER_NOT_FOUND',
      404,
    );
    expectTeamError(
      () => addClassMember(db, { classId, actorId: alice, username: 'bob' }),
      'CLASS_MEMBER_EXISTS',
      409,
    );

    removeClassMember(db, { classId, actorId: alice, userId: bob });
    removeClassMember(db, { classId, actorId: alice, userId: carol });
    expect(
      getClass(db, classId)
        ?.members.map((member) => member.username)
        .sort(),
    ).toEqual(['alice', 'manager']);
    expectTeamError(
      () => removeClassMember(db, { classId, actorId: alice, userId: bob }),
      'CLASS_MEMBER_NOT_FOUND',
      404,
    );
  });

  it('only lets the owner or an admin manage coaches and protects the owner', () => {
    const { db, admin, manager, alice, bob } = setup();
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });

    // The owner (and an admin) may add and remove another coach.
    expectTeamError(
      () => addClassCoach(db, { classId, actorId: alice, username: 'bob' }),
      'CLASS_FORBIDDEN',
      403,
    );
    addClassCoach(db, { classId, actorId: admin, username: 'bob', isAdmin: true });
    expect(
      getClass(db, classId)
        ?.members.map((member) => [member.username, member.role])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ['alice', 'coach'],
      ['bob', 'coach'],
      ['manager', 'coach'],
    ]);

    expectTeamError(
      () => addClassCoach(db, { classId, actorId: manager, username: 'bob' }),
      'CLASS_COACH_EXISTS',
      409,
    );
    removeClassCoach(db, { classId, actorId: manager, userId: bob });
    expect(
      getClass(db, classId)
        ?.members.map((member) => member.username)
        .sort(),
    ).toEqual(['alice', 'manager']);
    expectTeamError(
      () => removeClassCoach(db, { classId, actorId: manager, userId: bob }),
      'CLASS_NOT_COACH',
      404,
    );

    // The owner is always a coach and cannot be removed.
    expectTeamError(
      () => removeClassCoach(db, { classId, actorId: manager, userId: manager }),
      'CLASS_OWNER_PROTECTED',
      409,
    );
    expectTeamError(
      () => removeClassMember(db, { classId, actorId: manager, userId: manager }),
      'CLASS_OWNER_PROTECTED',
      409,
    );
    expectTeamError(
      () => removeClassCoach(db, { classId, actorId: alice, userId: manager }),
      'CLASS_FORBIDDEN',
      403,
    );
  });

  it('rejects captain transfer and invalid roles on a class', () => {
    const { db, manager, alice } = setup();
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });
    expectTeamError(
      () => transferCaptain(db, { teamId: classId, actorId: manager, userId: alice }),
      'CLASS_NO_CAPTAIN',
      409,
    );
    expectTeamError(
      () =>
        addClassMember(db, {
          classId,
          actorId: manager,
          username: 'bob',
          role: 'captain',
        }),
      'CLASS_ROLE_INVALID',
      400,
    );
  });

  it('keeps classes out of the team listing', () => {
    const { db, manager, alice } = setup();
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    addClassMember(db, { classId, actorId: manager, username: 'alice' });

    expect(listClassesForUser(db, manager).map((group) => group.id)).toEqual([classId]);
    expect(listTeamsForUser(db, manager)).toEqual([]);
    expect(listClassesForUser(db, alice).map((group) => group.id)).toEqual([classId]);
    expect(listTeamsForUser(db, alice).map((group) => group.id)).toEqual([teamId]);
  });

  it('exposes unified permission helpers', () => {
    const { db, admin, manager, alice, bob, carol } = setup();
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });
    addClassMember(db, { classId, actorId: manager, username: 'bob', role: 'assistant' });
    addClassMember(db, { classId, actorId: manager, username: 'carol' });

    expect(canManageGroup(db, classId, manager)).toBe(true);
    expect(canManageGroup(db, classId, alice)).toBe(true);
    expect(canManageGroup(db, classId, bob)).toBe(false);
    expect(canManageGroup(db, classId, carol)).toBe(false);
    expect(canManageGroup(db, classId, admin, true)).toBe(true);

    expect(canTeachGroup(db, classId, manager)).toBe(true);
    expect(canTeachGroup(db, classId, alice)).toBe(true);
    expect(canTeachGroup(db, classId, carol)).toBe(false);

    expect(canManageCoaches(db, classId, manager)).toBe(true);
    expect(canManageCoaches(db, classId, alice)).toBe(false);
    expect(canManageCoaches(db, classId, admin, true)).toBe(true);

    const teamId = createTeam(db, { name: 'Alpha', ownerId: carol });
    expect(canManageGroup(db, teamId, carol)).toBe(true);
    expect(canTeachGroup(db, teamId, carol)).toBe(true);
    expect(canManageCoaches(db, teamId, carol)).toBe(true);
  });

  it('lets the owner and admins update a class but not other coaches', () => {
    const { db, admin, manager, alice } = setup();
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });

    updateClass(db, {
      classId,
      actorId: manager,
      name: '  Renamed Class  ',
      allowContest: false,
    });
    expect(getClass(db, classId)).toMatchObject({
      name: 'Renamed Class',
      allowContest: false,
    });

    // An admin may edit without owning the class.
    updateClass(db, { classId, actorId: admin, isAdmin: true, name: 'Admin Renamed' });
    expect(getClass(db, classId)?.name).toBe('Admin Renamed');

    // A non-owner coach cannot rename or flip the switch.
    expectTeamError(
      () => updateClass(db, { classId, actorId: alice, name: 'Coach Renamed' }),
      'CLASS_FORBIDDEN',
      403,
    );
    expectTeamError(
      () => updateClass(db, { classId, actorId: alice, allowContest: false }),
      'CLASS_FORBIDDEN',
      403,
    );
    expect(getClass(db, classId)).toMatchObject({
      name: 'Admin Renamed',
      allowContest: false,
    });
  });

  it('validates class renames and enforces one name across teams and classes', () => {
    const { db, manager, alice, bob } = setup();
    const classId = createClass(db, {
      name: 'Class A',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    createTeam(db, { name: 'Existing Team', ownerId: bob });
    createClass(db, { name: 'Class B', ownerId: manager, actorRole: 'contestmanager' });

    expectTeamError(
      () => updateClass(db, { classId, actorId: manager, name: 'A' }),
      'TEAM_NAME_INVALID',
      400,
    );
    expectTeamError(
      () => updateClass(db, { classId, actorId: manager, name: 'x'.repeat(41) }),
      'TEAM_NAME_INVALID',
      400,
    );
    expectTeamError(
      () => updateClass(db, { classId, actorId: manager, name: 'Existing Team' }),
      'TEAM_NAME_TAKEN',
      409,
    );
    expectTeamError(
      () => updateClass(db, { classId, actorId: manager, name: 'Class B' }),
      'TEAM_NAME_TAKEN',
      409,
    );

    // Keeping the current name and editing only the switch is allowed.
    updateClass(db, { classId, actorId: manager, name: 'Class A', allowContest: false });
    expect(getClass(db, classId)).toMatchObject({ name: 'Class A', allowContest: false });

    // An empty patch and team ids are rejected by the class service.
    expectTeamError(
      () => updateClass(db, { classId, actorId: manager }),
      'BAD_REQUEST',
      400,
    );
    const teamId = createTeam(db, { name: 'Solo Team', ownerId: alice });
    expectTeamError(
      () => updateClass(db, { classId: teamId, actorId: alice, name: 'Whatever' }),
      'CLASS_NOT_FOUND',
      404,
    );
    expect(getTeam(db, teamId)?.kind).toBe('team');
  });

  it('deletes a class with memberships, participation, registrations and an audit record', () => {
    const { db, admin, manager, alice, bob } = setup();
    const contestId = makeContest(db);
    const classId = createClass(db, {
      name: 'Contest Class',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });
    addClassMember(db, { classId, actorId: manager, username: 'bob' });
    registerTeamForContest(db, {
      contestId,
      teamId: classId,
      actorId: manager,
      isAdmin: false,
    });
    // Only the student is enrolled; coaches stay staff.
    expect(getRegistrationRow(db, contestId, bob)).not.toBeNull();
    expect(getRegistrationRow(db, contestId, manager)).toBeNull();
    const contestTeams = db
      .prepare('SELECT COUNT(*) AS n FROM contest_teams WHERE team_id = ?')
      .get(classId) as { n: number };
    expect(Number(contestTeams.n)).toBe(1);

    deleteClass(db, { classId, actorId: manager, isAdmin: false });

    expect(getClass(db, classId)).toBeNull();
    expect(getTeam(db, classId)).toBeNull();
    const members = db
      .prepare('SELECT COUNT(*) AS n FROM team_members WHERE team_id = ?')
      .get(classId) as { n: number };
    expect(Number(members.n)).toBe(0);
    expect(getRegistrationRow(db, contestId, bob)).toBeNull();
    expect(getRegistrationRow(db, contestId, alice)).toBeNull();
    const contestTeamsAfter = db
      .prepare('SELECT COUNT(*) AS n FROM contest_teams WHERE team_id = ?')
      .get(classId) as { n: number };
    expect(Number(contestTeamsAfter.n)).toBe(0);

    const audit = db
      .prepare(
        "SELECT actor_id, action, target_type, target_id FROM audit_logs WHERE action = 'class.dissolve'",
      )
      .get() as
      | { actor_id: number; action: string; target_type: string; target_id: string }
      | undefined;
    expect(audit).toMatchObject({
      actor_id: manager,
      action: 'class.dissolve',
      target_type: 'class',
      target_id: String(classId),
    });

    // Admin deletion and non-class ids.
    const another = createClass(db, {
      name: 'Admin Deleted',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    deleteClass(db, { classId: another, actorId: admin, isAdmin: true });
    expect(getClass(db, another)).toBeNull();

    const teamId = createTeam(db, { name: 'Delete Team', ownerId: bob });
    expectTeamError(
      () => deleteClass(db, { classId: teamId, actorId: bob, isAdmin: false }),
      'CLASS_NOT_FOUND',
      404,
    );
    expect(getTeam(db, teamId)).not.toBeNull();
  });

  it('rejects class deletion by a non-owner coach', () => {
    const { db, manager, alice } = setup();
    const classId = createClass(db, {
      name: 'Protected Class',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });
    expectTeamError(
      () => deleteClass(db, { classId, actorId: alice, isAdmin: false }),
      'CLASS_FORBIDDEN',
      403,
    );
    expect(getClass(db, classId)).not.toBeNull();
  });
});

describe('class contest participation', () => {
  it('rejects contest registration for a class with allow_contest disabled', () => {
    const { db, admin, manager } = setup();
    const contestId = makeContest(db);
    const classId = createClass(db, {
      name: 'No Contest',
      ownerId: manager,
      actorRole: 'contestmanager',
      allowContest: false,
    });

    expect(getClass(db, classId)?.allowContest).toBe(false);
    expectContestTeamError(
      () =>
        registerTeamForContest(db, {
          contestId,
          teamId: classId,
          actorId: manager,
          isAdmin: false,
        }),
      'CLASS_NOT_ALLOWED_IN_CONTEST',
      409,
    );
    // An administrator does not bypass the class switch either.
    expectContestTeamError(
      () =>
        registerTeamForContest(db, {
          contestId,
          teamId: classId,
          actorId: admin,
          isAdmin: true,
        }),
      'CLASS_NOT_ALLOWED_IN_CONTEST',
      409,
    );
  });

  it('lets a class coach register an allowed class and enrolls only its students', () => {
    const { db, manager, alice, bob, carol } = setup();
    const contestId = makeContest(db);
    const classId = createClass(db, {
      name: 'Allowed',
      ownerId: manager,
      actorRole: 'contestmanager',
    });
    addClassCoach(db, { classId, actorId: manager, username: 'alice' });
    addClassMember(db, { classId, actorId: manager, username: 'bob' });
    addClassMember(db, { classId, actorId: manager, username: 'carol', role: 'assistant' });

    // A coach, not a captain, can register a class.
    registerTeamForContest(db, {
      contestId,
      teamId: classId,
      actorId: alice,
      isAdmin: false,
    });

    expect(getRegistrationRow(db, contestId, bob)).not.toBeNull();
    expect(getRegistrationRow(db, contestId, carol)).toBeNull();
    expect(getRegistrationRow(db, contestId, alice)).toBeNull();
    expect(getRegistrationRow(db, contestId, manager)).toBeNull();
  });

  it('still requires a captain to register an ordinary team', () => {
    const { db, alice, bob } = setup();
    const contestId = makeContest(db);
    const teamId = createTeam(db, { name: 'Alpha', ownerId: alice });
    expectContestTeamError(
      () =>
        registerTeamForContest(db, {
          contestId,
          teamId,
          actorId: bob,
          isAdmin: false,
        }),
      'TEAM_FORBIDDEN',
      403,
    );
  });
});
