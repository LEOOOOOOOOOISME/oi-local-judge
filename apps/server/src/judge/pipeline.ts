// Judge pipeline: compile a submission, run every enabled testcase inside the
// native Job Object runner, compare output and persist the verdict.
//
// Phase 1A scope:
//  - C++17 only, compiled with g++ (static link).
//  - Built-in exact comparison; line-trailing whitespace and the final newline
//    are ignored. SPJ is not wired in yet (checker.ts remains Phase 0 code).
//  - Compile error -> verdict CE. Pipeline/internal errors -> failed + SE.
//  - Temporary files live under <dataDir>/tmp and are always removed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { WS_EVENTS, type TestResultDto, type Verdict } from '@oij/shared';

import type { Config } from '../config.js';
import { transaction } from '../storage/db.js';
import {
  getProblem,
  getSubtasks,
  getTestcases,
  type ProblemRow,
  type TestcaseRow,
} from '../storage/repos/problems.js';
import {
  finishSubmission,
  getSubmission,
  replaceTestResults,
  setSubmissionStatus,
} from '../storage/repos/submissions.js';
import { compileSource } from './compiler.js';
import { runSandboxed } from './runner.js';
import { aggregateSubtask } from './subtask.js';

/** Extra wall-clock budget on top of the problem time limit. */
export const JUDGE_WALL_CLOCK_BUFFER_MS = 2_000;
export const JUDGE_RESULT_MESSAGE_LIMIT = 512;

/**
 * NTSTATUS the job object reports when it kills a process for exceeding its
 * per-process user-time quota. Empirically (Windows 11, WinLibs GCC 16.1) the
 * quota kill occasionally arrives as exit code 0xC0000044 with
 * `timedOut=false` instead of the job-violation flag, so the pipeline must map
 * it explicitly instead of calling it RE.
 */
const STATUS_QUOTA_EXCEEDED = 0xc0000044; // 3221225540

export interface EventPublisher {
  publish(event: { type: string; data: unknown }): void;
}

export interface JudgeSubmissionOptions {
  db: DatabaseSync;
  config: Config;
  submissionId: number;
  /** Optional event sink; failures are ignored so they cannot break judging. */
  events?: EventPublisher;
  /** Alias for `events`, matching the phase-1a plan's `hub` parameter name. */
  hub?: EventPublisher;
}

export interface JudgedResult {
  testcaseId: number;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  score: number;
  message: string;
}

const VERDICT_PRIORITY: readonly Verdict[] = ['SE', 'MLE', 'TLE', 'RE', 'PE', 'WA'];

export function decideOverallVerdict(results: readonly JudgedResult[]): Verdict {
  if (results.length === 0) return 'SE';
  if (results.every((result) => result.verdict === 'AC')) return 'AC';
  for (const candidate of VERDICT_PRIORITY) {
    if (results.some((result) => result.verdict === candidate)) return candidate;
  }
  return 'WA';
}

export function resolveDataPath(dataDir: string, storedPath: string): string {
  return isAbsolute(storedPath) ? storedPath : join(dataDir, storedPath);
}

/**
 * Normalizes program output for comparison: strips a UTF-8 BOM, converts CRLF
 * to LF, removes trailing spaces/tabs on every line and drops trailing blank
 * lines. Leading whitespace stays significant ("exact" comparison otherwise).
 */
export function normalizeOutput(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

export function outputMatches(expectedPath: string, actualPath: string): boolean {
  const expected = normalizeOutput(readFileSync(expectedPath, 'utf8'));
  const actual = normalizeOutput(readFileSync(actualPath, 'utf8'));
  return expected === actual;
}

function clipMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= JUDGE_RESULT_MESSAGE_LIMIT) return singleLine;
  return `${singleLine.slice(0, JUDGE_RESULT_MESSAGE_LIMIT)}...`;
}

function firstStderrLine(path: string): string {
  try {
    const text = readFileSync(path, 'utf8').trim();
    const line = text.split(/\r?\n/).find((candidate) => candidate.trim().length > 0);
    return line ? line.trim() : '';
  } catch {
    return '';
  }
}

function publishUpdate(
  events: EventPublisher | undefined,
  data: Record<string, unknown>,
): void {
  if (!events) return;
  try {
    events.publish({ type: WS_EVENTS.submissionUpdated, data });
  } catch {
    // A broken event sink must never break judging.
  }
}

function persistJudged(
  db: DatabaseSync,
  submissionId: number,
  events: EventPublisher | undefined,
  results: readonly JudgedResult[],
  verdict: Verdict,
  score: number,
  message = '',
): void {
  const timeMs = results.reduce((max, result) => Math.max(max, result.timeMs), 0);
  const memoryKb = results.reduce((max, result) => Math.max(max, result.memoryKb), 0);
  transaction(db, () => {
    replaceTestResults(
      db,
      submissionId,
      results.map((result) => ({
        testcaseId: result.testcaseId,
        verdict: result.verdict,
        timeMs: result.timeMs,
        memoryKb: result.memoryKb,
        score: result.score,
        message: result.message,
      })),
    );
    finishSubmission(db, submissionId, {
      status: 'finished',
      verdict,
      score,
      timeMs,
      memoryKb,
      message,
    });
  });
  publishUpdate(events, {
    submissionId,
    status: 'finished',
    verdict,
    score,
    timeMs,
    memoryKb,
    message,
    results,
  });
}

function markSubmissionFailed(
  db: DatabaseSync,
  submissionId: number,
  events: EventPublisher | undefined,
  message: string,
): void {
  const clipped = clipMessage(message);
  transaction(db, () => {
    replaceTestResults(db, submissionId, []);
    finishSubmission(db, submissionId, {
      status: 'failed',
      verdict: 'SE',
      score: 0,
      timeMs: 0,
      memoryKb: 0,
      message: clipped,
    });
  });
  publishUpdate(events, {
    submissionId,
    status: 'failed',
    verdict: 'SE',
    score: 0,
    timeMs: 0,
    memoryKb: 0,
    message: clipped,
  });
}

