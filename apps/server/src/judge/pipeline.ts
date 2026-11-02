// Judge pipeline: compile a submission, run every enabled testcase inside the
// native Job Object runner, compare output and persist the verdict.
//
// Phase 1A scope:
//  - C++17 only, compiled with g++ (static link).
//  - Built-in exact comparison; line-trailing whitespace and the final newline
//    are ignored. SPJ is not wired in yet (checker.ts remains Phase 0 code).
//  - Compile error -> verdict CE. Pipeline/internal errors -> failed + SE.
//  - Temporary files live under <dataDir>/tmp and are always removed.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { ensureCompiledProgram } from './compile-cache.js';
import { ensureChecker } from './checker-cache.js';
import {
  gradeObjective,
  parseObjectiveAnswers,
  parseObjectiveConfig,
} from './objective.js';
import { parseOutputAnswers, writeAnswerFiles } from './output-only.js';
import { runInteractive } from './interactive.js';
import { syncOnlineOfficialScore } from './official-score.js';
import { getAsset } from '../storage/repos/assets.js';
import { runChecker, type CheckerMode } from './checker.js';
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
  publish(event: { type: string; data: unknown; room?: string }): void;
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

const VERDICT_PRIORITY: readonly Verdict[] = ['SE', 'MLE', 'TLE', 'OLE', 'RE', 'PE'];

