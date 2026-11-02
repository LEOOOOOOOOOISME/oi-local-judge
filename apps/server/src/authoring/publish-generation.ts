import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getAsset } from '../storage/repos/assets.js';
import { getProblem, replaceSubtasks, replaceTestcases } from '../storage/repos/problems.js';
import {
  getGenerationJob,
  listGenerationCases,
  markGenerationJobPublished,
  type GenerationCaseRow,
} from '../storage/repos/generation-jobs.js';
import { parseDataPlan, splitGroupPoints } from './data-plan.js';
import {
  evaluateQualityGates,
  toGateCaseSnapshot,
  type GateFinding,
  type QualityGateReport,
} from './quality-gates.js';

export class PublishError extends Error {
  readonly code: string;
  readonly status: number;
  readonly report?: QualityGateReport;

  constructor(code: string, status: number, message: string, report?: QualityGateReport) {
    super(message);
    this.name = 'PublishError';
    this.code = code;
    this.status = status;
    this.report = report;
  }
}

export interface PublishGenerationResult {
  testcases: number;
  subtasks: number;
  warnings: GateFinding[];
  report: QualityGateReport;
}

interface PublishTestcase {
  inputPath: string;
  outputPath: string;
  points: number;
  subtaskId: number;
}

export function publishGenerationJob(options: {
  db: DatabaseSync;
  config: Config;
  problemId: number;
  jobId: number;
  confirmWarnings?: boolean;
  now?: number;
}): PublishGenerationResult {
  const { db, config, problemId, jobId } = options;
  if (!Number.isSafeInteger(problemId) || !Number.isSafeInteger(jobId)) {
    throw new PublishError('JOB_NOT_FOUND', 404, 'generation job not found');
  }
  const job = getGenerationJob(db, jobId);
  if (!job || job.problem_id !== problemId) {
    throw new PublishError('JOB_NOT_FOUND', 404, 'generation job not found');
  }
  if (job.status === 'published') {
    throw new PublishError('JOB_ALREADY_PUBLISHED', 409, 'generation job is already published');
  }
  if (job.status !== 'finished') {
    throw new PublishError('JOB_NOT_READY', 409, 'generation job is not finished');
  }
  const problem = getProblem(db, problemId);
  if (!problem) throw new PublishError('PROBLEM_NOT_FOUND', 404, 'problem not found');
  const parsed = parseDataPlan(job.plan_json);
  if (!parsed.ok || !parsed.plan) {
    throw new PublishError('PLAN_INVALID', 409, 'data plan is invalid');
  }
  const plan = parsed.plan;
  const cases = listGenerationCases(db, jobId);
  if (cases.length === 0 || cases.some((row) => row.status !== 'finished')) {
    throw new PublishError('CASES_NOT_READY', 409, 'not all cases are finished');
  }
  const hasValidator = getAsset(db, problemId, 'validator') !== null;
  const snapshots = cases.map(toGateCaseSnapshot);
  const report = evaluateQualityGates({
    plan,
    cases: snapshots,
    compile: { generator: true, std: true, validator: hasValidator ? true : null, checker: null },
    hasValidator,
    requiresValidator: false,
    samples: [],
    determinism: [],
    budget: {
      actualWallMs: Math.max(0, (job.finished_at ?? job.created_at) - (job.started_at ?? job.created_at)),
      maxWallMs: 30 * 60 * 1000,
      actualDiskBytes: reportDisk(snapshots),
      maxDiskBytes: 2 * 1024 * 1024 * 1024,
    },
  });
  if (!report.pass) {
    throw new PublishError('QUALITY_GATE_BLOCKED', 409, 'quality gates blocked publish', report);
  }
  const warnings = report.findings.filter((finding) => finding.level === 'warn');
  if (warnings.length > 0 && !options.confirmWarnings) {
    throw new PublishError('QUALITY_GATE_WARNINGS', 409, 'quality gates have warnings', report);
  }

  const dataRoot = resolve(config.dataDir);
  const dataDir = join(dataRoot, 'problems', String(problemId), 'data', `authoring-${jobId}`);
  const isInsideDataRoot = (path: string): boolean =>
    path === dataRoot || path.startsWith(`${dataRoot}${sep}`);
  mkdirSync(dataDir, { recursive: true });

  // Copy files before opening the transaction: a copy failure must not touch the DB.
  // If the transaction below fails, the copied directory is left as an orphan and a
  // later publish attempt may overwrite it.
  const groupPoints = new Map(
    plan.groups.map((group) => [group.id, splitGroupPoints(group.points, group.count)]),
  );
  const publishCases: Array<{ row: GenerationCaseRow; item: PublishTestcase }> = [];
  for (const row of cases) {
    if (!row.input_path || !row.output_path) {
      throw new PublishError('CASE_FILES_MISSING', 409, `case ${row.id} has no files`);
    }
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(row.group_id) || !Number.isInteger(row.case_index) || row.case_index < 1) {
      throw new PublishError('CASE_FILES_MISSING', 409, `case ${row.id} has an invalid group/index`);
    }
    const points = groupPoints.get(row.group_id)?.[row.case_index - 1];
    if (points === undefined) {
      throw new PublishError(
        'PLAN_MISMATCH',
        409,
        `case ${row.id} does not match the data plan group ${row.group_id}-${row.case_index}`,
      );
    }
    const inputAbs = resolve(dataRoot, row.input_path);
    const outputAbs = resolve(dataRoot, row.output_path);
    if (
      !isInsideDataRoot(inputAbs) ||
      !isInsideDataRoot(outputAbs) ||
      !existsSync(inputAbs) ||
      !existsSync(outputAbs)
    ) {
      throw new PublishError('CASE_FILES_MISSING', 409, `case ${row.id} files are missing`);
    }
    const inputName = `${row.group_id}-${row.case_index}.in`;
    const outputName = `${row.group_id}-${row.case_index}.out`;
    try {
      copyFileSync(inputAbs, join(dataDir, inputName));
      copyFileSync(outputAbs, join(dataDir, outputName));
    } catch (error) {
      throw new PublishError(
        'CASE_FILES_MISSING',
        409,
        `case ${row.id} files could not be copied: ${(error as Error).message}`,
      );
    }
    publishCases.push({
      row,
      item: {
        inputPath: `problems/${problemId}/data/authoring-${jobId}/${inputName}`,
        outputPath: `problems/${problemId}/data/authoring-${jobId}/${outputName}`,
        points,
        subtaskId: 0,
      },
    });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const subtaskIds = replaceSubtasks(
      db,
      problemId,
      plan.groups.map((group) => ({
        name: group.name,
        points: group.points,
        aggregation: 'sum',
      })),
    );
    const idByGroup = new Map(plan.groups.map((group, index) => [group.id, subtaskIds[index]]));
    for (const { row, item } of publishCases) {
      item.subtaskId = idByGroup.get(row.group_id) ?? 0;
    }
    replaceTestcases(
      db,
      problemId,
      publishCases.map(({ item }) => item),
    );
    db.prepare('UPDATE problems SET time_ms = ?, memory_mb = ? WHERE id = ?').run(
      plan.limits.timeMs,
      plan.limits.memoryMb,
      problemId,
    );
    markGenerationJobPublished(db, jobId, options.now ?? Date.now());
    db.exec('COMMIT');
    return {
      testcases: publishCases.length,
      subtasks: subtaskIds.length,
      warnings,
      report,
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reportDisk(snapshots: ReturnType<typeof toGateCaseSnapshot>[]): number {
  return snapshots.reduce((sum, row) => sum + row.inputBytes + row.outputBytes, 0);
}