async function judgeTestcase(args: {
  config: Config;
  problem: ProblemRow;
  testcase: TestcaseRow;
  workdir: string;
  outExe: string;
}): Promise<JudgedResult> {
  const { config, problem, testcase, workdir, outExe } = args;
  const stdoutFile = join(workdir, `case-${testcase.id}.out`);
  const stderrFile = join(workdir, `case-${testcase.id}.err`);
  const timeLimitMs = Math.max(1, problem.time_ms);
  const wallLimitMs = timeLimitMs + JUDGE_WALL_CLOCK_BUFFER_MS;

  const run = await runSandboxed({
    runner: config.runnerPath,
    exe: outExe,
    workdir,
    timeMs: timeLimitMs,
    wallMs: wallLimitMs,
    memoryMb: Math.max(1, problem.memory_mb),
    processLimit: 1,
    stdinFile: resolveDataPath(config.dataDir, testcase.input_path),
    stdoutFile,
    stderrFile,
  });

  const base = {
    testcaseId: testcase.id,
    timeMs: Math.max(0, Math.round(run.cpuMs)),
    memoryKb: Math.max(0, Math.round(run.peakMemKb)),
    score: 0,
  };

  if (run.oom) {
    return {
      ...base,
      verdict: 'MLE',
      message: clipMessage(
        `memory limit exceeded (peak ${run.peakMemKb} KB, limit ${problem.memory_mb} MB)`,
      ),
    };
  }
  // TLE if the wall-clock watchdog fired, the CPU-quota kill surfaced as
  // STATUS_QUOTA_EXCEEDED, or the measured CPU time already exceeded the limit.
  if (
    run.timedOut ||
    run.exitCode === STATUS_QUOTA_EXCEEDED ||
    run.cpuMs > timeLimitMs
  ) {
    return {
      ...base,
      verdict: 'TLE',
      message: clipMessage(
        `time limit exceeded (cpu ${run.cpuMs} ms, wall ${run.wallMs} ms, limit ${timeLimitMs} ms)`,
      ),
    };
  }
  if (run.exitCode !== 0) {
    const stderrLine = firstStderrLine(stderrFile);
    return {
      ...base,
      verdict: 'RE',
      message: clipMessage(
        `exit code ${run.exitCode}${stderrLine ? `: ${stderrLine}` : ''}`,
      ),
    };
  }

  const accepted = outputMatches(
    resolveDataPath(config.dataDir, testcase.output_path),
    stdoutFile,
  );
  if (!accepted) {
    return { ...base, verdict: 'WA', message: 'output differs from the expected answer' };
  }
  return { ...base, verdict: 'AC', score: testcase.points, message: '' };
}

/**
 * Judges one submission: reads problem/testcases, compiles the source, runs all
 * enabled testcases in the sandbox, writes `test_results` and finishes the
 * submission row. Internal failures are recorded as failed + SE instead of
 * rejecting, so a scheduler can keep processing.
 */
export async function judgeSubmission(options: JudgeSubmissionOptions): Promise<void> {
  const { db, config, submissionId } = options;
  const events = options.events ?? options.hub;

  const submission = getSubmission(db, submissionId);
  if (!submission) {
    throw new Error(`submission ${submissionId} not found`);
  }

  const problem = getProblem(db, submission.problem_id);
  if (!problem) {
    markSubmissionFailed(
      db,
      submissionId,
      events,
      `problem ${submission.problem_id} not found`,
    );
    return;
  }

  const testcases = getTestcases(db, problem.id);
  if (testcases.length === 0) {
    markSubmissionFailed(db, submissionId, events, 'problem has no enabled testcases');
    return;
  }
  const subtasks = getSubtasks(db, problem.id);

  const tmpRoot = join(config.dataDir, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const workdir = mkdtempSync(join(tmpRoot, `sub-${submissionId}-`));

  try {
    const sourcePath = resolveDataPath(config.dataDir, submission.source_path);
    const outExe = join(workdir, 'prog.exe');

    setSubmissionStatus(db, submissionId, 'compiling');
    const compiled = await compileSource({
      gxx: config.gxx,
      sourcePath,
      outExe,
      workdir,
      language: submission.language,
    });
    if (!compiled.ok) {
      persistJudged(db, submissionId, events, [], 'CE', 0, clipMessage(compiled.message));
      return;
    }

    setSubmissionStatus(db, submissionId, 'running');
    const results: JudgedResult[] = [];
    for (const testcase of testcases) {
      results.push(await judgeTestcase({ config, problem, testcase, workdir, outExe }));
    }

    const dtoResults: TestResultDto[] = results.map((result) => ({
      testcaseId: result.testcaseId,
      verdict: result.verdict,
      timeMs: result.timeMs,
      memoryKb: result.memoryKb,
      score: result.score,
      message: result.message,
    }));
    const subtaskGroups = subtasks.map((subtask) => ({
      ...subtask,
      testcaseIds: testcases
        .filter((testcase) => testcase.subtask_id === subtask.id)
        .map((testcase) => testcase.id),
    }));
    const score = aggregateSubtask(dtoResults, subtaskGroups);

    persistJudged(
      db,
      submissionId,
      events,
      results,
      decideOverallVerdict(results),
      score,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      markSubmissionFailed(db, submissionId, events, `judge failed: ${message}`);
    } catch {
      // The database itself may be unavailable; the scheduler records the
      // task failure separately.
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
