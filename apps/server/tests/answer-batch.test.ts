import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { startScheduler, type SchedulerHandle } from '../src/judge/scheduler.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'answer-batch-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let scheduler: SchedulerHandle;
let cookie = '';
let contestId = 0;
let problemId = 0;
let aliceId = 0;

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  aliceId = createUser(db, { username: 'alice', passwordHash: 'x' });
  problemId = createProblem(db, {
    title: 'Objective Batch',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    objective: {
      questions: [
        {
          id: 1,
          kind: 'single',
          stem: '1+1?',
          options: [
            { key: 'A', text: '1' },
            { key: 'B', text: '2' },
          ],
          answers: ['B'],
          points: 100,
        },
      ],
    },
    testcases: [],
  });
  contestId = createContest(db, {
    name: 'Answer Contest',
    mode: 'oi',
    problemIds: [problemId],
  });
  cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  app = await buildApp({ db, config });
  scheduler = startScheduler({ db, config, pollIntervalMs: 50 });
});

afterAll(async () => {
  await scheduler.stop();
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('answers.json contest batch', () => {
  it('judges objective answers from students/<id>/answers.json', async () => {
    const zip = zipSync({
      [`alice/${problemId}/answers.json`]: new TextEncoder().encode(
        JSON.stringify({ answers: [{ questionId: 1, value: ['B'] }] }),
      ),
    });
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/batches?studentLevel=1&problemLevel=2`,
      headers: { cookie, 'content-type': 'application/zip' },
      payload: Buffer.from(zip),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const batchId = (uploaded.json() as { data: { id: number } }).data.id;
    let status = '';
    for (let i = 0; i < 100; i++) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/admin/contests/${contestId}/batches/${batchId}`,
        headers: { cookie },
      });
      status = (response.json() as { data: { status: string } }).data.status;
      if (status === 'ready' || status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe('ready');

    const published = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/batches/${batchId}/publish`,
      headers: { cookie },
      payload: { mode: 'merge' },
    });
    expect(published.statusCode, published.body).toBe(200);

    const ranking = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking`,
    });
    const rows = (ranking.json() as { data: { rows: Array<{ userId: number; totalScore: number }> } })
      .data.rows;
    expect(rows.find((row) => row.userId === aliceId)?.totalScore).toBe(100);
  }, 30_000);
});
