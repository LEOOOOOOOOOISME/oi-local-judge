import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_PLAN_SCHEMA, type DataPlan } from '../src/authoring/data-plan.js';
import { PublishError, publishGenerationJob } from '../src/authoring/publish-generation.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { registerAdminAuthoringRoutes } from '../src/http/admin-authoring.js';
import { createProblem, getProblem, getSubtasks, getTestcases } from '../src/storage/repos/problems.js';
import {
  createGenerationJob,
  getGenerationJob,
  listGenerationCases,
  updateGenerationCase,
  updateGenerationJob,
} from '../src/storage/repos/generation-jobs.js';
import { migrateAuthoring } from '../src/storage/authoring-migrate.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function plan(): DataPlan {
  return {
    schema: DATA_PLAN_SCHEMA,
    limits: { timeMs: 1000, memoryMb: 128, outputMb: 64 },
    groups: [
      {
        id: 'sub1',
        name: '基础',
        points: 40,
        count: 2,
        seedStart: 10,
        args: ['--n=10'],
        dependsOn: [],
      },
      {
        id: 'sub2',
        name: '大',
        points: 60,
        count: 2,
        seedStart: 100,
        args: ['--n=1000'],
        dependsOn: ['sub1'],
      },
    ],
    pointsMode: 'group',
    naming: '{group}-{index}',
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-publish-'));
  ensureDataDirs(dir);
  const db = openDatabase(join(dir, 'test.db'));
  cleanups.push(() => {
    // Windows cannot delete the SQLite files while the handle is still open.
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  migrate(db);
  migrateAuthoring(db);
  const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const problemId = createProblem(db, {
    title: 'Publish',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 128,
    testcases: [],
  });
  return { dir, db, config, problemId };
}

interface ReadyJob {
  jobId: number;
  plan: DataPlan;
}

function createReadyJob(ctx: ReturnType<typeof setup>): ReadyJob {
  const dataPlan = plan();
  const jobId = createGenerationJob(ctx.db, {
    problemId: ctx.problemId,
    planVersion: 1,
    planJson: JSON.stringify(dataPlan),
    cases: dataPlan.groups.flatMap((group) =>
      Array.from({ length: group.count }, (_, offset) => ({
        groupId: group.id,
        groupName: group.name,
        index: offset + 1,
        seed: group.seedStart + offset,
      })),
    ),
    now: 500,
  });
  const relativeDir = `problems/${ctx.problemId}/authoring/jobs/${jobId}`;
  mkdirSync(join(ctx.config.dataDir, relativeDir), { recursive: true });
  const rows = listGenerationCases(ctx.db, jobId);
  rows.forEach((row, index) => {
    const input = `${row.group_id} ${row.case_index} ${row.seed}\n1 2 3\n`;
    const output = `case-${index + 1}\n`;
    const inputRelative = `${relativeDir}/${row.group_id}-${row.case_index}.in`;
    const outputRelative = `${relativeDir}/${row.group_id}-${row.case_index}.out`;
    writeFileSync(join(ctx.config.dataDir, inputRelative), input);
    writeFileSync(join(ctx.config.dataDir, outputRelative), output);
    updateGenerationCase(ctx.db, row.id, {
      status: 'finished',
      inputPath: inputRelative,
      outputPath: outputRelative,
      inputSha256: String(index + 1).repeat(64),
      inputBytes: Buffer.byteLength(input),
      inputLines: 2,
      inputUtf8: 1,
      outputBytes: Buffer.byteLength(output),
      outputLines: 1,
      stdExitCode: 0,
      stdTimeMs: 12,
      stdMemoryKb: 2048,
      finishedAt: 2000,
    });
  });
  updateGenerationJob(ctx.db, jobId, {
    status: 'finished',
    completed: rows.length,
    failed: 0,
    total: rows.length,
    startedAt: 1000,
    finishedAt: 2000,
  });
  return { jobId, plan: dataPlan };
}

function publish(
  ctx: ReturnType<typeof setup>,
  jobId: number,
  options: { confirmWarnings?: boolean; now?: number } = {},
) {
  return publishGenerationJob({
    db: ctx.db,
    config: ctx.config,
    problemId: ctx.problemId,
    jobId,
    confirmWarnings: options.confirmWarnings,
    now: options.now,
  });
}

function captureError(fn: () => unknown): PublishError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PublishError);
    return error as PublishError;
  }
  throw new Error('expected publish to fail');
}