export function decideOverallVerdict(results: readonly JudgedResult[], score = 0): Verdict {
  if (results.length === 0) return 'SE';
  if (results.every((result) => result.verdict === 'AC')) return 'AC';
  for (const candidate of VERDICT_PRIORITY) {
    if (results.some((result) => result.verdict === candidate)) return candidate;
  }
  if (score > 0) return 'PC';
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

export function outputMatches(
  expectedPath: string,
  actualPath: string,
  mode = 'ignore-trailing',
  epsilon = 1e-6,
): boolean {
  const expected = readFileSync(expectedPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const actual = readFileSync(actualPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  switch (mode) {
    case 'exact':
      return expected === actual;
    case 'ignore-all':
      return expected.replace(/\s+/g, '') === actual.replace(/\s+/g, '');
    case 'case-insensitive':
      return normalizeOutput(expected).toLowerCase() === normalizeOutput(actual).toLowerCase();
    case 'float': {
      const expectedTokens = normalizeOutput(expected).split(/\s+/).filter(Boolean);
      const actualTokens = normalizeOutput(actual).split(/\s+/).filter(Boolean);
      if (expectedTokens.length !== actualTokens.length) return false;
      return expectedTokens.every((token, index) => {
        const left = Number(token);
        const right = Number(actualTokens[index]);
        if (Number.isFinite(left) && Number.isFinite(right)) {
          return Math.abs(left - right) <= epsilon * Math.max(1, Math.abs(left));
        }
        return token === actualTokens[index];
      });
    }
    case 'ignore-trailing':
    default:
      return normalizeOutput(expected) === normalizeOutput(actual);
  }
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

/**
 * Rooms a submission update must reach. Contest submissions go to the contest
 * room and to the submitter's user room, so non-contest pages such as
 * `/records` and `/submissions/:id` keep updating. Returns undefined for a
 * non-contest submission, which keeps the global broadcast.
 */
function submissionRooms(db: DatabaseSync, submissionId: number): string[] | undefined {
  try {
    const submission = getSubmission(db, submissionId);
    if (!submission || submission.contest_id === null || submission.contest_id === undefined) {
      return undefined;
    }
    return [`contest:${submission.contest_id}`, `user:${submission.user_id}`];
  } catch {
    return undefined;
  }
}

function publishUpdate(
  db: DatabaseSync,
  submissionId: number,
  events: EventPublisher | undefined,
  data: Record<string, unknown>,
): void {
  if (!events) return;
  const rooms = submissionRooms(db, submissionId);
  // No contest: one global broadcast. Contest: contest room + submitter room;
  // a submitter connected to both rooms sees a duplicate, which the client
  // debounces.
  for (const room of rooms ?? [undefined]) {
    try {
      events.publish({
        type: WS_EVENTS.submissionUpdated,
        data,
        ...(room === undefined ? {} : { room }),
      });
    } catch {
      // A broken event sink must never break judging.
    }
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
  publishUpdate(db, submissionId, events, {
    submissionId,
    status: 'finished',
    verdict,
    score,
    timeMs,
    memoryKb,
    message,
    results,
  });
  syncOnlineOfficialScore(db, submissionId);
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
  publishUpdate(db, submissionId, events, {
    submissionId,
    status: 'failed',
    verdict: 'SE',
    score: 0,
    timeMs: 0,
    memoryKb: 0,
    message: clipped,
  });
}

export async function judgeTestcase(args: {
  config: Config;
  problem: ProblemRow;
  testcase: TestcaseRow;
  workdir: string;
  outExe: string;
  checkerExe?: string;
}): Promise<JudgedResult> {
  const { config, problem, testcase, workdir, outExe, checkerExe } = args;
  const stdoutFile = join(workdir, `case-${testcase.id}.out`);
  const stderrFile = join(workdir, `case-${testcase.id}.err`);
  const inputPath = resolveDataPath(config.dataDir, testcase.input_path);
  const answerPath = resolveDataPath(config.dataDir, testcase.output_path);
  const timeLimitMs = Math.max(1, problem.time_ms);
  const wallLimitMs = timeLimitMs + JUDGE_WALL_CLOCK_BUFFER_MS;

  let stdinFile = inputPath;
  let contestantOutput = stdoutFile;
  if (problem.io_mode === 'file' && problem.input_file && problem.output_file) {
    stdinFile = join(workdir, problem.input_file);
    copyFileSync(inputPath, stdinFile);
    contestantOutput = join(workdir, problem.output_file);
  }

  const run = await runSandboxed({
    runner: config.runnerPath,
    exe: outExe,
    workdir,
    timeMs: timeLimitMs,
    wallMs: wallLimitMs,
    memoryMb: Math.max(1, problem.memory_mb),
    processLimit: 1,
    stdinFile,
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
  // Output limit (OLE) is checked after the resource verdicts MLE/TLE (a
  // process killed for those reasons may have produced partial output) but
  // before RE/WA, so an output bomb is never misreported as a runtime error or
  // a wrong answer.
  const outputLimitMb = Math.max(1, Math.floor(problem.output_mb ?? 64));
  const outputLimitBytes = outputLimitMb * 1024 * 1024;
  const outputBytes = run.stdoutBytes + run.stderrBytes;
  if (outputBytes > outputLimitBytes) {
    return {
      ...base,
      verdict: 'OLE',
      message: clipMessage(
        `output limit exceeded (stdout ${run.stdoutBytes} bytes, stderr ${run.stderrBytes} bytes, limit ${outputLimitMb} MB)`,
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

  if (!existsSync(contestantOutput)) {
    return {
      ...base,
      verdict: 'WA',
      message: problem.io_mode === 'file' ? `output file ${problem.output_file} is missing` : 'no output',
    };
  }

  if (checkerExe) {
    const checked = await runChecker({
      mode: problem.checker_mode as CheckerMode,
      checker: checkerExe,
      input: inputPath,
      output: contestantOutput,
      answer: answerPath,
      workdir,
      timeMs: 10_000,
      fullScore: testcase.points,
    });
    return {
      ...base,
      verdict: checked.status,
      score: checked.score,
      message: clipMessage(checked.message),
    };
  }

  const accepted = outputMatches(answerPath, contestantOutput, problem.compare_mode);
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

  if (problem.type === 'objective') {
    try {
      setSubmissionStatus(db, submissionId, 'running');
      const sourcePath = resolveDataPath(config.dataDir, submission.source_path);
      const objective = parseObjectiveConfig(problem.objective_json);
      if (objective.questions.length === 0) {
        markSubmissionFailed(db, submissionId, events, 'objective problem has no questions');
        return;
      }
      const answers = parseObjectiveAnswers(readFileSync(sourcePath, 'utf8'));
      const graded = gradeObjective(objective, answers);
      persistJudged(
        db,
        submissionId,
        events,
        graded.results,
        decideOverallVerdict(graded.results, graded.score),
        graded.score,
      );
    } catch (err) {
      markSubmissionFailed(
        db,
        submissionId,
        events,
        `objective grading failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (problem.type === 'output-only') {
    const testcases = getTestcases(db, problem.id);
    if (testcases.length === 0) {
      markSubmissionFailed(db, submissionId, events, 'problem has no enabled testcases');
      return;
    }
    const tmpRoot = join(config.dataDir, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const workdir = mkdtempSync(join(tmpRoot, `answer-${submissionId}-`));
    try {
      setSubmissionStatus(db, submissionId, 'running');
      const sourcePath = resolveDataPath(config.dataDir, submission.source_path);
      const answers = parseOutputAnswers(readFileSync(sourcePath, 'utf8'), testcases);
      const answerPaths = writeAnswerFiles(join(workdir, 'answers'), testcases, answers);
      const results = testcases.map((testcase) => {
        const accepted = outputMatches(
          resolveDataPath(config.dataDir, testcase.output_path),
          answerPaths.get(testcase.id)!,
          problem.compare_mode,
        );
        return {
          testcaseId: testcase.id,
          verdict: (accepted ? 'AC' : 'WA') as 'AC' | 'WA',
          timeMs: 0,
          memoryKb: 0,
          score: accepted ? testcase.points : 0,
          message: accepted ? '' : 'output differs from the expected answer',
        };
      });
      const score = results.reduce((sum, result) => sum + result.score, 0);
      persistJudged(
        db,
        submissionId,
        events,
        results,
        decideOverallVerdict(results, score),
        score,
      );
    } catch (err) {
      markSubmissionFailed(
        db,
        submissionId,
        events,
        `output-only grading failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
    return;
  }

  if (problem.type === 'interactive') {
    const testcases = getTestcases(db, problem.id);
    if (testcases.length === 0) {
      markSubmissionFailed(db, submissionId, events, 'problem has no enabled testcases');
      return;
    }
    const interactorAsset = getAsset(db, problem.id, 'interactor');
    if (!interactorAsset?.language) {
      markSubmissionFailed(db, submissionId, events, 'interactive problem has no interactor source');
      return;
    }
    const tmpRoot = join(config.dataDir, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const workdir = mkdtempSync(join(tmpRoot, `interactive-${submissionId}-`));
    try {
      setSubmissionStatus(db, submissionId, 'compiling');
      const sourcePath = resolveDataPath(config.dataDir, submission.source_path);
      const compiled = await ensureCompiledProgram({
        gxx: config.gxx,
        dataDir: config.dataDir,
        sourcePath,
        language: submission.language,
      });
      if (!compiled.ok || !compiled.exe) {
        persistJudged(db, submissionId, events, [], 'CE', 0, clipMessage(compiled.message));
        return;
      }
      const interactor = await ensureCompiledProgram({
        gxx: config.gxx,
        dataDir: config.dataDir,
        sourcePath: resolveDataPath(config.dataDir, interactorAsset.path),
        language: interactorAsset.language,
        includeDir: join(process.cwd(), 'vendor'),
        timeoutMs: 60_000,
      });
      if (!interactor.ok || !interactor.exe) {
        markSubmissionFailed(
          db,
          submissionId,
          events,
          `interactor compilation failed: ${interactor.message}`,
        );
        return;
      }
      setSubmissionStatus(db, submissionId, 'running');
      const results = [];
      for (const testcase of testcases) {
        const inputPath = resolveDataPath(config.dataDir, testcase.input_path);
        const answerPath = resolveDataPath(config.dataDir, testcase.output_path);
        const run = await runInteractive({
          runner: config.interactRunnerPath,
          interactor: interactor.exe,
          contestant: compiled.exe,
          input: inputPath,
          answer: answerPath,
          workdir,
          timeMs: problem.time_ms,
          memoryMb: problem.memory_mb,
          interactorErr: join(workdir, `interactor-${testcase.id}.err`),
          contestantErr: join(workdir, `contestant-${testcase.id}.err`),
        });
        results.push({
          testcaseId: testcase.id,
          verdict: run.verdict,
          timeMs: run.wallMs,
          memoryKb: run.peakMemKb,
          score: run.verdict === 'AC' ? testcase.points : 0,
          message: clipMessage(run.message),
        });
      }
      const score = results.reduce((sum, result) => sum + result.score, 0);
      persistJudged(
        db,
        submissionId,
        events,
        results,
        decideOverallVerdict(results, score),
        score,
      );
    } catch (err) {
      markSubmissionFailed(
        db,
        submissionId,
        events,
        `interactive judging failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
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

    setSubmissionStatus(db, submissionId, 'compiling');
    const compiled = await ensureCompiledProgram({
      gxx: config.gxx,
      dataDir: config.dataDir,
      sourcePath,
      language: submission.language,
    });
    if (!compiled.ok || !compiled.exe) {
      persistJudged(db, submissionId, events, [], 'CE', 0, clipMessage(compiled.message));
      return;
    }
    const outExe = compiled.exe;

    let checkerExe: string | undefined;
    if (problem.checker_mode !== 'builtin') {
      if (!problem.checker_path) {
        markSubmissionFailed(db, submissionId, events, 'problem has no checker source');
        return;
      }
      checkerExe = join(workdir, 'checker.exe');
      const checkerCompiled = await ensureChecker({
        gxx: config.gxx,
        dataDir: config.dataDir,
        sourcePath: resolveDataPath(config.dataDir, problem.checker_path),
        includeDir: join(process.cwd(), 'vendor'),
      });
      if (!checkerCompiled.ok || !checkerCompiled.exe) {
        markSubmissionFailed(
          db,
          submissionId,
          events,
          `checker compilation failed: ${clipMessage(checkerCompiled.message)}`,
        );
        return;
      }
      checkerExe = checkerCompiled.exe;
    }

    setSubmissionStatus(db, submissionId, 'running');
    const results: JudgedResult[] = [];
    const passed = new Set<number>();
    for (const testcase of testcases) {
      const dependencies = (testcase.depends_on ?? '')
        .split(/[,\s]+/)
        .filter(Boolean)
        .map(Number)
        .filter((value) => Number.isInteger(value));
      if (dependencies.some((dependency) => !passed.has(dependency))) {
        results.push({
          testcaseId: testcase.id,
          verdict: 'SK',
          timeMs: 0,
          memoryKb: 0,
          score: 0,
          message: 'skipped: dependency not passed',
        });
        continue;
      }
      const result = await judgeTestcase({
        config,
        problem,
        testcase,
        workdir,
        outExe,
        checkerExe,
      });
      results.push(result);
      if (result.verdict === 'AC') passed.add(testcase.id);
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
      decideOverallVerdict(results, score),
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
