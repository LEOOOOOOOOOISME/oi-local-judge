import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { detectGxx, ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import {
  abortSubmission,
  isCancellationAborted,
  registerCancellation,
  releaseCancellation,
} from '../src/judge/cancellation.js';
import { startScheduler } from '../src/judge/scheduler.js';
import { signSession } from '../src/security/session.js';
import {
  cancelSubmission,
  rejudgeSubmission,
  SubmissionCancelForbiddenError,
  SubmissionCannotCancelError,
  submitSource,
} from '../src/services/submissions.js';
import { createJudgeTask, recoverInterruptedJudgeTasks } from '../src/storage/repos/judge.js';
import { createProblem } from '../src/storage/repos/problems.js';
import {
  createSubmission,
  getSubmission,
  getTestResults,
} from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const workspaceRunnerDir = join(process.cwd(), 'native/runner/out');

const SLEEP_SOURCE = [
  '#include <windows.h>',
  'int main() {',
  '  Sleep(30000);',
  '  return 0;',
  '}',
  '',
].join('\n');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function removeDirWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // A terminated native process can keep its image locked for a moment.
      const buffer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buffer, 0, 0, 100);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

interface Ctx {
  dir: string;
  db: DatabaseSync;
  config: Config;
  userId: number;
  problemId: number;
}

const contexts: Ctx[] = [];

afterEach(() => {
  for (const ctx of contexts.splice(0)) {
    try {
      ctx.db.close();
    } catch {
      // already closed by the test
    }
    removeDirWithRetry(ctx.dir);
  }
});

function setup(): Ctx {
  mkdirSync(workspaceRunnerDir, { recursive: true });
  const dir = mkdtempSync(join(workspaceRunnerDir, 'cancel-'));
  ensureDataDirs(dir);
  const db = openDatabase(join(dir, 'db', 'test.db'));
  migrate(db);
  const config: Config = {
    ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }),
    dataDir: dir,
    gxx: detectGxx(),
  };
  const userId = createUser(db, { username: 'alice', passwordHash: 'x' });
  const problemId = createProblem(db, {
    title: 'Sleep',
    type: 'standard',
    timeMs: 20_000,
    memoryMb: 64,
    testcases: [{ inputPath: 'problems/p1/1.in', outputPath: 'problems/p1/1.out', points: 100 }],
  });
  mkdirSync(join(dir, 'problems', 'p1'), { recursive: true });
  writeFileSync(join(dir, 'problems', 'p1', '1.in'), '0\n');
  writeFileSync(join(dir, 'problems', 'p1', '1.out'), '0\n');
  const ctx = { dir, db, config, userId, problemId };
  contexts.push(ctx);
  return ctx;
}

function submitSleep(ctx: Ctx): number {
  return submitSource(
    { db: ctx.db, config: ctx.config },
    {
      userId: ctx.userId,
      problemId: ctx.problemId,
      language: 'cpp17',
      code: SLEEP_SOURCE,
      contestId: null,
      skipCooldown: true,
    },
  ).id;
}

function taskStatus(ctx: Ctx, submissionId: number): string | undefined {
  const row = ctx.db
    .prepare('SELECT status FROM judge_tasks WHERE submission_id = ?')
    .get(submissionId) as unknown as { status: string } | undefined;
  return row?.status;
}

function cookieFor(ctx: Ctx, userId: number): string {
  return `oij.sid=${signSession({ userId, version: 0 }, ctx.config.sessionSecret, 3600)}`;
}

function createRoleUser(ctx: Ctx, role: 'admin' | 'setter' | 'contestmanager' | 'contestant') {
  const id = createUser(ctx.db, {
    username: `${role}-${Math.random().toString(36).slice(2, 8)}`,
    passwordHash: 'x',
    role,
  });
  return { id, role, cookie: cookieFor(ctx, id) };
}