describe('publish generation job', () => {
  it('copies cases, replaces subtasks/testcases and marks the job published', () => {
    const ctx = setup();
    const { jobId } = createReadyJob(ctx);

    const result = publish(ctx, jobId, { confirmWarnings: true, now: 5000 });
    expect(result.report.pass).toBe(true);
    expect(result.testcases).toBe(4);
    expect(result.subtasks).toBe(2);
    expect(result.warnings.map((warning) => warning.gate).sort()).toEqual([
      'determinism',
      'samples',
      'validator',
    ]);

    const job = getGenerationJob(ctx.db, jobId)!;
    expect(job.status).toBe('published');
    expect(job.finished_at).toBe(5000);
    expect(job.heartbeat_at).toBe(5000);

    const testcases = getTestcases(ctx.db, ctx.problemId);
    const relativeDir = `problems/${ctx.problemId}/data/authoring-${jobId}`;
    expect(testcases.map((row) => [row.ordinal, row.input_path, row.output_path, row.points])).toEqual([
      [1, `${relativeDir}/sub1-1.in`, `${relativeDir}/sub1-1.out`, 20],
      [2, `${relativeDir}/sub1-2.in`, `${relativeDir}/sub1-2.out`, 20],
      [3, `${relativeDir}/sub2-1.in`, `${relativeDir}/sub2-1.out`, 30],
      [4, `${relativeDir}/sub2-2.in`, `${relativeDir}/sub2-2.out`, 30],
    ]);

    const subtasks = getSubtasks(ctx.db, ctx.problemId);
    expect(subtasks.map((row) => [row.name, row.points, row.aggregation])).toEqual([
      ['基础', 40, 'sum'],
      ['大', 60, 'sum'],
    ]);
    expect(testcases.map((row) => row.subtask_id)).toEqual([
      subtasks[0].id,
      subtasks[0].id,
      subtasks[1].id,
      subtasks[1].id,
    ]);

    const problem = getProblem(ctx.db, ctx.problemId)!;
    expect(problem.time_ms).toBe(1000);
    expect(problem.memory_mb).toBe(128);

    expect(readFileSync(join(ctx.config.dataDir, testcases[0].input_path), 'utf8')).toBe(
      'sub1 1 10\n1 2 3\n',
    );
    expect(readFileSync(join(ctx.config.dataDir, testcases[0].output_path), 'utf8')).toBe(
      'case-1\n',
    );
  });

  it('refuses to publish when gates only have warnings unless confirmed', () => {
    const ctx = setup();
    const { jobId } = createReadyJob(ctx);

    const error = captureError(() => publish(ctx, jobId));
    expect(error.code).toBe('QUALITY_GATE_WARNINGS');
    expect(error.status).toBe(409);
    expect(error.report?.pass).toBe(true);
    expect(error.report?.findings.some((finding) => finding.level === 'warn')).toBe(true);
    expect(getGenerationJob(ctx.db, jobId)?.status).toBe('finished');
    expect(getTestcases(ctx.db, ctx.problemId)).toHaveLength(0);
    expect(getSubtasks(ctx.db, ctx.problemId)).toHaveLength(0);
    expect(
      existsSync(join(ctx.config.dataDir, 'problems', String(ctx.problemId), 'data', `authoring-${jobId}`)),
    ).toBe(false);

    // Confirming the same job afterwards succeeds.
    const result = publish(ctx, jobId, { confirmWarnings: true, now: 6000 });
    expect(result.testcases).toBe(4);
    expect(getGenerationJob(ctx.db, jobId)?.status).toBe('published');
  });

  it('refuses to publish while a case is not finished', () => {
    const ctx = setup();
    const { jobId } = createReadyJob(ctx);
    const [first] = listGenerationCases(ctx.db, jobId);
    updateGenerationCase(ctx.db, first.id, { status: 'failed', message: 'boom' });

    const error = captureError(() => publish(ctx, jobId, { confirmWarnings: true }));
    expect(error.code).toBe('CASES_NOT_READY');
    expect(error.status).toBe(409);
    expect(getGenerationJob(ctx.db, jobId)?.status).toBe('finished');
    expect(getTestcases(ctx.db, ctx.problemId)).toHaveLength(0);
    expect(getSubtasks(ctx.db, ctx.problemId)).toHaveLength(0);
  });

  it('rejects publishing an already published job', () => {
    const ctx = setup();
    const { jobId } = createReadyJob(ctx);
    publish(ctx, jobId, { confirmWarnings: true, now: 5000 });

    const error = captureError(() => publish(ctx, jobId, { confirmWarnings: true, now: 6000 }));
    expect(error.code).toBe('JOB_ALREADY_PUBLISHED');
    expect(error.status).toBe(409);
    expect(error.report).toBeUndefined();
  });

  it('rejects a job that belongs to another problem', () => {
    const ctx = setup();
    const { jobId } = createReadyJob(ctx);
    const otherProblem = createProblem(ctx.db, {
      title: 'Other',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 128,
      testcases: [],
    });

    const error = captureError(() =>
      publishGenerationJob({
        db: ctx.db,
        config: ctx.config,
        problemId: otherProblem,
        jobId,
        confirmWarnings: true,
      }),
    );
    expect(error.code).toBe('JOB_NOT_FOUND');
    expect(error.status).toBe(404);
  });
});

describe('publish generation API', () => {
  it('maps publish errors to HTTP responses and returns the result on confirm', async () => {
    const ctx = setup();
    const { jobId } = createReadyJob(ctx);
    const app = Fastify();
    cleanups.push(() => app.close());
    registerAdminAuthoringRoutes(app, {
      db: ctx.db,
      config: ctx.config,
      adminGuard: async () => undefined,
    });
    await app.ready();

    const blocked = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${ctx.problemId}/generation-jobs/${jobId}/publish`,
      payload: {},
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({
      ok: false,
      error: { code: 'QUALITY_GATE_WARNINGS' },
    });

    const confirmed = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${ctx.problemId}/generation-jobs/${jobId}/publish`,
      payload: { confirmWarnings: true },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json()).toMatchObject({
      ok: true,
      data: { testcases: 4, subtasks: 2 },
    });
    expect(getGenerationJob(ctx.db, jobId)?.status).toBe('published');
  });
});
