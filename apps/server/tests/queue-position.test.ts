import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { signSession } from '../src/security/session.js';
import { getSubmissionDetail } from '../src/services/submissions.js';
import { claimNextTask, createJudgeTask, getQueuePosition } from '../src/storage/repos/judge.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

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
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

let sequence = 0;

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'oij-queue-'));
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const config: Config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const userId = createUser(db, { username: 'alice', passwordHash: 'x' });
  const problemId = createProblem(db, {
    title: 'A+B',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  const ctx = { dir, db, config, userId, problemId };
  contexts.push(ctx);
  return ctx;
}

/** Seeds a submission with a queued judge task; returns the submission id. */
function seedQueued(ctx: Ctx, priority = 50, userId = ctx.userId): number {
  const submissionId = createSubmission(ctx.db, {
    problemId: ctx.problemId,
    userId,
    language: 'cpp17',
    sourcePath: `submissions/seed-${sequence++}.cpp`,
    sourceHash: `hash-${sequence}`,
  });
  createJudgeTask(ctx.db, submissionId, priority);
  return submissionId;
}

function setTaskStatus(ctx: Ctx, submissionId: number, status: string): void {
  ctx.db
    .prepare('UPDATE judge_tasks SET status = ? WHERE submission_id = ?')
    .run(status, submissionId);
}

function setSubmissionStatus(ctx: Ctx, submissionId: number, status: string): void {
  ctx.db.prepare('UPDATE submissions SET status = ? WHERE id = ?').run(status, submissionId);
}

function cookieFor(ctx: Ctx, userId: number): string {
  return `oij.sid=${signSession({ userId, version: 0 }, ctx.config.sessionSecret, 3600)}`;
}

function createRoleUser(ctx: Ctx, role: 'admin' | 'contestant') {
  const id = createUser(ctx.db, {
    username: `${role}-${Math.random().toString(36).slice(2, 8)}`,
    passwordHash: 'x',
    role,
  });
  return { id, cookie: cookieFor(ctx, id) };
}

describe('queue position query', () => {
  it('numbers queued tasks in claim order (priority DESC, id ASC)', () => {
    const ctx = setup();
    const normalFirst = seedQueued(ctx, 50);
    const urgent = seedQueued(ctx, 100);
    const normalSecond = seedQueued(ctx, 50);
    const low = seedQueued(ctx, 10);

    // Same order as claimNextTask: priority 100, then priority 50 by id, then 10.
    expect(getQueuePosition(ctx.db, urgent)).toBe(1);
    expect(getQueuePosition(ctx.db, normalFirst)).toBe(2);
    expect(getQueuePosition(ctx.db, normalSecond)).toBe(3);
    expect(getQueuePosition(ctx.db, low)).toBe(4);

    // Positions are mirrored in the submission detail DTO.
    expect(getSubmissionDetail(ctx.db, urgent)!.queuePosition).toBe(1);
    expect(getSubmissionDetail(ctx.db, normalFirst)!.queuePosition).toBe(2);
    expect(getSubmissionDetail(ctx.db, normalSecond)!.queuePosition).toBe(3);
    expect(getSubmissionDetail(ctx.db, low)!.queuePosition).toBe(4);
  });

  it('shifts positions when the head of the queue is claimed', () => {
    const ctx = setup();
    const first = seedQueued(ctx, 50);
    const second = seedQueued(ctx, 50);
    const third = seedQueued(ctx, 50);

    const claimed = claimNextTask(ctx.db, 'worker-1');
    expect(claimed?.submission_id).toBe(first);

    expect(getQueuePosition(ctx.db, first)).toBeNull();
    expect(getQueuePosition(ctx.db, second)).toBe(1);
    expect(getQueuePosition(ctx.db, third)).toBe(2);
    // The claimed submission is running, so its detail reports no position.
    expect(getSubmissionDetail(ctx.db, first)!.queuePosition).toBeNull();
  });

  it('returns null for every non-queued submission state', () => {
    const ctx = setup();
    const states: Array<{ submission: string; task: string }> = [
      { submission: 'running', task: 'running' },
      { submission: 'compiling', task: 'compiling' },
      { submission: 'finished', task: 'done' },
      { submission: 'failed', task: 'failed' },
      { submission: 'canceled', task: 'canceled' },
    ];

    for (const state of states) {
      const submissionId = seedQueued(ctx, 50);
      setSubmissionStatus(ctx, submissionId, state.submission);
      setTaskStatus(ctx, submissionId, state.task);
      expect(getQueuePosition(ctx.db, submissionId), state.submission).toBeNull();
      expect(getSubmissionDetail(ctx.db, submissionId)!.queuePosition, state.submission).toBeNull();
    }
  });

  it('returns null when the submission is no longer queued even if its task is', () => {
    const ctx = setup();
    const submissionId = seedQueued(ctx, 50);
    // Short window after a cancel/rejudge: the submission left the queue but
    // the task row has not been rewritten yet.
    setSubmissionStatus(ctx, submissionId, 'running');
    expect(getSubmissionDetail(ctx.db, submissionId)!.queuePosition).toBeNull();
  });

  it('returns null for a submission without a judge task and for an unknown id', () => {
    const ctx = setup();
    const submissionId = createSubmission(ctx.db, {
      problemId: ctx.problemId,
      userId: ctx.userId,
      language: 'cpp17',
      sourcePath: 'submissions/no-task.cpp',
      sourceHash: 'no-task',
    });
    expect(getQueuePosition(ctx.db, submissionId)).toBeNull();
    expect(getSubmissionDetail(ctx.db, submissionId)!.queuePosition).toBeNull();
    expect(getQueuePosition(ctx.db, 999_999)).toBeNull();
  });
});

describe('queue position HTTP API', () => {
  it('exposes queuePosition on the detail endpoint to the owner and admins', async () => {
    const ctx = setup();
    const urgent = seedQueued(ctx, 100);
    const normal = seedQueued(ctx, 50);

    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const ownerCookie = cookieFor(ctx, ctx.userId);
      const owner = await app.inject({
        method: 'GET',
        url: `/api/submissions/${normal}`,
        headers: { cookie: ownerCookie },
      });
      expect(owner.statusCode).toBe(200);
      const ownerBody = owner.json() as { ok: boolean; data: { queuePosition: number | null } };
      expect(ownerBody.ok).toBe(true);
      expect(ownerBody.data.queuePosition).toBe(2);

      const admin = createRoleUser(ctx, 'admin');
      const adminResponse = await app.inject({
        method: 'GET',
        url: `/api/submissions/${urgent}`,
        headers: { cookie: admin.cookie },
      });
      expect(adminResponse.statusCode).toBe(200);
      expect((adminResponse.json() as { data: { queuePosition: number | null } }).data.queuePosition).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('does not leak another user\'s submission or its queue position', async () => {
    const ctx = setup();
    const other = createRoleUser(ctx, 'contestant');
    const submissionId = seedQueued(ctx, 100, other.id);

    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const forbidden = await app.inject({
        method: 'GET',
        url: `/api/submissions/${submissionId}`,
        headers: { cookie: cookieFor(ctx, ctx.userId) },
      });
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.body).not.toContain('queuePosition');

      const anonymous = await app.inject({
        method: 'GET',
        url: `/api/submissions/${submissionId}`,
      });
      expect(anonymous.statusCode).toBe(401);

      const owner = await app.inject({
        method: 'GET',
        url: `/api/submissions/${submissionId}`,
        headers: { cookie: other.cookie },
      });
      expect(owner.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('reports null for a finished submission over HTTP', async () => {
    const ctx = setup();
    const submissionId = seedQueued(ctx, 50);
    setSubmissionStatus(ctx, submissionId, 'finished');
    setTaskStatus(ctx, submissionId, 'done');

    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/submissions/${submissionId}`,
        headers: { cookie: cookieFor(ctx, ctx.userId) },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: { queuePosition: number | null } };
      expect(body.data.queuePosition).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('includes queuePosition in the records list', async () => {
    const ctx = setup();
    const submissionId = seedQueued(ctx, 100);

    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/submissions?userId=me&limit=10',
        headers: { cookie: cookieFor(ctx, ctx.userId) },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: Array<{ id: number; queuePosition: number | null }> };
      expect(body.data.find((row) => row.id === submissionId)?.queuePosition).toBe(1);
    } finally {
      await app.close();
    }
  });
});