/** Seeds a submission already in a terminal judged state, as rejudge tests do. */
function seedFinishedSubmission(ctx: Ctx): { submissionId: number; taskId: number } {
  const submissionId = createSubmission(ctx.db, {
    problemId: ctx.problemId,
    userId: ctx.userId,
    language: 'cpp17',
    sourcePath: join('submissions', `seed-${Math.random().toString(36).slice(2)}.cpp`),
    sourceHash: 'seed',
  });
  ctx.db
    .prepare(
      `UPDATE submissions SET status = 'finished', verdict = 'AC', score = 100, time_ms = 12,
         memory_kb = 2048, message = '', judged_at = ? WHERE id = ?`,
    )
    .run(1_700_000_000_000, submissionId);
  const taskId = createJudgeTask(ctx.db, submissionId);
  ctx.db.prepare("UPDATE judge_tasks SET status = 'done' WHERE id = ?").run(taskId);
  return { submissionId, taskId };
}

async function cancelOverHttp(
  ctx: Ctx,
  id: number,
  role: 'admin' | 'setter' | 'contestmanager' | 'contestant' | 'anonymous',
) {
  const app = await buildApp({ db: ctx.db, config: ctx.config });
  try {
    const cookie = role === 'anonymous' ? undefined : createRoleUser(ctx, role).cookie;
    return await app.inject({
      method: 'POST',
      url: `/api/admin/submissions/${id}/cancel`,
      headers: cookie ? { cookie } : {},
    });
  } finally {
    await app.close();
  }
}

describe('cancellation registry', () => {
  it('registers idempotently, aborts once and releases without leaking', () => {
    const submissionId = 987_654;
    const first = registerCancellation(submissionId);
    expect(registerCancellation(submissionId)).toBe(first);
    expect(isCancellationAborted(submissionId)).toBe(false);

    expect(abortSubmission(submissionId)).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(isCancellationAborted(submissionId)).toBe(true);
    // Aborting again is still successful and does not throw.
    expect(abortSubmission(submissionId)).toBe(true);

    releaseCancellation(submissionId);
    expect(abortSubmission(submissionId)).toBe(false);
    expect(isCancellationAborted(submissionId)).toBe(false);
  });
});

describe('cancel queued submission', () => {
  it('cancels the queued task without touching a runner', () => {
    const ctx = setup();
    const submissionId = submitSleep(ctx);
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('queued');

    const admin = createRoleUser(ctx, 'admin');
    const result = cancelSubmission(ctx.db, submissionId, admin);
    expect(result).toMatchObject({ id: submissionId, status: 'canceled' });

    const submission = getSubmission(ctx.db, submissionId)!;
    expect(submission.status).toBe('canceled');
    expect(submission.verdict).toBeNull();
    expect(submission.score).toBe(0);
    expect(submission.judged_at).not.toBeNull();
    expect(getTestResults(ctx.db, submissionId)).toEqual([]);
    expect(taskStatus(ctx, submissionId)).toBe('canceled');
  });

  it('rejects finished submissions with CANNOT_CANCEL and a missing id with 404', async () => {
    const ctx = setup();
    const { submissionId } = seedFinishedSubmission(ctx);

    const finished = await cancelOverHttp(ctx, submissionId, 'admin');
    expect(finished.statusCode).toBe(409);
    const body = finished.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('CANNOT_CANCEL');
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('finished');

    const missing = await cancelOverHttp(ctx, 999_999, 'admin');
    expect(missing.statusCode).toBe(404);
  });

  it('rejects a contestant with 403 (route and service) without changing state', async () => {
    const ctx = setup();
    const submissionId = submitSleep(ctx);

    const response = await cancelOverHttp(ctx, submissionId, 'contestant');
    expect(response.statusCode).toBe(403);
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('queued');
    expect(taskStatus(ctx, submissionId)).toBe('queued');

    const contestant = createRoleUser(ctx, 'contestant');
    expect(() => cancelSubmission(ctx.db, submissionId, contestant)).toThrow(
      SubmissionCancelForbiddenError,
    );

    const anonymous = await cancelOverHttp(ctx, submissionId, 'anonymous');
    expect(anonymous.statusCode).toBe(401);
  });

  it('allows admin, setter and contestmanager to cancel over HTTP', async () => {
    for (const role of ['admin', 'setter', 'contestmanager'] as const) {
      const ctx = setup();
      const submissionId = submitSleep(ctx);
      const response = await cancelOverHttp(ctx, submissionId, role);
      expect(response.statusCode, role).toBe(200);
      const body = response.json() as {
        ok: boolean;
        data: { id: number; status: string; taskId: number | null };
      };
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({ id: submissionId, status: 'canceled' });
      expect(getSubmission(ctx.db, submissionId)!.status).toBe('canceled');
      expect(taskStatus(ctx, submissionId)).toBe('canceled');
    }
  });

  it('can be re-enqueued by a rejudge after cancellation', () => {
    const ctx = setup();
    const submissionId = submitSleep(ctx);
    const admin = createRoleUser(ctx, 'admin');

    expect(cancelSubmission(ctx.db, submissionId, admin)?.status).toBe('canceled');

    const rejudged = rejudgeSubmission(ctx.db, submissionId);
    expect(rejudged?.id).toBe(submissionId);
    const submission = getSubmission(ctx.db, submissionId)!;
    expect(submission.status).toBe('queued');
    expect(submission.verdict).toBeNull();
    expect(taskStatus(ctx, submissionId)).toBe('queued');
  });
});

