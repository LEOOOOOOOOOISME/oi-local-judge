import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db.js';

export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'finished'
  | 'failed'
  | 'canceled';

export type GenerationCaseStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'failed'
  | 'blocked'
  | 'canceled';

export interface GenerationJobRow {
  id: number;
  problem_id: number;
  plan_version: number;
  plan_json: string;
  status: GenerationJobStatus;
  completed: number;
  failed: number;
  total: number;
  message: string;
  stats_json: string;
  created_by: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  heartbeat_at: number | null;
}

export interface GenerationCaseRow {
  id: number;
  job_id: number;
  problem_id: number;
  group_id: string;
  group_name: string;
  case_index: number;
  seed: number;
  status: GenerationCaseStatus;
  input_path: string | null;
  output_path: string | null;
  input_sha256: string | null;
  input_bytes: number;
  input_lines: number;
  input_utf8: number;
  output_bytes: number;
  output_lines: number;
  std_exit_code: number | null;
  std_time_ms: number;
  std_memory_kb: number;
  validator_ok: number | null;
  validator_message: string;
  message: string;
  started_at: number | null;
  finished_at: number | null;
}

export interface CreateGenerationCaseInput {
  groupId: string;
  groupName: string;
  index: number;
  seed: number;
}

export interface CreateGenerationJobInput {
  problemId: number;
  planVersion: number;
  planJson: string;
  cases: readonly CreateGenerationCaseInput[];
  createdBy?: number | null;
  now: number;
}

export interface GenerationJobPatch {
  status?: GenerationJobStatus;
  completed?: number;
  failed?: number;
  total?: number;
  message?: string;
  statsJson?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  heartbeatAt?: number | null;
}

export interface GenerationCasePatch {
  status?: GenerationCaseStatus;
  inputPath?: string | null;
  outputPath?: string | null;
  inputSha256?: string | null;
  inputBytes?: number;
  inputLines?: number;
  inputUtf8?: number;
  outputBytes?: number;
  outputLines?: number;
  stdExitCode?: number | null;
  stdTimeMs?: number;
  stdMemoryKb?: number;
  validatorOk?: number | null;
  validatorMessage?: string;
  message?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export function createGenerationJob(
  db: DatabaseSync,
  input: CreateGenerationJobInput,
): number {
  return transaction(db, () => {
    const result = db
      .prepare(
        `INSERT INTO data_generation_jobs(
           problem_id, plan_version, plan_json, status, total, created_by,
           created_at, heartbeat_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        input.problemId,
        input.planVersion,
        input.planJson,
        input.cases.length,
        input.createdBy ?? null,
        input.now,
        input.now,
      );
    const jobId = Number(result.lastInsertRowid);
    const insertCase = db.prepare(
      `INSERT INTO data_generation_cases(
         job_id, problem_id, group_id, group_name, case_index, seed, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const item of input.cases) {
      insertCase.run(
        jobId,
        input.problemId,
        item.groupId,
        item.groupName,
        item.index,
        item.seed,
      );
    }
    return jobId;
  });
}

export function getGenerationJob(db: DatabaseSync, id: number): GenerationJobRow | null {
  return (
    (db.prepare('SELECT * FROM data_generation_jobs WHERE id = ?').get(id) as unknown as
      | GenerationJobRow
      | undefined) ?? null
  );
}

export function listGenerationJobs(
  db: DatabaseSync,
  problemId: number,
  limit = 20,
): GenerationJobRow[] {
  return db
    .prepare(
      'SELECT * FROM data_generation_jobs WHERE problem_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(problemId, limit) as unknown as GenerationJobRow[];
}

export function getActiveGenerationJob(
  db: DatabaseSync,
  problemId: number,
): GenerationJobRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM data_generation_jobs
         WHERE problem_id = ? AND status IN ('queued', 'running')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(problemId) as unknown as GenerationJobRow | undefined) ?? null
  );
}

