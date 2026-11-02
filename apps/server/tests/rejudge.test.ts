import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { decideOverallVerdict, judgeSubmission, type JudgedResult } from '../src/judge/pipeline.js';
import { signSession } from '../src/security/session.js';
import {
  rejudgeSubmission,
  SubmissionBusyError,
  submitSource,
} from '../src/services/submissions.js';
import { addParticipant, createContest } from '../src/storage/repos/contests.js';
import { createJudgeTask, getJudgeTaskBySubmission } from '../src/storage/repos/judge.js';
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

interface Ctx {
  dir: string;
  db: ReturnType<typeof openDatabase>;
  config: ReturnType<typeof loadConfig>;
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

function setup(): Ctx {
  mkdirSync(workspaceRunnerDir, { recursive: true });
  const dir = mkdtempSync(join(workspaceRunnerDir, 'rejudge-'));
  ensureDataDirs(dir);
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
  const ctx = { dir, db, config, userId, problemId };
  contexts.push(ctx);
  return ctx;
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
  return { id, cookie: cookieFor(ctx, id) };
}

let sourceSequence = 0;

/** Creates a submission already in a terminal judged state (finished/failed). */
function seedFinishedSubmission(
  ctx: Ctx,
  options: {
    status?: string;
    verdict?: string;
    score?: number;
    contestId?: number | null;
    problemId?: number;
    withResults?: boolean;
  } = {},
): { submissionId: number; taskId: number } {
  const status = options.status ?? 'finished';
  const submissionId = createSubmission(ctx.db, {
    contestId: options.contestId ?? null,
    problemId: options.problemId ?? ctx.problemId,
    userId: ctx.userId,
    language: 'cpp17',
    sourcePath: `submissions/seed-${sourceSequence++}.cpp`,
    sourceHash: `hash-${sourceSequence}`,
  });
  ctx.db
    .prepare(
      `UPDATE submissions SET status = ?, verdict = ?, score = ?, time_ms = ?, memory_kb = ?,
         message = ?, judged_at = ? WHERE id = ?`,
    )
    .run(
      status,
      options.verdict === undefined ? 'AC' : options.verdict,
      options.score ?? 100,
      12,
      2048,
      'old judge message',
      1_700_000_000_000,
      submissionId,
    );
  if (options.withResults !== false) {
    ctx.db
      .prepare(
        `INSERT INTO test_results(submission_id, testcase_id, verdict, time_ms, memory_kb, score, message)
         VALUES (?, 1, 'AC', 12, 2048, 100, '')`,
      )
      .run(submissionId);
  }
  const taskId = createJudgeTask(ctx.db, submissionId, 50);
  ctx.db
    .prepare("UPDATE judge_tasks SET status = 'done', worker = 'worker-1', heartbeat_at = 1 WHERE id = ?")
    .run(taskId);
  return { submissionId, taskId };
}

function taskRows(ctx: Ctx, submissionId: number) {
  return ctx.db
    .prepare('SELECT id, status, worker, priority, attempts FROM judge_tasks WHERE submission_id = ?')
    .all(submissionId) as unknown as Array<{
    id: number;
    status: string;
    worker: string | null;
    priority: number;
    attempts: number;
  }>;
}

async function rejudgeOverHttp(
  ctx: Ctx,
  id: number,
  role: 'admin' | 'setter' | 'contestmanager' | 'contestant' | 'anonymous',
) {
  const app = await buildApp({ db: ctx.db, config: ctx.config });
  try {
    const cookie =
      role === 'anonymous'
        ? undefined
        : role === 'admin'
          ? cookieFor(ctx, createRoleUser(ctx, 'admin').id)
          : cookieFor(ctx, createRoleUser(ctx, role).id);
    return await app.inject({
      method: 'POST',
      url: `/api/admin/submissions/${id}/rejudge`,
      headers: cookie ? { cookie } : {},
    });
  } finally {
    await app.close();
  }
}

describe('rejudge service', () => {
  it('resets a finished submission and re-queues its existing task without duplicating it', () => {
    const ctx = setup();
    const { submissionId, taskId } = seedFinishedSubmission(ctx);

    const first = rejudgeSubmission(ctx.db, submissionId);
    expect(first).toEqual({ id: submissionId, taskId });

    const submission = getSubmission(ctx.db, submissionId)!;
    expect(submission.status).toBe('queued');
    expect(submission.verdict).toBeNull();
    expect(submission.score).toBe(0);
    expect(submission.time_ms).toBe(0);
    expect(submission.memory_kb).toBe(0);
    expect(submission.message).toBe('');
    expect(submission.judged_at).toBeNull();
    expect(getTestResults(ctx.db, submissionId)).toEqual([]);

    const rows = taskRows(ctx, submissionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: taskId,
      status: 'queued',
      worker: null,
      priority: 100,
      attempts: 0,
    });

    // Idempotent: a second rejudge of the now-queued submission is accepted and
    // still leaves exactly one task row.
    const second = rejudgeSubmission(ctx.db, submissionId);
    expect(second).toEqual({ id: submissionId, taskId });
    expect(taskRows(ctx, submissionId)).toHaveLength(1);
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('queued');
  });

  it('returns null for an unknown submission', () => {
    const ctx = setup();
    expect(rejudgeSubmission(ctx.db, 99_999)).toBeNull();
  });

  it('refuses to race a worker that is actively judging the submission', () => {
    const ctx = setup();
    const { submissionId, taskId } = seedFinishedSubmission(ctx);
    ctx.db.prepare("UPDATE submissions SET status = 'running', verdict = NULL, judged_at = NULL WHERE id = ?").run(submissionId);
    ctx.db
      .prepare("UPDATE judge_tasks SET status = 'running', worker = 'worker-1' WHERE id = ?")
      .run(taskId);

    expect(() => rejudgeSubmission(ctx.db, submissionId)).toThrow(SubmissionBusyError);
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('running');
    expect(getTestResults(ctx.db, submissionId)).toHaveLength(1);
    expect(getJudgeTaskBySubmission(ctx.db, submissionId)!.status).toBe('running');
  });
});