describe('cancel running submission', () => {
  it('aborts the sandboxed runner quickly and finishes as canceled', async () => {
    const ctx = setup();
    const submissionId = submitSleep(ctx);
    const scheduler = startScheduler({ db: ctx.db, config: ctx.config, pollIntervalMs: 20 });
    try {
      await waitFor(
        () => getSubmission(ctx.db, submissionId)?.status === 'running',
        30_000,
        'submission to start running',
      );

      const admin = createRoleUser(ctx, 'admin');
      const startedAt = Date.now();
      const result = cancelSubmission(ctx.db, submissionId, admin);
      expect(result?.status).toBe('canceled');

      await waitFor(
        () => {
          const submission = getSubmission(ctx.db, submissionId);
          return submission?.status === 'canceled' && taskStatus(ctx, submissionId) === 'canceled';
        },
        10_000,
        'canceled submission and task',
      );
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(5_000);

      const submission = getSubmission(ctx.db, submissionId)!;
      expect(submission.status).toBe('canceled');
      expect(submission.verdict).toBeNull();
      expect(submission.score).toBe(0);
      expect(getTestResults(ctx.db, submissionId)).toEqual([]);
      expect(taskStatus(ctx, submissionId)).toBe('canceled');
    } finally {
      await scheduler.stop();
    }

    // The registry entry is released once the scheduler task settles.
    expect(isCancellationAborted(submissionId)).toBe(false);

    // A canceled submission can be re-enqueued afterwards.
    expect(rejudgeSubmission(ctx.db, submissionId)?.id).toBe(submissionId);
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('queued');
    expect(taskStatus(ctx, submissionId)).toBe('queued');
  }, 60_000);

  it('raises CANNOT_CANCEL for an already finished submission', () => {
    const ctx = setup();
    const { submissionId } = seedFinishedSubmission(ctx);
    const admin = createRoleUser(ctx, 'admin');
    expect(() => cancelSubmission(ctx.db, submissionId, admin)).toThrow(
      SubmissionCannotCancelError,
    );
  });
});

describe('cancellation crash recovery', () => {
  it('closes an orphaned running task instead of resurrecting a canceled submission', () => {
    const ctx = setup();
    const submissionId = submitSleep(ctx);
    // Simulate a crash after the cancel service wrote `canceled` but before the
    // scheduler finished the task bookkeeping.
    ctx.db
      .prepare("UPDATE submissions SET status = 'canceled' WHERE id = ?")
      .run(submissionId);
    ctx.db
      .prepare("UPDATE judge_tasks SET status = 'running', worker = 'dead-worker' WHERE submission_id = ?")
      .run(submissionId);

    expect(recoverInterruptedJudgeTasks(ctx.db)).toBe(1);
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('canceled');
    expect(taskStatus(ctx, submissionId)).toBe('canceled');
  });
});
