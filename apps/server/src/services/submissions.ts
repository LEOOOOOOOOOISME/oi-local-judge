import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SubmissionDto, TestResultDto, Verdict } from '@oij/shared';
import type { Config } from '../config.js';
import { getProblem } from '../storage/repos/problems.js';
import { getLock } from '../storage/repos/hacks.js';
import {
  createSubmission,
  getLatestSubmissionAt,
  getSubmission,
  getTestResults,
  cancelSubmissionState,
  resetSubmissionForRejudge,
  type SubmissionRow,
} from '../storage/repos/submissions.js';
import {
  createJudgeTask,
  enqueueRejudge,
  getJudgeTaskBySubmission,
  getQueuePosition,
} from '../storage/repos/judge.js';
import { transaction } from '../storage/db.js';
import { abortSubmission } from '../judge/cancellation.js';
import { resolveContestSubmission } from './contest-access.js';
import { resolveSubmissionTeam } from './contest-teams.js';
import { canViewProblem, ProblemAclError } from './problem-acl.js';

export const ALLOWED_LANGUAGES = new Set(['cpp17', 'c11', 'objective', 'answer']);
export const MAX_SOURCE_BYTES = 256 * 1024;
/** Minimum interval between two submissions with the same user/problem/contest key. */
export const SUBMIT_COOLDOWN_MS = 10_000;
/** Priority used for admin rejudges so they jump ahead of regular submissions. */
export const REJUDGE_PRIORITY = 100;

/** Thrown when a submission arrives inside the per-key cooldown window. */
export class SubmissionRateLimitError extends Error {
  readonly status = 429;
  readonly code = 'SUBMIT_COOLDOWN';
  readonly retryAfterSec: number;

  constructor(retryAfterSec: number) {
    super(`please wait ${retryAfterSec}s before submitting again`);
    this.name = 'SubmissionRateLimitError';
    this.retryAfterSec = retryAfterSec;
  }
}

/** Thrown when a rejudge targets a submission a worker is actively grading. */
export class SubmissionBusyError extends Error {
  readonly status = 409;
  readonly code = 'SUBMISSION_RUNNING';

  constructor(status: string) {
    super(`submission is already being judged (status: ${status})`);
    this.name = 'SubmissionBusyError';
  }
}

/** Thrown when a submission is already terminal and can no longer be canceled. */
export class SubmissionCannotCancelError extends Error {
  readonly status = 409;
  readonly code = 'CANNOT_CANCEL';

  constructor(status: string) {
    super(`submission cannot be canceled (status: ${status})`);
    this.name = 'SubmissionCannotCancelError';
  }
}

/** Thrown when the caller has no permission to cancel submissions. */
export class SubmissionCancelForbiddenError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';

  constructor() {
    super('insufficient permission to cancel this submission');
    this.name = 'SubmissionCancelForbiddenError';
  }
}

/** Actor allowed to cancel a queued/running judge task. */
export interface CancellationActor {
  id: number;
  role: string;
}

export interface CancelSubmissionResult {
  id: number;
  status: 'canceled';
  taskId: number | null;
}

/** Roles the cancel endpoint is exposed to. */
const CANCEL_ROLES = new Set(['admin', 'setter', 'contestmanager']);
/** Statuses a cancel request may interrupt. */
const CANCELABLE_STATUSES = new Set(['queued', 'compiling', 'running']);

const ACTIVE_JUDGE_STATUSES = new Set(['running', 'compiling']);

export interface SubmitInput {
  userId: number;
  problemId: number;
  language: string;
  code: string;
  contestId?: number | null;
  phase?: string;
  batchId?: number | null;
  /**
   * Explicit team attribution for team contests. Omit to let the server resolve
   * the user's registered team; internal batch/answer submissions stay null.
   */
  teamId?: number | null;
  /** Bypass the cooldown check (admin rejudge/batch internal submissions). */
  skipCooldown?: boolean;
  /**
   * Bypass the practice read ACL. Only internal admin batch pipelines set this;
   * user-facing submissions (contest or practice) must pass the ACL checks.
   */
  skipAccessCheck?: boolean;
  now?: number;
}

