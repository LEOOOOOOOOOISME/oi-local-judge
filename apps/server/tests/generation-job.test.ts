import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_PLAN_SCHEMA, type DataPlan } from '../src/authoring/data-plan.js';
import {
  cancelGenerationJob,
  runGenerationJob,
  startGenerationJob,
  type GenerationRuntime,
} from '../src/authoring/generation-job.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { upsertAsset } from '../src/storage/repos/assets.js';
import { createProblem } from '../src/storage/repos/problems.js';
import {
  getGenerationJob,
  listGenerationCases,
  updateGenerationJob,
} from '../src/storage/repos/generation-jobs.js';
import { migrateAuthoring } from '../src/storage/authoring-migrate.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-generation-'));
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
    title: 'Generation',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 128,
    testcases: [],
  });
  return { dir, db, config, problemId };
}

function addAsset(
  ctx: ReturnType<typeof setup>,
  kind: 'std' | 'generator' | 'validator',
) {
  const relativeDir = `problems/${ctx.problemId}/src/${kind}`;
  mkdirSync(join(ctx.config.dataDir, relativeDir), { recursive: true });
  writeFileSync(join(ctx.config.dataDir, relativeDir, `${kind}.cpp`), 'int main(){return 0;}');
  upsertAsset(ctx.db, {
    problemId: ctx.problemId,
    kind,
    name: `${kind}.cpp`,
    path: `${relativeDir}/${kind}.cpp`,
    language: 'cpp17',
    sha256: `${kind}-hash`,
    size: 20,
  });
}

function basePlan(): DataPlan {
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

function fakeRuntime(options: {
  failGeneratorSeed?: number;
  failStdSeed?: number;
} = {}): GenerationRuntime {
  return {
    async compile() {
      return { ok: true, exe: 'fake.exe', message: '' };
    },
    async generate(input) {
      if (input.seed === options.failGeneratorSeed) {
        return { ok: false, stdout: '', stderr: 'boom', message: 'generator boom' };
      }
      return {
        ok: true,
        stdout: `${input.groupId} ${input.index} ${input.seed}\n1 2 3\n`,
        stderr: '',
        message: 'ok',
      };
    },
    async runStd(input) {
      const inputText = readFileSync(input.inputPath, 'utf8');
      const seed = Number(inputText.split(/\s+/)[2]);
      if (seed === options.failStdSeed) {
        return {
          ok: false,
          exitCode: 1,
          cpuMs: 5,
          peakMemKb: 1024,
          timedOut: false,
          message: 'std failed',
        };
      }
      writeFileSync(input.outputPath, `out:${inputText.trim()}\n`);
      return {
        ok: true,
        exitCode: 0,
        cpuMs: 12,
        peakMemKb: 2048,
        timedOut: false,
        message: 'ok',
      };
    },
    async validate() {
      return { ok: true, message: 'ok' };
    },
  };
}

describe('independent generation jobs', () => {
  it('generates one case per group item with one-based seeds and stats', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    addAsset(ctx, 'validator');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    expect(started.total).toBe(4);

    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime(),
      now: () => 2000,
    });

    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('finished');
    expect(job.completed).toBe(4);
    expect(job.failed).toBe(0);
    const cases = listGenerationCases(ctx.db, started.id);
    expect(cases.map((row) => [row.group_id, row.case_index, row.seed])).toEqual([
      ['sub1', 1, 10],
      ['sub1', 2, 11],
      ['sub2', 1, 100],
      ['sub2', 2, 101],
    ]);
    expect(cases.every((row) => row.status === 'finished')).toBe(true);
    expect(cases[0].input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cases[0].std_time_ms).toBe(12);
    expect(job.stats_json).toContain('maxTimeMs');
  });

  it('keeps going after a generator failure and reports the failure point', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime({ failGeneratorSeed: 11 }),
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime({ failGeneratorSeed: 11 }),
      now: () => 2000,
    });

    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('failed');
    expect(job.failed).toBe(1);
    expect(job.completed).toBe(3);
    const failed = listGenerationCases(ctx.db, started.id).filter(
      (row) => row.status === 'failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].group_id).toBe('sub1');
    expect(failed[0].case_index).toBe(2);
    expect(failed[0].message).toContain('generator boom');
  });

  it('marks cases failed when std fails and still records paths', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime({ failStdSeed: 10 }),
      now: () => 2000,
    });

    const failed = listGenerationCases(ctx.db, started.id).filter(
      (row) => row.status === 'failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].seed).toBe(10);
    expect(failed[0].input_path).toContain('sub1-1.in');
    expect(failed[0].message).toContain('std failed');
  });

  it('skips validator when no validator asset exists', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime(),
      now: () => 2000,
    });
    const cases = listGenerationCases(ctx.db, started.id);
    expect(cases.every((row) => row.validator_ok === null)).toBe(true);
    expect(cases.every((row) => row.validator_message === '')).toBe(true);
  });

  it('cancels a queued job before any case starts', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    expect(cancelGenerationJob(ctx.db, started.id)).toBe(true);
    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('canceled');
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime(),
      now: () => 2000,
    });
    expect(getGenerationJob(ctx.db, started.id)?.status).toBe('canceled');
    expect(
      listGenerationCases(ctx.db, started.id).every((row) => row.status === 'canceled'),
    ).toBe(true);
  });

  it('fails the job and blocks cases when compilation fails', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const broken: GenerationRuntime = {
      ...fakeRuntime(),
      async compile(kind) {
        return kind === 'std'
          ? { ok: false, message: 'std compile error' }
          : { ok: true, exe: 'fake.exe', message: '' };
      },
    };
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: broken,
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: broken,
      now: () => 2000,
    });
    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('failed');
    expect(job.message).toContain('std compile error');
    expect(listGenerationCases(ctx.db, started.id).every((row) => row.status === 'blocked')).toBe(
      true,
    );
  });

  it('reconciles a stale running job on startup', async () => {
    const ctx = setup();
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    updateGenerationJob(ctx.db, started.id, { status: 'running', heartbeatAt: 1000 });
    const { reconcileInterruptedJobs } = await import(
      '../src/storage/repos/generation-jobs.js'
    );
    const count = reconcileInterruptedJobs(ctx.db, 100_000, 60_000);
    expect(count).toBe(1);
    expect(getGenerationJob(ctx.db, started.id)?.status).toBe('failed');
  });
});