describe('rejudge HTTP API', () => {
  it('is available to admin, setter and contestmanager', async () => {
    for (const role of ['admin', 'setter', 'contestmanager'] as const) {
      const ctx = setup();
      const { submissionId } = seedFinishedSubmission(ctx);
      const response = await rejudgeOverHttp(ctx, submissionId, role);
      expect(response.statusCode, role).toBe(200);
      const body = response.json() as {
        ok: boolean;
        data: { id: number; status: string; taskId: number };
      };
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({ id: submissionId, status: 'queued' });
      expect(getSubmission(ctx.db, submissionId)!.status).toBe('queued');
      expect(taskRows(ctx, submissionId)).toHaveLength(1);
    }
  });

  it('rejects a contestant with 403 and an anonymous caller with 401', async () => {
    const ctx = setup();
    const { submissionId } = seedFinishedSubmission(ctx);

    const forbidden = await rejudgeOverHttp(ctx, submissionId, 'contestant');
    expect(forbidden.statusCode).toBe(403);

    const anonymous = await rejudgeOverHttp(ctx, submissionId, 'anonymous');
    expect(anonymous.statusCode).toBe(401);

    // A rejected caller must not have changed the submission.
    const submission = getSubmission(ctx.db, submissionId)!;
    expect(submission.status).toBe('finished');
    expect(submission.verdict).toBe('AC');
    expect(getTestResults(ctx.db, submissionId)).toHaveLength(1);
  });

  it('returns 404 for a missing submission and 409 for a running one', async () => {
    const ctx = setup();
    const { submissionId, taskId } = seedFinishedSubmission(ctx);

    const missing = await rejudgeOverHttp(ctx, 99_999, 'admin');
    expect(missing.statusCode).toBe(404);

    ctx.db.prepare("UPDATE submissions SET status = 'compiling', verdict = NULL, judged_at = NULL WHERE id = ?").run(submissionId);
    ctx.db
      .prepare("UPDATE judge_tasks SET status = 'compiling', worker = 'worker-1' WHERE id = ?")
      .run(taskId);
    const busy = await rejudgeOverHttp(ctx, submissionId, 'admin');
    expect(busy.statusCode).toBe(409);
    expect((busy.json() as { error: { code: string } }).error.code).toBe('SUBMISSION_RUNNING');
    expect(getSubmission(ctx.db, submissionId)!.status).toBe('compiling');
  });
});