export function submitSource(
  deps: { db: DatabaseSync; config: Config },
  input: SubmitInput,
): { id: number } {
  const problem = getProblem(deps.db, input.problemId);
  if (!problem) {
    throw new Error('problem not found');
  }
  // Practice submissions (no contest) require problem read access. Contest
  // submissions are gated by the contest ACL instead.
  if (
    !input.contestId &&
    !input.skipAccessCheck &&
    !canViewProblem(deps.db, problem, { userId: input.userId })
  ) {
    throw new ProblemAclError('PROBLEM_FORBIDDEN', 403, 'problem is not accessible');
  }
  if (!ALLOWED_LANGUAGES.has(input.language)) {
    throw new Error(`unsupported language: ${input.language}`);
  }
  if (problem.type === 'objective' && input.language !== 'objective') {
    throw new Error('objective problems require language objective');
  }
  if (problem.type === 'output-only' && input.language !== 'answer') {
    throw new Error('output-only problems require language answer');
  }
  if (problem.type !== 'objective' && input.language === 'objective') {
    throw new Error('objective answers are only accepted for objective problems');
  }
  if (problem.type !== 'output-only' && input.language === 'answer') {
    throw new Error('output files are only accepted for output-only problems');
  }
  const bytes = Buffer.byteLength(input.code, 'utf8');
  if (bytes === 0) throw new Error('source is empty');
  if (bytes > MAX_SOURCE_BYTES) throw new Error('source is too large');

  let phase = input.phase ?? 'contest';
  let teamId: number | null = null;
  if (input.contestId && !input.phase) {
    const resolved = resolveContestSubmission({
      db: deps.db,
      contestId: input.contestId,
      problemId: input.problemId,
      userId: input.userId,
      now: input.now,
    });
    phase = resolved.phase;
    if (phase === 'contest' && getLock(deps.db, input.contestId, input.userId, input.problemId)) {
      throw new Error('problem is locked; no further submissions are accepted');
    }
    teamId = resolveSubmissionTeam(deps.db, {
      contestId: input.contestId,
      userId: input.userId,
      requestedTeamId: input.teamId ?? undefined,
    });
  } else if (input.contestId) {
    // Internal batch/answer submissions carry an explicit phase and default to
    // no team attribution unless the caller passes one.
    teamId = input.teamId ?? null;
  }

  const nowMs = input.now ?? Date.now();
  if (!input.skipCooldown) {
    const latest = getLatestSubmissionAt(
      deps.db,
      input.userId,
      input.problemId,
      input.contestId ?? null,
    );
    if (latest !== null && nowMs - latest < SUBMIT_COOLDOWN_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((SUBMIT_COOLDOWN_MS - (nowMs - latest)) / 1000));
      throw new SubmissionRateLimitError(retryAfterSec);
    }
  }

  const now = new Date(nowMs);
  const relativeDir = join(
    'submissions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    randomUUID(),
  );
  const absoluteDir = join(deps.config.dataDir, relativeDir);
  mkdirSync(absoluteDir, { recursive: true });
  const fileName =
    input.language === 'objective'
      ? 'answers.json'
      : input.language === 'answer'
        ? 'answers.json'
        : input.language === 'c11'
          ? 'main.c'
          : 'main.cpp';
  const sourcePath = join(relativeDir, fileName);
  writeFileSync(join(deps.config.dataDir, sourcePath), input.code, 'utf8');

  const sourceHash = createHash('sha256').update(input.code).digest('hex');
  const id = createSubmission(deps.db, {
    contestId: input.contestId ?? null,
    problemId: input.problemId,
    userId: input.userId,
    language: input.language,
    sourcePath,
    sourceHash,
    phase,
    batchId: input.batchId,
    teamId,
    createdAt: nowMs,
  });
  createJudgeTask(deps.db, id, input.contestId ? 100 : 50);
  return { id };
}

/**
 * Resets a submission and re-queues its single judge task.
 *
 * Returns `null` when the submission does not exist. A submission whose worker
 * is actively grading it (running/compiling — including the short window where
 * the task was claimed but the submission row is still queued) is rejected with
 * `SubmissionBusyError` (HTTP 409) instead of racing the worker. Rejudging an
 * already queued submission is idempotent: the existing task is reset and no
 * duplicate task row is inserted.
 */
