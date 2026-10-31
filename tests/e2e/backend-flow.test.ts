import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/server/src/app.js';
import { loadConfig, ensureDataDirs } from '../../apps/server/src/config.js';
import { startScheduler, type SchedulerHandle } from '../../apps/server/src/judge/scheduler.js';
import { createHub } from '../../apps/server/src/realtime/hub.js';
import { ensureAdmin } from '../../apps/server/src/services/bootstrap.js';
import { importProblemDirectory } from '../../apps/server/src/services/problems.js';
import { addParticipant, createContest } from '../../apps/server/src/storage/repos/contests.js';
import { getSubmission } from '../../apps/server/src/storage/repos/submissions.js';
import { getUserByUsername } from '../../apps/server/src/storage/repos/users.js';
import { openDatabase } from '../../apps/server/src/storage/db.js';
import { migrate } from '../../apps/server/src/storage/migrate.js';

const dir = mkdtempSync(join(process.cwd(), 'native/runner/out', 'e2e-'));
const db = openDatabase(join(dir, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
let app: Awaited<ReturnType<typeof buildApp>>;
let scheduler: SchedulerHandle;
let problemId = 0;
let contestId = 0;

beforeAll(async () => {
  ensureDataDirs(dir);
  migrate(db);
  ensureAdmin(db, config);
  problemId = importProblemDirectory({
    db,
    config,
    sourceDir: join(process.cwd(), 'tools/seed/sample-problem'),
  });
  contestId = createContest(db, { name: 'E2E', problemIds: [problemId] });
  const admin = getUserByUsername(db, config.adminUsername)!;
  addParticipant(db, contestId, admin.id);
  const hub = createHub();
  app = await buildApp({ db, config, hub });
  scheduler = startScheduler({ db, config, events: hub, pollIntervalMs: 50 });
});

afterAll(async () => {
  await scheduler.stop();
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('backend e2e', () => {
  it('logs in, submits AC code and returns a correct ranking', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: config.adminUsername, password: config.adminPassword },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0];

    const submit = await app.inject({
      method: 'POST',
      url: '/api/submissions',
      headers: { cookie },
      payload: {
        problemId,
        contestId,
        language: 'cpp17',
        code: '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',
      },
    });
    expect(submit.statusCode).toBe(201);
    const submissionId = (submit.json() as { data: { id: number } }).data.id;

    let submission = getSubmission(db, submissionId);
    const deadline = Date.now() + 15_000;
    while (submission && submission.status !== 'finished' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      submission = getSubmission(db, submissionId);
    }
    expect(submission?.status).toBe('finished');
    expect(submission?.verdict).toBe('AC');
    expect(submission?.score).toBe(100);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/submissions/${submissionId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as {
      data: { code: string; results: Array<{ verdict: string }> };
    };
    expect(detailBody.data.code).toContain('cin');
    expect(detailBody.data.results).toHaveLength(2);

    const ranking = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/ranking`,
      headers: { cookie },
    });
    expect(ranking.statusCode).toBe(200);
    const rows = (ranking.json() as { data: Array<{ totalScore: number }> }).data;
    expect(rows[0].totalScore).toBe(100);
  }, 30_000);
});
