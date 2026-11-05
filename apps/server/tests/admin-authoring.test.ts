import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_PLAN_SCHEMA, type DataPlan } from '../src/authoring/data-plan.js';
import type { StartGenerationOptions } from '../src/authoring/generation-job.js';
import { registerAdminAuthoringRoutes } from '../src/http/admin-authoring.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { createProblem, getProblem } from '../src/storage/repos/problems.js';
import { migrateAuthoring } from '../src/storage/authoring-migrate.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';
import {
  createGenerationJob,
  getGenerationJob,
  listGenerationCases,
  updateGenerationCase,
  updateGenerationJob,
} from '../src/storage/repos/generation-jobs.js';

const root = mkdtempSync(join(tmpdir(), 'oij-authoring-api-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: ReturnType<typeof Fastify>;
let problemId = 0;
let lastStart: StartGenerationOptions | null = null;

function plan(): DataPlan {
  return {
    schema: DATA_PLAN_SCHEMA,
    limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
    groups: [
      {
        id: 'sub1',
        name: '基础',
        points: 100,
        count: 2,
        seedStart: 1,
        args: ['--n=10'],
        dependsOn: [],
      },
    ],
    pointsMode: 'group',
    naming: '{group}-{index}',
  };
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  migrateAuthoring(db);
  problemId = createProblem(db, {
    title: 'API',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 256,
    testcases: [],
  });
  app = Fastify();
  registerAdminAuthoringRoutes(app, {
    db,
    config,
    adminGuard: async () => undefined,
    startGeneration: (input) => {
      lastStart = input;
      return { id: 77, total: 2 };
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('data plan APIs', () => {
  it('returns an empty plan before the first save', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/data-plan`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: { plan: null, version: 0, updatedAt: null },
    });
  });

  it('saves and reads a valid plan', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/problems/${problemId}/data-plan`,
      payload: { plan: plan() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json() as { data: { version: number } };
    expect(saved.data.version).toBe(1);

    const read = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/data-plan`,
    });
    const body = read.json() as { data: { plan: DataPlan; version: number } };
    expect(body.data.version).toBe(1);
    expect(body.data.plan.groups[0].count).toBe(2);
  });

  it('rejects an invalid plan with a 400', async () => {
    const invalid = plan();
    invalid.groups[0].points = 60;
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/problems/${problemId}/data-plan`,
      payload: { plan: invalid },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_DATA_PLAN',
    );
  });

  it('validates a draft without saving', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/data-plan/validate`,
      payload: { plan: plan() },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { valid: boolean; issues: unknown[]; totals: { testCount: number } };
    };
    expect(body.data.valid).toBe(true);
    expect(body.data.totals.testCount).toBe(2);
  });

  it('builds a template from problem limits', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/data-plan/template`,
      payload: { template: 'single-group' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { plan: DataPlan } };
    expect(body.data.plan.groups[0].count).toBe(10);
    expect(body.data.plan.limits.timeMs).toBe(getProblem(db, problemId)?.time_ms);
  });
});

describe('generation job APIs', () => {
  it('starts a job through the injected starter', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/generation-jobs`,
      payload: { plan: plan() },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({
      ok: true,
      data: { id: 77, status: 'queued', total: 2 },
    });
    expect(lastStart?.problemId).toBe(problemId);
    expect(lastStart?.plan.groups[0].count).toBe(2);
  });

  it('cancels a running job', async () => {
    const jobId = createGenerationJob(db, {
      problemId,
      planVersion: 1,
      planJson: JSON.stringify(plan()),
      cases: [
        { groupId: 'sub1', groupName: '基础', index: 1, seed: 1 },
        { groupId: 'sub1', groupName: '基础', index: 2, seed: 2 },
      ],
      now: Date.now(),
    });
    updateGenerationJob(db, jobId, {
      status: 'running',
      heartbeatAt: Date.now(),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/generation-jobs/${jobId}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: { canceled: true, status: 'canceled' },
    });
    expect(getGenerationJob(db, jobId)?.status).toBe('canceled');
  });

  it('returns job detail and testcase preview', async () => {
    const jobId = createGenerationJob(db, {
      problemId,
      planVersion: 1,
      planJson: JSON.stringify(plan()),
      cases: [{ groupId: 'sub1', groupName: '基础', index: 1, seed: 1 }],
      now: Date.now(),
    });
    const caseId = listGenerationCases(db, jobId)[0].id;
    const relativeDir = `problems/${problemId}/authoring/jobs/${jobId}`;
    mkdirSync(join(config.dataDir, relativeDir), { recursive: true });
    writeFileSync(join(config.dataDir, relativeDir, 'sub1-1.in'), '1 2 3\n4 5 6\n');
    writeFileSync(join(config.dataDir, relativeDir, 'sub1-1.out'), '6\n');
    updateGenerationCase(db, caseId, {
      status: 'finished',
      inputPath: `${relativeDir}/sub1-1.in`,
      outputPath: `${relativeDir}/sub1-1.out`,
      inputSha256: 'a'.repeat(64),
      inputBytes: 12,
      inputLines: 2,
      inputUtf8: 1,
      outputBytes: 2,
      outputLines: 1,
      stdExitCode: 0,
      stdTimeMs: 12,
      stdMemoryKb: 2048,
      validatorOk: 1,
      validatorMessage: 'ok',
      finishedAt: Date.now(),
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/generation-jobs/${jobId}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json() as {
      data: { id: number; cases: Array<{ id: number; status: string }> };
    };
    expect(body.data.id).toBe(jobId);
    expect(body.data.cases[0]).toMatchObject({ id: caseId, status: 'finished' });

    const preview = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/generation-jobs/${jobId}/cases/${caseId}/preview?lines=1`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      ok: true,
      data: { input: '1 2 3', output: '6', inputTruncated: true, outputTruncated: false },
    });
  });
});