export function listGenerationCases(
  db: DatabaseSync,
  jobId: number,
): GenerationCaseRow[] {
  return db
    .prepare('SELECT * FROM data_generation_cases WHERE job_id = ? ORDER BY id')
    .all(jobId) as unknown as GenerationCaseRow[];
}

export function getGenerationCase(
  db: DatabaseSync,
  jobId: number,
  caseId: number,
): GenerationCaseRow | null {
  return (
    (db
      .prepare(
        'SELECT * FROM data_generation_cases WHERE job_id = ? AND id = ?',
      )
      .get(jobId, caseId) as unknown as GenerationCaseRow | undefined) ?? null
  );
}

export function updateGenerationJob(
  db: DatabaseSync,
  id: number,
  patch: GenerationJobPatch,
): void {
  const columns: Record<keyof GenerationJobPatch, string> = {
    status: 'status',
    completed: 'completed',
    failed: 'failed',
    total: 'total',
    message: 'message',
    statsJson: 'stats_json',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    heartbeatAt: 'heartbeat_at',
  };
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const key of Object.keys(patch) as Array<keyof GenerationJobPatch>) {
    if (patch[key] === undefined) continue;
    sets.push(`${columns[key]} = ?`);
    values.push(patch[key] as string | number | null);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE data_generation_jobs SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
    id,
  );
}

export function updateGenerationCase(
  db: DatabaseSync,
  id: number,
  patch: GenerationCasePatch,
): void {
  const columns: Record<keyof GenerationCasePatch, string> = {
    status: 'status',
    inputPath: 'input_path',
    outputPath: 'output_path',
    inputSha256: 'input_sha256',
    inputBytes: 'input_bytes',
    inputLines: 'input_lines',
    inputUtf8: 'input_utf8',
    outputBytes: 'output_bytes',
    outputLines: 'output_lines',
    stdExitCode: 'std_exit_code',
    stdTimeMs: 'std_time_ms',
    stdMemoryKb: 'std_memory_kb',
    validatorOk: 'validator_ok',
    validatorMessage: 'validator_message',
    message: 'message',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
  };
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const key of Object.keys(patch) as Array<keyof GenerationCasePatch>) {
    if (patch[key] === undefined) continue;
    sets.push(`${columns[key]} = ?`);
    values.push(patch[key] as string | number | null);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE data_generation_cases SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
    id,
  );
}

export function blockGenerationCases(
  db: DatabaseSync,
  jobId: number,
  message: string,
  now: number,
): void {
  db.prepare(
    `UPDATE data_generation_cases
     SET status = 'blocked', message = ?, finished_at = ?
     WHERE job_id = ? AND status IN ('pending', 'running')`,
  ).run(message, now, jobId);
}

export function requestGenerationCancel(
  db: DatabaseSync,
  jobId: number,
  now: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE data_generation_jobs
       SET status = 'canceled', finished_at = ?, heartbeat_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(now, now, jobId);
  if (Number(result.changes) === 0) return false;
  db.prepare(
    `UPDATE data_generation_cases
     SET status = 'canceled', finished_at = ?
     WHERE job_id = ? AND status IN ('pending', 'running')`,
  ).run(now, jobId);
  return true;
}

export function reconcileInterruptedJobs(
  db: DatabaseSync,
  now = Date.now(),
  staleMs = 60_000,
): number {
  const staleBefore = now - staleMs;
  const rows = db
    .prepare(
      `SELECT id FROM data_generation_jobs
       WHERE status IN ('queued', 'running')
         AND created_at < ?
         AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .all(staleBefore, staleBefore) as unknown as Array<{ id: number }>;
  for (const row of rows) {
    db.prepare(
      `UPDATE data_generation_jobs
       SET status = 'failed', message = ?, finished_at = ?, heartbeat_at = ?
       WHERE id = ?`,
    ).run('进程重启，生成任务中断', now, now, row.id);
    db.prepare(
      `UPDATE data_generation_cases
       SET status = 'blocked', message = ?, finished_at = ?
       WHERE job_id = ? AND status IN ('pending', 'running')`,
    ).run('进程重启，生成任务中断', now, row.id);
  }
  return rows.length;
}
