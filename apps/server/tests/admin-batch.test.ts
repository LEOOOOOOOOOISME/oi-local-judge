import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { startScheduler, type SchedulerHandle } from '../src/judge/scheduler.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { importProblemDirectory } from '../src/services/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-batch-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let scheduler: SchedulerHandle;
let cookie = '';
let problemId = 0;

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  problemId = importProblemDirectory({
    db,
    config,
    sourceDir: join(process.cwd(), 'tools/seed/sample-problem'),
  });
  app = await buildApp({ db, config });
  scheduler = startScheduler({ db, config, pollIntervalMs: 50 });
});

afterAll(async () => {
  await scheduler.stop();
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('local batch judging', () => {
  it('imports a zip, maps students, judges and reports results', async () => {
    const zip = zipSync({
      'Alice/main.cpp': new TextEncoder().encode(
        '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',
      ),
      'Bob/main.cpp': new TextEncoder().encode(
        '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}',
      ),
      'notes.txt': new TextEncoder().encode('ignored'),
    });
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/upload',
      headers: { cookie, 'content-type': 'application/zip' },
      payload: Buffer.from(zip),
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const uploadId = (uploaded.json() as { data: { uploadId: string } }).data.uploadId;

    const started = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/run',
      headers: { cookie },
      payload: { uploadId, problemId, studentLevel: 1 },
    });
    expect(started.statusCode, started.body).toBe(201);
    const batchId = (started.json() as { data: { id: number } }).data.id;

    let body: {
      data: {
        status: string;
        items: Array<{ student: string; verdict: string | null; score: number }>;
      };
    } | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/batch/${batchId}`,
        headers: { cookie },
      });
      body = res.json() as typeof body;
      if (body?.data.status === 'finished') break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(body?.data.status).toBe('finished');
    const alice = body?.data.items.find((item) => item.student === 'Alice');
    const bob = body?.data.items.find((item) => item.student === 'Bob');
    expect(alice?.verdict).toBe('AC');
    expect(alice?.score).toBe(100);
    expect(bob?.verdict).toBe('WA');
  }, 40_000);
});