export function rejudgeSubmission(
  db: DatabaseSync,
  submissionId: number,
): { id: number; taskId: number } | null {
  return transaction(db, () => {
    const submission = getSubmission(db, submissionId);
    if (!submission) return null;

    const task = getJudgeTaskBySubmission(db, submissionId);
    const activeStatus = ACTIVE_JUDGE_STATUSES.has(submission.status)
      ? submission.status
      : task && ACTIVE_JUDGE_STATUSES.has(task.status)
        ? task.status
        : null;
    if (activeStatus) {
      throw new SubmissionBusyError(activeStatus);
    }

    resetSubmissionForRejudge(db, submissionId);
    const taskId = enqueueRejudge(db, submissionId, REJUDGE_PRIORITY);
    return { id: submissionId, taskId };
  });
}

/**
 * Cancels a queued, compiling or running judge task.
 *
 * - queued: the task row is finished as `canceled` immediately (no worker owns
 *   it), and the submission becomes `canceled`;
 * - compiling/running: the submission becomes `canceled` and the in-flight
 *   runner is aborted; the scheduler then finishes the task as `canceled`.
 *
 * Returns `null` when the submission does not exist. Terminal submissions
 * (finished/failed/canceled) raise `SubmissionCannotCancelError` (409) and a
 * caller without a cancel-capable role raises `SubmissionCancelForbiddenError`
 * (403).
 */
export function cancelSubmission(
  db: DatabaseSync,
  submissionId: number,
  actor: CancellationActor,
): CancelSubmissionResult | null {
  if (!CANCEL_ROLES.has(actor.role)) {
    throw new SubmissionCancelForbiddenError();
  }
  return transaction(db, () => {
    const submission = getSubmission(db, submissionId);
    if (!submission) return null;
    if (!CANCELABLE_STATUSES.has(submission.status)) {
      throw new SubmissionCannotCancelError(submission.status);
    }

    const task = getJudgeTaskBySubmission(db, submissionId);
    const taskId = task?.id ?? null;
    const now = Date.now();

    cancelSubmissionState(db, submissionId, now);

    if (submission.status === 'queued') {
      // No worker has claimed the task yet, so it can be closed here. Abort a
      // controller anyway in case a worker claimed it in the same tick.
      if (taskId !== null) {
        db.prepare(
          "UPDATE judge_tasks SET status = 'canceled', worker = NULL, heartbeat_at = ? WHERE id = ?",
        ).run(now, taskId);
      }
      abortSubmission(submissionId);
      return { id: submissionId, status: 'canceled', taskId };
    }

    // A worker owns the task: signal it to stop and let the scheduler record the
    // task outcome. Without a live controller there is nothing to wait for, so
    // close the task here as well.
    const aborted = abortSubmission(submissionId);
    if (!aborted && taskId !== null) {
      db.prepare(
        "UPDATE judge_tasks SET status = 'canceled', worker = NULL, heartbeat_at = ? WHERE id = ?",
      ).run(now, taskId);
    }
    return { id: submissionId, status: 'canceled', taskId };
  });
}

function toResultDto(row: {
  testcase_id: number;
  verdict: string;
  time_ms: number;
  memory_kb: number;
  score: number;
  message: string;
}): TestResultDto {
  return {
    testcaseId: row.testcase_id,
    verdict: row.verdict as Verdict,
    timeMs: row.time_ms,
    memoryKb: row.memory_kb,
    score: row.score,
    message: row.message,
  };
}

export function toSubmissionDto(db: DatabaseSync, row: SubmissionRow): SubmissionDto {
  return {
    id: row.id,
    problemId: row.problem_id,
    contestId: row.contest_id,
    userId: row.user_id,
    language: row.language,
    status: row.status as SubmissionDto['status'],
    verdict: (row.verdict as Verdict | null) ?? null,
    score: row.score,
    timeMs: row.time_ms,
    memoryKb: row.memory_kb,
    message: row.message,
    createdAt: new Date(row.created_at).toISOString(),
    judgedAt: row.judged_at ? new Date(row.judged_at).toISOString() : null,
    hackedAt: row.hacked_at ? new Date(row.hacked_at).toISOString() : null,
    hackedBy: row.hacked_by,
    hackId: row.hack_id,
  };
}

export function getSubmissionDetail(
  db: DatabaseSync,
  id: number,
): SubmissionDto | null {
  const row = getSubmission(db, id);
  if (!row) return null;
  return {
    ...toSubmissionDto(db, row),
    // Only a queued submission has a queue position; a claimed/terminal task
    // (or a submission whose worker already moved on) exposes null.
    queuePosition: row.status === 'queued' ? getQueuePosition(db, id) : null,
    results: getTestResults(db, id).map(toResultDto),
  };
}
