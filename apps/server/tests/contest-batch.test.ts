import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyOfficialMode } from '../src/http/admin-contest-batch.js';
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

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'contest-batch-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let scheduler: SchedulerHandle;
let cookie = '';
let contestId = 0;
let plusId = 0;
let minusId = 0;
let aliceId = 0;
let bobId = 0;
let daveId = 0;

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  aliceId = createUser(db, { username: 'alice', passwordHash: 'x', realName: 'Alice' });
  bobId = createUser(db, { username: 'bob', passwordHash: 'x', realName: 'Bob' });
  daveId = createUser(db, { username: 'dave', passwordHash: 'x', realName: 'Dave' });
  mkdirSync(join(root, 'p1'), { recursive: true });
  writeFileSync(join(root, 'p1', '1.in'), '1 2\n');
  writeFileSync(join(root, 'p1', '1.out'), '3\n');
  plusId = createProblem(db, {
    title: 'Plus',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: 'p1/1.in', outputPath: 'p1/1.out', points: 100 }],
  });
  mkdirSync(join(root, 'p2'), { recursive: true });
  writeFileSync(join(root, 'p2', '1.in'), '5 2\n');
  writeFileSync(join(root, 'p2', '1.out'), '3\n');
  minusId = createProblem(db, {
    title: 'Minus',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: 'p2/1.in', outputPath: 'p2/1.out', points: 100 }],
  });
  contestId = createContest(db, {
    name: 'Batch Contest',
    mode: 'oi',
    startAt: 0,
    endAt: 100 * 60_000,
    problemIds: [plusId, minusId],
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

const plusCode =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}';
const minusCode =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a-b<<"\\n";}';
const wrongCode =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}';

async function uploadBatch(files: Record<string, Uint8Array>) {
  const zip = zipSync(files);
  return app.inject({
    method: 'POST',
    url: `/api/admin/contests/${contestId}/batches?studentLevel=1&problemLevel=2`,
    headers: { cookie, 'content-type': 'application/zip' },
    payload: Buffer.from(zip),
  });
}

async function waitReady(batchId: number) {
  let body: { data: { status: string } } | null = null;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/batches/${batchId}`,
      headers: { cookie },
    });
    body = response.json() as typeof body;
    if (body?.data.status === 'ready' || body?.data.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return body;
}
describe('official score batch modes', () => {
  it('overwrites, merges and fills per cell', () => {
    expect(applyOfficialMode('overwrite', { score: 100, verdict: 'AC' }, 40)).toBe(40);
    expect(applyOfficialMode('merge', { score: 100, verdict: 'AC' }, 40)).toBe(100);
    expect(applyOfficialMode('merge', { score: 40, verdict: 'PC' }, 100)).toBe(100);
    expect(applyOfficialMode('fill', { score: 100, verdict: 'AC' }, 40)).toBe(100);
    expect(applyOfficialMode('fill', null, 40)).toBe(40);
  });
});

describe('contest batch draft/preview/publish', () => {
  it('drafts, previews and publishes multi-problem scores', async () => {
    const uploaded = await uploadBatch({
      [`alice/${plusId}/main.cpp`]: new TextEncoder().encode(plusCode),
      [`alice/${minusId}/main.cpp`]: new TextEncoder().encode(minusCode),
      [`bob/${plusId}/main.cpp`]: new TextEncoder().encode(wrongCode),
      [`Unknown/${plusId}/main.cpp`]: new TextEncoder().encode(plusCode),
      [`alice/not-a-problem/main.cpp`]: new TextEncoder().encode(plusCode),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const uploadData = uploaded.json() as {
      data: { id: number; count: number; unknownUsers: string[]; unresolvedProblems: string[] };
    };
    expect(uploadData.data.count).toBe(3);
    expect(uploadData.data.unknownUsers).toContain('Unknown');
    expect(uploadData.data.unresolvedProblems).toContain('not-a-problem');

    const batchId = uploadData.data.id;
    const ready = await waitReady(batchId);
    expect(ready?.data.status).toBe('ready');

    const preview = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/batches/${batchId}/preview`,
      headers: { cookie },
      payload: { mode: 'merge' },
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const previewRows = (preview.json() as { data: { rows: Array<{ afterScore: number }> } }).data
      .rows;
    expect(previewRows.reduce((sum, row) => sum + row.afterScore, 0)).toBe(200);

    const published = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/batches/${batchId}/publish`,
      headers: { cookie },
      payload: { mode: 'merge' },
    });
    expect(published.statusCode, published.body).toBe(200);
    expect((published.json() as { data: { published: number } }).data.published).toBe(3);

    const ranking = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking`,
    });
    expect(ranking.statusCode).toBe(200);
    const rows = (ranking.json() as {
      data: { rows: Array<{ userId: number; totalScore: number }> };
    }).data.rows;
    expect(rows.find((row) => row.userId === aliceId)?.totalScore).toBe(200);
    expect(rows.find((row) => row.userId === bobId)?.totalScore).toBe(0);

    const participants = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/participants`,
      headers: { cookie },
    });
    expect(participants.json() as { data: unknown[] }).toBeTruthy();
    const participantRows = (
      participants.json() as { data: Array<{ user_id: number }> }
    ).data;
    expect(participantRows.some((row) => row.user_id === aliceId)).toBe(true);
    expect(participantRows.some((row) => row.user_id === bobId)).toBe(true);
  }, 45_000);

  it('imports a roster, hides a participant and archives the contest', async () => {
    const imported = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/participants/import`,
      headers: { cookie },
      payload: { csv: 'username\nalice\ndave\nnobody\n' },
    });
    expect(imported.statusCode, imported.body).toBe(200);
    expect((imported.json() as { data: { added: string[]; skipped: string[]; unknown: string[] } }).data).toEqual({
      added: ['dave'],
      skipped: ['alice'],
      unknown: ['nobody'],
    });

    const hidden = await app.inject({
      method: 'PATCH',
      url: `/api/admin/contests/${contestId}/participants/${daveId}`,
      headers: { cookie },
      payload: { hidden: true },
    });
    expect(hidden.statusCode).toBe(200);
    const ranking = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking`,
    });
    expect(
      (ranking.json() as { data: { rows: Array<{ userId: number }> } }).data.rows.some(
        (row) => row.userId === daveId,
      ),
    ).toBe(false);

    const archived = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/archive`,
      headers: { cookie },
    });
    expect(archived.statusCode).toBe(200);
    const after = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/official-ranking`,
    });
    expect((after.json() as { data: { archived: boolean } }).data.archived).toBe(true);
  });
});
