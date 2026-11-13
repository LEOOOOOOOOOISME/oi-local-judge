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

const root = mkdtempSync(join(tmpdir(), 'oij-rebuild-http-'));
const db: DatabaseSync = openDatabase(join(root, 'test.db'));
const config: Config = {
  ...loadConfig({ ...process.env, OIJ_DATA_DIR: root, OIJ_SESSION_SECRET: 'test-session-secret-0123456789-abcdef' }),
  dataDir: root,
};
let app: Awaited<ReturnType<typeof buildApp>>;

const cookies: Record<'admin' | 'setter' | 'student', string> = {
  admin: '',
  setter: '',
  student: '',
};
let adminId = 0;

function seedUser(
  username: string,
  role: 'admin' | 'setter' | 'contestant',
): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(`${username}123`),
    role,
  });
}

function countRows(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  adminId = seedUser('admin', 'admin');
  const setterId = seedUser('setter', 'setter');
  const studentId = seedUser('student', 'contestant');
  for (const [name, id] of [
    ['admin', adminId],
    ['setter', setterId],
    ['student', studentId],
  ] as const) {
    cookies[name] = `oij.sid=${signSession({ userId: id, version: 0 }, config.sessionSecret, 3600)}`;
  }
  const problem = createProblem(db, {
    title: 'Rebuilt',
    type: 'standard',
    tags: ['dp'],
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  const now = Date.now();
  db.prepare(
    `INSERT INTO submissions(problem_id, user_id, language, source_path, source_hash,
       status, verdict, score, created_at, judged_at, phase)
     VALUES (?, ?, 'cpp17', 'submissions/1/main.cpp', 'hash', 'finished', 'AC', 100, ?, ?, 'contest')`,
  ).run(problem, studentId, now, now);
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function rebuild(username: 'admin' | 'setter' | 'student' | 'anonymous') {
  return app.inject({
    method: 'POST',
    url: '/api/admin/system/learning-stats/rebuild',
    headers: username === 'anonymous' ? {} : { cookie: cookies[username] },
  });
}

describe('POST /api/admin/system/learning-stats/rebuild', () => {
  it('requires an admin session', async () => {
    const anonymous = await rebuild('anonymous');
    expect(anonymous.statusCode).toBe(401);
    expect((anonymous.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');

    for (const username of ['setter', 'student'] as const) {
      const response = await rebuild(username);
      expect(response.statusCode, `${username}: ${response.body}`).toBe(403);
      expect((response.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    }
    expect(countRows('student_problem_stats')).toBe(0);
  });

  it('rebuilds synchronously, reports row counts and records an audit entry', async () => {
    const response = await rebuild('admin');
    expect(response.statusCode, response.body).toBe(200);
    const data = (response.json() as {
      ok: true;
      data: {
        users: number;
        problems: number;
        tags: number;
        days: number;
        durationMs: number;
      };
    }).data;

    expect(data).toMatchObject({ users: 1, problems: 1, tags: 1, days: 1 });
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
    expect(countRows('student_problem_stats')).toBe(1);
    expect(countRows('student_tag_stats')).toBe(1);
    expect(countRows('student_daily_stats')).toBe(1);

    const audit = db
      .prepare("SELECT actor_id, detail_json FROM audit_logs WHERE action = 'learning_stats.rebuild'")
      .get() as { actor_id: number; detail_json: string } | undefined;
    expect(audit).toBeDefined();
    expect(audit?.actor_id).toBe(adminId);
    expect(JSON.parse(audit!.detail_json)).toMatchObject({
      users: 1,
      problems: 1,
      tags: 1,
      days: 1,
    });
  });

  it('is idempotent: a second rebuild replaces instead of duplicating cache rows', async () => {
    const response = await rebuild('admin');
    expect(response.statusCode, response.body).toBe(200);
    expect(countRows('student_problem_stats')).toBe(1);
    expect(countRows('student_tag_stats')).toBe(1);
    expect(countRows('student_daily_stats')).toBe(1);
  });
});
