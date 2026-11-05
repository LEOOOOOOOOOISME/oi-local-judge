import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signSession } from '../src/security/session.js';
import { submitSource, SUBMIT_COOLDOWN_MS } from '../src/services/submissions.js';
import { addParticipant, createContest } from '../src/storage/repos/contests.js';
import { createJudgeTask, recoverInterruptedJudgeTasks } from '../src/storage/repos/judge.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-lifecycle-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const userId = createUser(db, { username: 'alice', passwordHash: 'x' });
  const problemId = createProblem(db, {
    title: 'A+B',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  return { dir, db, config, userId, problemId };
}

type Ctx = ReturnType<typeof setup>;

function submit(
  ctx: Ctx,
  input: {
    userId?: number;
    problemId?: number;
    contestId?: number | null;
    now?: number;
    skipCooldown?: boolean;
    code?: string;
  } = {},
) {
  return submitSource(
    { db: ctx.db, config: ctx.config },
    {
      userId: input.userId ?? ctx.userId,
      problemId: input.problemId ?? ctx.problemId,
      language: 'cpp17',
      code: input.code ?? 'int main(){return 0;}',
      contestId: input.contestId ?? null,
      now: input.now,
      skipCooldown: input.skipCooldown,
    },
  );
}

function expectCooldown(fn: () => unknown, retryAfterSec: number) {
  try {
    fn();
    throw new Error('expected SubmissionRateLimitError');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    expect((err as { name?: string }).name).toBe('SubmissionRateLimitError');
    expect((err as { status?: number }).status).toBe(429);
    expect((err as { code?: string }).code).toBe('SUBMIT_COOLDOWN');
    expect((err as { retryAfterSec?: number }).retryAfterSec).toBe(retryAfterSec);
  }
}

describe('submission cooldown', () => {
  it('rejects a second submission inside the 10s window', () => {
    const ctx = setup();
    const T = 1_700_000_000_000;
    submit(ctx, { now: T });
    expectCooldown(() => submit(ctx, { now: T + 5_000 }), 5);
    ctx.db.close();
  });

  it('allows the next submission after 10s (injected clock)', () => {
    const ctx = setup();
    const T = 1_700_000_000_000;
    const first = submit(ctx, { now: T });
    const second = submit(ctx, { now: T + SUBMIT_COOLDOWN_MS });
    expect(second.id).not.toBe(first.id);
    ctx.db.close();
  });

  it('still rejects one millisecond before the window ends', () => {
    const ctx = setup();
    const T = 1_700_000_000_000;
    submit(ctx, { now: T });
    expectCooldown(() => submit(ctx, { now: T + SUBMIT_COOLDOWN_MS - 1 }), 1);
    ctx.db.close();
  });

  it('bypasses the cooldown when skipCooldown is set', () => {
    const ctx = setup();
    const T = 1_700_000_000_000;
    const first = submit(ctx, { now: T });
    const second = submit(ctx, { now: T + 100, skipCooldown: true });
    expect(second.id).not.toBe(first.id);
    ctx.db.close();
  });

  it('keys the cooldown by user, problem and contest (null is its own key)', () => {
    const ctx = setup();
    const T = 1_700_000_000_000;
    const contestId = createContest(ctx.db, {
      name: 'C',
      startAt: T - 100_000,
      endAt: T + 100_000,
      problemIds: [ctx.problemId],
    });
    addParticipant(ctx.db, contestId, ctx.userId);
    ctx.db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);

    submit(ctx, { now: T, contestId });
    // Same user/problem but practice (contestId null) is a different key.
    submit(ctx, { now: T + 1_000, contestId: null });
    // Same contest key still trips the cooldown.
    expectCooldown(() => submit(ctx, { now: T + 1_500, contestId }), 9);
    // Another user is a different key.
    const bob = createUser(ctx.db, { username: 'bob', passwordHash: 'x' });
    addParticipant(ctx.db, contestId, bob);
    submit(ctx, { userId: bob, now: T + 1_500, contestId });
    ctx.db.close();
  });
});