describe('contest batch rejudge', () => {
  it('rejudges terminal submissions, can filter by verdict and leaves active rows alone', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Batch Cup',
      startAt: 1_000,
      endAt: 2_000,
      problemIds: [ctx.problemId],
    });
    addParticipant(ctx.db, contestId, ctx.userId);

    const ac = seedFinishedSubmission(ctx, { contestId, verdict: 'AC', score: 100 });
    const tle = seedFinishedSubmission(ctx, { contestId, verdict: 'TLE', score: 0 });
    const running = seedFinishedSubmission(ctx, { contestId, status: 'running', verdict: null, score: 0 });

    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const admin = createRoleUser(ctx, 'admin');
      const contestant = createRoleUser(ctx, 'contestant');

      const forbidden = await app.inject({
        method: 'POST',
        url: `/api/admin/contests/${contestId}/rejudge`,
        headers: { cookie: contestant.cookie },
        payload: {},
      });
      expect(forbidden.statusCode).toBe(403);

      const all = await app.inject({
        method: 'POST',
        url: `/api/admin/contests/${contestId}/rejudge`,
        headers: { cookie: admin.cookie },
        payload: {},
      });
      expect(all.statusCode).toBe(200);
      const allBody = all.json() as {
        data: { rejudged: number; skipped: number; ids: number[] };
      };
      expect(allBody.data.rejudged).toBe(2);
      expect(allBody.data.ids.sort()).toEqual([ac.submissionId, tle.submissionId].sort());
      expect(getSubmission(ctx.db, running.submissionId)!.status).toBe('running');
      expect(getJudgeTaskBySubmission(ctx.db, running.submissionId)!.status).toBe('done');
      for (const id of [ac.submissionId, tle.submissionId]) {
        expect(taskRows(ctx, id)).toHaveLength(1);
        expect(taskRows(ctx, id)[0].status).toBe('queued');
      }

      // A verdict filter is applied on top of the (default) terminal statuses.
      const ac2 = seedFinishedSubmission(ctx, { contestId, verdict: 'AC', score: 100 });
      const tle2 = seedFinishedSubmission(ctx, { contestId, verdict: 'TLE', score: 0 });
      const filtered = await app.inject({
        method: 'POST',
        url: `/api/admin/contests/${contestId}/rejudge`,
        headers: { cookie: admin.cookie },
        payload: { verdicts: ['TLE'] },
      });
      expect(filtered.statusCode).toBe(200);
      const filteredBody = filtered.json() as {
        data: { rejudged: number; skipped: number; ids: number[] };
      };
      expect(filteredBody.data).toEqual({ rejudged: 1, skipped: 0, ids: [tle2.submissionId] });
      expect(getSubmission(ctx.db, tle2.submissionId)!.status).toBe('queued');
      expect(getTestResults(ctx.db, tle2.submissionId)).toEqual([]);
      expect(getSubmission(ctx.db, ac2.submissionId)!.status).toBe('finished');
    } finally {
      await app.close();
    }
  });
});

