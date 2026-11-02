import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  buildDataPlanTemplate,
  DATA_PLAN_TEMPLATES,
  type DataPlanTemplateId,
} from '../authoring/data-plan-templates.js';
import {
  parseDataPlan,
  type DataPlan,
  type DataPlanIssue,
} from '../authoring/data-plan.js';
import {
  cancelGenerationJob,
  startGenerationJob,
  type StartGenerationOptions,
} from '../authoring/generation-job.js';
import { migrateAuthoring } from '../storage/authoring-migrate.js';
import { getDataPlanRow, upsertDataPlan } from '../storage/repos/data-plans.js';
import {
  getActiveGenerationJob,
  getGenerationCase,
  getGenerationJob,
  listGenerationCases,
  listGenerationJobs,
  reconcileInterruptedJobs,
  type GenerationCaseRow,
  type GenerationJobRow,
} from '../storage/repos/generation-jobs.js';
import { getProblem } from '../storage/repos/problems.js';

export interface AdminAuthoringRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
  /** 测试注入点；生产默认使用 startGenerationJob。 */
  startGeneration?: (input: StartGenerationOptions) => { id: number; total: number };
}

interface PreviewResult {
  text: string;
  truncated: boolean;
}

function readPreview(path: string, maxLines: number): PreviewResult {
  const buffer = Buffer.alloc(256 * 1024);
  const fd = openSync(path, 'r');
  let bytes = 0;
  try {
    bytes = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const text = buffer.subarray(0, bytes).toString('utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const truncated = bytes === buffer.length || lines.length > maxLines;
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated,
  };
}

function toJobSummary(job: GenerationJobRow) {
  return {
    id: job.id,
    problemId: job.problem_id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    message: job.message,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

function toCaseDto(row: GenerationCaseRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    index: row.case_index,
    seed: row.seed,
    status: row.status,
    inputPath: row.input_path,
    outputPath: row.output_path,
    inputSha256: row.input_sha256,
    inputBytes: row.input_bytes,
    inputLines: row.input_lines,
    inputUtf8: row.input_utf8 === 1,
    outputBytes: row.output_bytes,
    outputLines: row.output_lines,
    stdExitCode: row.std_exit_code,
    stdTimeMs: row.std_time_ms,
    stdMemoryKb: row.std_memory_kb,
    validatorOk: row.validator_ok === null ? null : row.validator_ok === 1,
    validatorMessage: row.validator_message,
    message: row.message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function parsePlanBody(
  body: unknown,
  options: { totalPoints?: number } = {},
): {
  ok: boolean;
  plan: DataPlan | null;
  issues: DataPlanIssue[];
} {
  const value =
    typeof body === 'object' && body !== null && 'plan' in body
      ? (body as { plan?: unknown }).plan
      : body;
  const parsed = parseDataPlan(value, options);
  return { ok: parsed.ok, plan: parsed.plan, issues: parsed.issues };
}

export function registerAdminAuthoringRoutes(
  app: FastifyInstance,
  options: AdminAuthoringRouteOptions,
): void {
  migrateAuthoring(options.db);
  reconcileInterruptedJobs(options.db);
  const guard = options.adminGuard;
  const startGeneration = options.startGeneration ?? startGenerationJob;

  const requireProblem = (problemId: number) => getProblem(options.db, problemId);

  app.get<{ Params: { id: string } }>(
    '/api/admin/problems/:id/data-plan',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      if (!requireProblem(problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const row = getDataPlanRow(options.db, problemId);
      if (!row) {
        return {
          ok: true,
          data: { plan: null, version: 0, updatedAt: null },
        };
      }
      return {
        ok: true,
        data: {
          plan: JSON.parse(row.plan_json) as DataPlan,
          version: row.version,
          updatedAt: row.updated_at,
        },
      };
    },
  );

  app.put<{
    Params: { id: string };
    Body: { plan?: unknown };
  }>('/api/admin/problems/:id/data-plan', { preHandler: guard }, async (request, reply) => {
    const problemId = Number(request.params.id);
    if (!requireProblem(problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    const parsed = parsePlanBody(request.body, { totalPoints: 100 });
    if (!parsed.ok || !parsed.plan) {
      const message =
        parsed.issues.find((entry) => entry.severity === 'error')?.message ??
        'invalid data plan';
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_DATA_PLAN', message },
      });
    }
    const row = upsertDataPlan(options.db, {
      problemId,
      planJson: JSON.stringify(parsed.plan),
      createdBy: request.user?.id ?? null,
    });
    return {
      ok: true,
      data: { plan: parsed.plan, version: row.version },
    };
  });

  app.post<{
    Params: { id: string };
    Body: { plan?: unknown };
  }>(
    '/api/admin/problems/:id/data-plan/validate',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      if (!requireProblem(problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const parsed = parseDataPlan(
        typeof request.body === 'object' && request.body !== null
          ? request.body.plan
          : request.body,
        { totalPoints: 100 },
      );
      return {
        ok: true,
        data: { valid: parsed.ok, issues: parsed.issues, totals: parsed.totals },
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { template?: DataPlanTemplateId; outputMb?: number };
  }>(
    '/api/admin/problems/:id/data-plan/template',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const problem = requireProblem(problemId);
      if (!problem) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const template = request.body?.template;
      if (!DATA_PLAN_TEMPLATES.some((entry) => entry.id === template)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_TEMPLATE', message: `unknown template: ${String(template)}` },
        });
      }
      const outputMb =
        typeof request.body?.outputMb === 'number' && request.body.outputMb > 0
          ? request.body.outputMb
          : 64;
      const plan = buildDataPlanTemplate({
        template: template as DataPlanTemplateId,
        limits: {
          timeMs: problem.time_ms,
          memoryMb: problem.memory_mb,
          outputMb,
        },
      });
      return { ok: true, data: { plan } };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { plan?: unknown };
  }>('/api/admin/problems/:id/generation-jobs', { preHandler: guard }, async (request, reply) => {
    const problemId = Number(request.params.id);
    if (!requireProblem(problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    if (getActiveGenerationJob(options.db, problemId)) {
      return reply.code(409).send({
        ok: false,
        error: { code: 'JOB_ACTIVE', message: '已有生成任务在运行，请先等待或取消' },
      });
    }

    let plan: DataPlan;
    let planVersion = 0;
    if (request.body?.plan === undefined) {
      const row = getDataPlanRow(options.db, problemId);
      if (!row) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'NO_DATA_PLAN', message: '请先保存数据计划' },
        });
      }
      const parsed = parseDataPlan(row.plan_json, { totalPoints: 100 });
      if (!parsed.ok || !parsed.plan) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_DATA_PLAN', message: '已保存的数据计划无效' },
        });
      }
      plan = parsed.plan;
      planVersion = row.version;
    } else {
      const parsed = parsePlanBody(request.body, { totalPoints: 100 });
      if (!parsed.ok || !parsed.plan) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'INVALID_DATA_PLAN',
            message:
              parsed.issues.find((entry) => entry.severity === 'error')?.message ??
              'invalid data plan',
          },
        });
      }
      plan = parsed.plan;
      planVersion = getDataPlanRow(options.db, problemId)?.version ?? 0;
    }

    let started: { id: number; total: number };
    try {
      started = startGeneration({
        db: options.db,
        config: options.config,
        problemId,
        plan,
        planVersion,
        createdBy: request.user?.id ?? null,
      });
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'GENERATION_START_FAILED', message: (error as Error).message },
      });
    }
    return reply.code(202).send({
      ok: true,
      data: { id: started.id, status: 'queued', total: started.total },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/problems/:id/generation-jobs',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      if (!requireProblem(problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return {
        ok: true,
        data: listGenerationJobs(options.db, problemId, 20).map(toJobSummary),
      };
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/api/admin/problems/:id/generation-jobs/:jobId',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const job = getGenerationJob(options.db, Number(request.params.jobId));
      if (!job || job.problem_id !== problemId) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return {
        ok: true,
        data: {
          ...toJobSummary(job),
          planVersion: job.plan_version,
          plan: JSON.parse(job.plan_json) as DataPlan,
          stats: JSON.parse(job.stats_json) as Record<string, number>,
          cases: listGenerationCases(options.db, job.id).map(toCaseDto),
        },
      };
    },
  );

  app.post<{ Params: { id: string; jobId: string } }>(
    '/api/admin/problems/:id/generation-jobs/:jobId/cancel',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const job = getGenerationJob(options.db, Number(request.params.jobId));
      if (!job || job.problem_id !== problemId) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const canceled = cancelGenerationJob(options.db, job.id);
      const current = getGenerationJob(options.db, job.id)!;
      return { ok: true, data: { canceled, status: current.status } };
    },
  );

  app.get<{
    Params: { id: string; jobId: string; caseId: string };
    Querystring: { lines?: string };
  }>(
    '/api/admin/problems/:id/generation-jobs/:jobId/cases/:caseId/preview',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const job = getGenerationJob(options.db, Number(request.params.jobId));
      if (!job || job.problem_id !== problemId) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const row = getGenerationCase(
        options.db,
        job.id,
        Number(request.params.caseId),
      );
      if (!row) {
        return reply.code(404).send({ ok: false, error: { code: 'CASE_NOT_FOUND' } });
      }
      if (!row.input_path || !row.output_path) {
        return reply.code(409).send({
          ok: false,
          error: { code: 'CASE_NOT_READY', message: '测试点文件尚未生成' },
        });
      }
      const inputAbsolute = join(options.config.dataDir, row.input_path);
      const outputAbsolute = join(options.config.dataDir, row.output_path);
      if (!existsSync(inputAbsolute) || !existsSync(outputAbsolute)) {
        return reply.code(409).send({
          ok: false,
          error: { code: 'CASE_NOT_READY', message: '测试点文件缺失' },
        });
      }
      const requested = Number(request.query.lines ?? 100);
      const lines = Number.isFinite(requested)
        ? Math.max(1, Math.min(500, Math.floor(requested)))
        : 100;
      const input = readPreview(inputAbsolute, lines);
      const output = readPreview(outputAbsolute, lines);
      return {
        ok: true,
        data: {
          caseId: row.id,
          input: input.text,
          output: output.text,
          inputTruncated: input.truncated,
          outputTruncated: output.truncated,
          inputLines: row.input_lines,
          outputLines: row.output_lines,
          inputBytes: row.input_bytes,
          outputBytes: row.output_bytes,
        },
      };
    },
  );
}
