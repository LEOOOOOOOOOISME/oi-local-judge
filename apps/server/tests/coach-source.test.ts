import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { submitSource } from '../src/services/submissions.js';
import {
  addClassCoach,
  addClassMember,
  addTeamMember,
  createClass,
  createTeam,
} from '../src/services/teams.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(tmpdir(), 'oij-coach-source-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;

type Username =
  | 'admin'
  | 'setter'
  | 'manager'
  | 'alice'
  | 'bob'
  | 'carol'
  | 'dave'
  | 'erin';

const ids: Record<Username, number> = {
  admin: 0,
  setter: 0,
  manager: 0,
  alice: 0,
  bob: 0,
  carol: 0,
  dave: 0,
  erin: 0,
};
const cookies: Record<string, string> = {};

const source = 'int main() { return 0; } // coach source review';

let problemId = 0;
let classA = 0;
let classB = 0;
let bobFirst = 0;
let bobSecond = 0;
let bobThird = 0;
let carolSubmission = 0;
let erinSubmission = 0;

interface DetailBody {
  ok: true;
  data: {
    id: number;
    userId: number;
    code?: string;
  };
}

interface ListBody {
  ok: true;
  data: Array<Record<string, unknown>>;
}

function seedUser(username: Username, role: 'admin' | 'setter' | 'contestmanager' | 'contestant') {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

function submitFor(userId: number): number {
  return submitSource(
    { db, config },
    {
      userId,
      problemId,
      language: 'cpp17',
      code: source,
      skipCooldown: true,
      now: Date.now(),
    },
  ).id;
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  ids.admin = seedUser('admin', 'admin');
  ids.setter = seedUser('setter', 'setter');
  ids.manager = seedUser('manager', 'contestmanager');
  ids.alice = seedUser('alice', 'contestant');
  ids.bob = seedUser('bob', 'contestant');
  ids.carol = seedUser('carol', 'contestant');
  ids.dave = seedUser('dave', 'contestant');
  ids.erin = seedUser('erin', 'contestant');
  for (const [name, id] of Object.entries(ids)) {
    cookies[name] = `oij.sid=${signSession({ userId: id, version: 0 }, config.sessionSecret, 3600)}`;
  }

  problemId = createProblem(db, {
    title: 'Coach Source Problem',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });

  // Class A: manager owns it, alice coaches, bob is a student.
  classA = createClass(db, {
    name: 'Coach Source Class A',
    ownerId: ids.manager,
    actorRole: 'contestmanager',
  });
  addClassCoach(db, { classId: classA, actorId: ids.manager, username: 'alice' });
  addClassMember(db, { classId: classA, actorId: ids.manager, username: 'bob' });
  // Class B: dave owns/coaches it, carol is a student. Alice does not teach it.
  classB = createClass(db, {
    name: 'Coach Source Class B',
    ownerId: ids.dave,
    actorRole: 'contestmanager',
  });
  addClassMember(db, { classId: classB, actorId: ids.dave, username: 'carol' });

  // Team: bob is the captain, carol is a member.
  const teamId = createTeam(db, { name: 'Coach Source Team', ownerId: ids.bob });
  addTeamMember(db, { teamId, actorId: ids.bob, username: 'carol' });

  bobFirst = submitFor(ids.bob);
  bobSecond = submitFor(ids.bob);
  bobThird = submitFor(ids.bob);
  carolSubmission = submitFor(ids.carol);
  erinSubmission = submitFor(ids.erin);

  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function api(method: 'GET', url: string, username: Username | null) {
  return app.inject({
    method,
    url,
    headers: username ? { cookie: cookies[username] } : {},
  });
}

function errorCode(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

function auditRows(targetId: number) {
  return db
    .prepare(
      `SELECT actor_id, action, target_type, target_id, detail_json
       FROM audit_logs WHERE target_id = ? ORDER BY id`,
    )
    .all(String(targetId)) as unknown as Array<{
    actor_id: number | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    detail_json: string;
  }>;
}

describe('coach source review', () => {
  it('lets a class coach read a student in their class and rejects other classes', async () => {
    const own = await api('GET', `/api/submissions/${bobFirst}`, 'alice');
    expect(own.statusCode, own.body).toBe(200);
    const body = own.json() as DetailBody;
    expect(body.data.userId).toBe(ids.bob);
    expect(body.data.code).toBe(source);

    const otherClass = await api('GET', `/api/submissions/${carolSubmission}`, 'alice');
    expect(otherClass.statusCode).toBe(403);
    expect(errorCode(otherClass.json())).toBe('FORBIDDEN');

    const outsider = await api('GET', `/api/submissions/${bobFirst}`, 'erin');
    expect(outsider.statusCode).toBe(403);
  });

  it('lets a team captain read members and rejects an ordinary member', async () => {
    const captain = await api('GET', `/api/submissions/${carolSubmission}`, 'bob');
    expect(captain.statusCode, captain.body).toBe(200);
    expect((captain.json() as DetailBody).data.code).toBe(source);

    const member = await api('GET', `/api/submissions/${bobFirst}`, 'carol');
    expect(member.statusCode).toBe(403);
  });

  it('lets a class owner read their students', async () => {
    const owner = await api('GET', `/api/submissions/${carolSubmission}`, 'dave');
    expect(owner.statusCode, owner.body).toBe(200);
  });

  it('lets self and staff read any submission', async () => {
    for (const username of ['admin', 'setter', 'manager'] as const) {
      const response = await api('GET', `/api/submissions/${carolSubmission}`, username);
      expect(response.statusCode, `${username}: ${response.body}`).toBe(200);
    }
    const self = await api('GET', `/api/submissions/${bobSecond}`, 'bob');
    expect(self.statusCode, self.body).toBe(200);
  });

  it('audits every non-self source view exactly once and never self views', async () => {
    const target = bobThird;
    // Self view first: nothing may be written for it.
    const self = await api('GET', `/api/submissions/${target}`, 'bob');
    expect(self.statusCode, self.body).toBe(200);
    expect(auditRows(target)).toHaveLength(0);

    const coach = await api('GET', `/api/submissions/${target}`, 'alice');
    expect(coach.statusCode, coach.body).toBe(200);
    const afterCoach = auditRows(target);
    expect(afterCoach).toHaveLength(1);
    expect(afterCoach[0]).toMatchObject({
      actor_id: ids.alice,
      action: 'submission.source_view',
      target_type: 'submission',
      target_id: String(target),
    });
    expect(JSON.parse(afterCoach[0]!.detail_json)).toEqual({
      targetUserId: ids.bob,
      viewerId: ids.alice,
    });

    const admin = await api('GET', `/api/submissions/${target}`, 'admin');
    expect(admin.statusCode, admin.body).toBe(200);
    expect(auditRows(target)).toHaveLength(2);

    // A forbidden read must not write an audit row either.
    const forbidden = await api('GET', `/api/submissions/${target}`, 'carol');
    expect(forbidden.statusCode).toBe(403);
    expect(auditRows(target)).toHaveLength(2);
  });

  it('does not audit an unreadable source file', async () => {
    const created = db
      .prepare(
        `INSERT INTO submissions(problem_id, user_id, language, source_path, source_hash,
           status, verdict, score, created_at, phase)
         VALUES (?, ?, 'cpp17', 'submissions/missing/main.cpp', 'hash', 'finished', 'AC', 100, ?, 'practice')`,
      )
      .run(problemId, ids.erin, Date.now());
    const missingSourceId = Number(created.lastInsertRowid);

    const response = await api('GET', `/api/submissions/${missingSourceId}`, 'admin');
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as DetailBody).data.code).toBe('');
    expect(auditRows(missingSourceId)).toHaveLength(0);
  });

  it('lists a student submission summary for their coach without source code', async () => {
    const response = await api('GET', `/api/students/${ids.bob}/submissions`, 'alice');
    expect(response.statusCode, response.body).toBe(200);
    const rows = (response.json() as ListBody).data;
    expect(rows.map((row) => row.id)).toEqual([bobThird, bobSecond, bobFirst]);
    expect(rows[0]).toMatchObject({
      id: bobThird,
      problemId,
      contestId: null,
      status: 'queued',
      score: 0,
      createdAt: expect.any(String),
    });
    for (const row of rows) {
      expect(row).not.toHaveProperty('code');
    }

    const forbidden = await api('GET', `/api/students/${ids.carol}/submissions`, 'alice');
    expect(forbidden.statusCode).toBe(403);
    expect(errorCode(forbidden.json())).toBe('STUDENT_FORBIDDEN');

    const outsider = await api('GET', `/api/students/${ids.bob}/submissions`, 'erin');
    expect(outsider.statusCode).toBe(403);

    const missing = await api('GET', '/api/students/999999/submissions', 'admin');
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.json())).toBe('STUDENT_NOT_FOUND');
  });

  it('lets staff and the student themself list submissions', async () => {
    for (const username of ['admin', 'setter', 'manager', 'bob'] as const) {
      const response = await api('GET', `/api/students/${ids.bob}/submissions`, username);
      expect(response.statusCode, `${username}: ${response.body}`).toBe(200);
    }
  });

  it('paginates with limit and beforeId and validates both', async () => {
    const firstPage = await api(
      'GET',
      `/api/students/${ids.bob}/submissions?limit=2`,
      'bob',
    );
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect((firstPage.json() as ListBody).data.map((row) => row.id)).toEqual([
      bobThird,
      bobSecond,
    ]);

    const older = await api(
      'GET',
      `/api/students/${ids.bob}/submissions?limit=2&beforeId=${bobSecond}`,
      'bob',
    );
    expect(older.statusCode, older.body).toBe(200);
    expect((older.json() as ListBody).data.map((row) => row.id)).toEqual([bobFirst]);

    for (const query of ['limit=0', 'limit=101', 'limit=nope', 'beforeId=0']) {
      const invalid = await api('GET', `/api/students/${ids.bob}/submissions?${query}`, 'bob');
      expect(invalid.statusCode, query).toBe(400);
      expect(errorCode(invalid.json())).toBe('BAD_REQUEST');
    }
  });

  it('does not audit submission listing', async () => {
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'submission.source_view'")
      .get() as unknown as { n: number };
    const response = await api('GET', `/api/students/${ids.bob}/submissions`, 'alice');
    expect(response.statusCode, response.body).toBe(200);
    const after = db
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'submission.source_view'")
      .get() as unknown as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('keeps unrelated submissions private to their owners', async () => {
    const owner = await api('GET', `/api/submissions/${erinSubmission}`, 'erin');
    expect(owner.statusCode, owner.body).toBe(200);
    const coach = await api('GET', `/api/submissions/${erinSubmission}`, 'alice');
    expect(coach.statusCode).toBe(403);
  });
});
