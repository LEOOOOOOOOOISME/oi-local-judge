import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createContest, getContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-contests-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
let classAUser = 0;
let classBUser = 0;
let problemId = 0;

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  classAUser = createUser(db, {
    username: 'alice',
    passwordHash: hashPassword('alice123'),
    realName: 'Alice',
    className: '1班',
  });
  classBUser = createUser(db, {
    username: 'bob',
    passwordHash: hashPassword('bob123'),
    realName: 'Bob',
    className: '2班',
  });
  problemId = createProblem(db, {
    title: 'P1',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('admin contest management', () => {
  it('creates, updates, controls and reports class stats', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/contests',
      headers: { cookie },
      payload: { name: 'Admin Cup', problemIds: [problemId], participantIds: [classAUser, classBUser] },
    });
    expect(created.statusCode).toBe(201);
    const contestId = (created.json() as { data: { id: number } }).data.id;

    const update = await app.inject({
      method: 'PUT',
      url: `/api/admin/contests/${contestId}`,
      headers: { cookie },
      payload: {
        name: 'Admin Cup 2',
        startAt: 1000,
        endAt: 2000,
        freezeAt: 1500,
        problems: [{ problemId, points: 100 }],
      },
    });
    expect(update.statusCode).toBe(200);
    expect(getContest(db, contestId)?.name).toBe('Admin Cup 2');

    const participants = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/participants`,
      headers: { cookie },
    });
    expect((participants.json() as { data: unknown[] }).data).toHaveLength(2);

    for (const path of ['start', 'freeze', 'unfreeze', 'end']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/admin/contests/${contestId}/${path}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
    }

    const submission = createSubmission(db, {
      contestId,
      problemId,
      userId: classAUser,
      language: 'cpp17',
      sourcePath: 'x.cpp',
      sourceHash: 'h',
    });
    db.prepare('UPDATE submissions SET verdict = ?, score = ?, created_at = ? WHERE id = ?').run(
      'AC',
      100,
      1200,
      submission,
    );

    const stats = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/class-stats`,
      headers: { cookie },
    });
    expect(stats.statusCode).toBe(200);
    const rows = (stats.json() as { data: Array<{ className: string; averageScore: number }> }).data;
    expect(rows[0]).toMatchObject({ className: '1班', averageScore: 100 });
    expect(rows[1]).toMatchObject({ className: '2班', averageScore: 0 });
  });

  it('lists and creates users for participant pickers', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/users?query=alice',
      headers: { cookie },
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { data: unknown[] }).data).toHaveLength(1);
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: { cookie },
      payload: { username: 'carol', password: 'carol123', realName: 'Carol', className: '3班' },
    });
    expect(created.statusCode).toBe(201);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/admin/users/import',
      headers: { cookie },
      payload: {
        csv: '用户名,密码,姓名,班级,角色\ndan,dan123,Dan,1班,contestant\ncarol,carol123,Carol,3班,contestant',
      },
    });
    expect(imported.statusCode).toBe(200);
    const result = imported.json() as { data: { created: string[]; skipped: string[] } };
    expect(result.data.created).toEqual(['dan']);
    expect(result.data.skipped).toEqual(['carol']);
  });

  it('creates contest via helper for repo sanity', () => {
    const id = createContest(db, { name: 'Helper', problemIds: [problemId] });
    expect(getContest(db, id)?.name).toBe('Helper');
  });
});