describe('problem batch rejudge', () => {
  it('rejudges terminal submissions of one problem only', async () => {
    const ctx = setup();
    const otherProblemId = createProblem(ctx.db, {
      title: 'Other',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
    });
    const first = seedFinishedSubmission(ctx);
    const second = seedFinishedSubmission(ctx);
    const other = seedFinishedSubmission(ctx, { problemId: otherProblemId });

    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const admin = createRoleUser(ctx, 'admin');
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/problems/${ctx.problemId}/rejudge`,
        headers: { cookie: admin.cookie },
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        data: { rejudged: number; skipped: number; ids: number[] };
      };
      expect(body.data.rejudged).toBe(2);
      expect(body.data.skipped).toBe(0);
      expect(body.data.ids.sort()).toEqual([first.submissionId, second.submissionId].sort());

      for (const id of [first.submissionId, second.submissionId]) {
        expect(getSubmission(ctx.db, id)!.status).toBe('queued');
        expect(taskRows(ctx, id)).toHaveLength(1);
        expect(taskRows(ctx, id)[0].status).toBe('queued');
      }
      expect(getSubmission(ctx.db, other.submissionId)!.status).toBe('finished');
      expect(taskRows(ctx, other.submissionId)[0].status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('skips queued and running rows even when their status is requested', async () => {
    const ctx = setup();
    const finished = seedFinishedSubmission(ctx);
    const queued = seedFinishedSubmission(ctx, { status: 'queued', verdict: null });
    const running = seedFinishedSubmission(ctx, { status: 'running', verdict: null });

    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const admin = createRoleUser(ctx, 'admin');
      const response = await app.inject({
        method: 'POST',
        url: `/api/admin/problems/${ctx.problemId}/rejudge`,
        headers: { cookie: admin.cookie },
        payload: { statuses: ['finished', 'queued', 'running'] },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as {
        data: { rejudged: number; skipped: number; ids: number[] };
      };
      expect(body.data).toEqual({
        rejudged: 1,
        skipped: 2,
        ids: [finished.submissionId],
      });

      expect(getSubmission(ctx.db, finished.submissionId)!.status).toBe('queued');
      expect(getSubmission(ctx.db, queued.submissionId)!.status).toBe('queued');
      expect(taskRows(ctx, queued.submissionId)[0].status).toBe('done');
      expect(getSubmission(ctx.db, running.submissionId)!.status).toBe('running');
      expect(taskRows(ctx, running.submissionId)[0].status).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('returns 404 for an unknown problem', async () => {
    const ctx = setup();
    const app = await buildApp({ db: ctx.db, config: ctx.config });
    try {
      const admin = createRoleUser(ctx, 'admin');
      const response = await app.inject({
        method: 'POST',
        url: '/api/admin/problems/99999/rejudge',
        headers: { cookie: admin.cookie },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
      const body = response.json() as { error: { code: string; message?: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.message).toBe('problem 99999 not found');
    } finally {
      await app.close();
    }
  });
});

describe('output limit exceeded (OLE)', () => {
  const OLE_SOURCE = [
    '#include <cstdio>',
    'int main() {',
    '  for (int i = 0; i < 2 * 1024 * 1024; ++i) std::putchar(120);',
    '  return 0;',
    '}',
    '',
  ].join('\n');

  it('judges an over-limit stdout as OLE with actual and limit in the message', async () => {
    const ctx = setup();
    mkdirSync(join(ctx.dir, 'problems', 'ole'), { recursive: true });
    writeFileSync(join(ctx.dir, 'problems', 'ole', '1.in'), '1 2\n');
    writeFileSync(join(ctx.dir, 'problems', 'ole', '1.out'), '3\n');
    const problemId = createProblem(ctx.db, {
      title: 'Output bomb',
      type: 'standard',
      timeMs: 5000,
      memoryMb: 64,
      outputMb: 1,
      testcases: [
        {
          inputPath: join(ctx.dir, 'problems', 'ole', '1.in'),
          outputPath: join(ctx.dir, 'problems', 'ole', '1.out'),
          points: 100,
        },
      ],
    });
    const { id } = submitSource(
      { db: ctx.db, config: ctx.config },
      {
        userId: ctx.userId,
        problemId,
        language: 'cpp17',
        code: OLE_SOURCE,
        contestId: null,
        skipCooldown: true,
      },
    );

    await judgeSubmission({ db: ctx.db, config: ctx.config, submissionId: id });

    const submission = getSubmission(ctx.db, id)!;
    expect(submission.status).toBe('finished');
    expect(submission.verdict).toBe('OLE');
    expect(submission.score).toBe(0);
    const results = getTestResults(ctx.db, id);
    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('OLE');
    expect(results[0].message).toContain('output limit exceeded');
    expect(results[0].message).toContain('limit 1 MB');
    expect(results[0].message).toMatch(/stdout \d+ bytes/);
  }, 60_000);

  it('ranks OLE above RE and WA in the overall verdict', () => {
    const result = (verdict: JudgedResult['verdict']): JudgedResult => ({
      testcaseId: 1,
      verdict,
      timeMs: 1,
      memoryKb: 1,
      score: 0,
      message: '',
    });
    expect(decideOverallVerdict([result('RE'), result('OLE')])).toBe('OLE');
    expect(decideOverallVerdict([result('WA'), result('OLE')])).toBe('OLE');
    expect(decideOverallVerdict([result('AC'), result('OLE')])).toBe('OLE');
    expect(decideOverallVerdict([result('TLE'), result('OLE')])).toBe('TLE');
  });
});