describe('startup recovery of interrupted judge tasks', () => {
  function createTaskSubmission(
    ctx: Ctx,
    status: string,
    options: { verdict?: string | null; score?: number } = {},
  ) {
    const id = createSubmission(ctx.db, {
      problemId: ctx.problemId,
      userId: ctx.userId,
      language: 'cpp17',
      sourcePath: `submissions/${status}-${Math.random().toString(36).slice(2)}.cpp`,
      sourceHash: status,
    });
    ctx.db
      .prepare(
        `UPDATE submissions SET status = ?, verdict = ?, score = ?, time_ms = ?,
           memory_kb = ?, judged_at = ? WHERE id = ?`,
      )
      .run(
        status,
        options.verdict ?? null,
        options.score ?? 0,
        0,
        0,
        status === 'finished' || status === 'failed' ? 1_000 : null,
        id,
      );
    return { submissionId: id, taskId: createJudgeTask(ctx.db, id, 50) };
  }

  it('requeues running/compiling tasks and leaves finished/failed work untouched', () => {
    const ctx = setup();
    const now = 1_700_000_000_000;

    const running = createTaskSubmission(ctx, 'running');
    const compiling = createTaskSubmission(ctx, 'compiling');
    const finished = createTaskSubmission(ctx, 'finished', { verdict: 'AC', score: 100 });
    const failed = createTaskSubmission(ctx, 'failed', { verdict: 'SE', score: 0 });

    ctx.db
      .prepare("UPDATE judge_tasks SET status = 'running', worker = 'worker-a', heartbeat_at = 1 WHERE id = ?")
      .run(running.taskId);
    ctx.db
      .prepare("UPDATE judge_tasks SET status = 'compiling', worker = 'worker-b', heartbeat_at = 1 WHERE id = ?")
      .run(compiling.taskId);
    ctx.db
      .prepare("UPDATE judge_tasks SET status = 'done', worker = 'worker-c', heartbeat_at = 1 WHERE id = ?")
      .run(finished.taskId);
    ctx.db
      .prepare("UPDATE judge_tasks SET status = 'failed', worker = 'worker-d', heartbeat_at = 1 WHERE id = ?")
      .run(failed.taskId);

    ctx.db
      .prepare(
        `INSERT INTO test_results(submission_id, testcase_id, verdict, time_ms, memory_kb, score, message)
         VALUES (?, 1, 'AC', 10, 100, 100, '')`,
      )
      .run(finished.submissionId);

    expect(recoverInterruptedJudgeTasks(ctx.db, now)).toBe(2);

    const tasks = ctx.db
      .prepare('SELECT id, status, worker, heartbeat_at FROM judge_tasks ORDER BY id')
      .all() as unknown as Array<{
      id: number;
      status: string;
      worker: string | null;
      heartbeat_at: number | null;
    }>;
    const byId = new Map(tasks.map((task) => [task.id, task]));
    expect(byId.get(running.taskId)).toMatchObject({
      status: 'queued',
      worker: null,
      heartbeat_at: now,
    });
    expect(byId.get(compiling.taskId)).toMatchObject({
      status: 'queued',
      worker: null,
      heartbeat_at: now,
    });
    expect(byId.get(finished.taskId)).toMatchObject({ status: 'done', worker: 'worker-c' });
    expect(byId.get(failed.taskId)).toMatchObject({ status: 'failed', worker: 'worker-d' });

    const submissions = ctx.db
      .prepare('SELECT id, status, verdict, score FROM submissions ORDER BY id')
      .all() as unknown as Array<{ id: number; status: string; verdict: string | null; score: number }>;
    const submissionById = new Map(submissions.map((row) => [row.id, row]));
    expect(submissionById.get(running.submissionId)?.status).toBe('queued');
    expect(submissionById.get(compiling.submissionId)?.status).toBe('queued');
    expect(submissionById.get(finished.submissionId)).toMatchObject({
      status: 'finished',
      verdict: 'AC',
      score: 100,
    });
    expect(submissionById.get(failed.submissionId)).toMatchObject({
      status: 'failed',
      verdict: 'SE',
      score: 0,
    });

    const results = ctx.db
      .prepare('SELECT submission_id, verdict, score FROM test_results')
      .all() as unknown as Array<{ submission_id: number; verdict: string; score: number }>;
    expect(results).toEqual([{ submission_id: finished.submissionId, verdict: 'AC', score: 100 }]);

    // Idempotent: a second recovery has nothing left to do.
    expect(recoverInterruptedJudgeTasks(ctx.db, now + 1)).toBe(0);
    ctx.db.close();
  });
});

describe('submission cooldown over HTTP', () => {
  it('responds 429 with SUBMIT_COOLDOWN and Retry-After', async () => {
    const ctx = setup();
    const cookie = `oij.sid=${signSession(
      { userId: ctx.userId, version: 0 },
      ctx.config.sessionSecret,
      3600,
    )}`;
    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      submit(ctx);
      const response = await app.inject({
        method: 'POST',
        url: '/api/submissions',
        headers: { cookie },
        payload: {
          problemId: ctx.problemId,
          language: 'cpp17',
          code: 'int main(){return 0;}',
        },
      });
      expect(response.statusCode).toBe(429);
      const retryAfter = Number(response.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      const body = response.json() as {
        ok: boolean;
        error: { code: string; retryAfterSec: number; message: string };
      };
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('SUBMIT_COOLDOWN');
      expect(body.error.retryAfterSec).toBe(retryAfter);
    } finally {
      await app.close();
      ctx.db.close();
    }
  });
});
