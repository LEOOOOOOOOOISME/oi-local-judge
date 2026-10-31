// SPJ (special judge) wrapper for Phase 0.
//
// Supported protocols:
//  - testlib: checker <input> <output> <answer>
//      exit 0 = OK, 1 = WA, 2 = PE, 3 = FAIL (checker bug -> SE),
//      7 = _points (partial score, `quitp`): the score is printed on stderr
//      as "points <value> <message>" (verified empirically on Windows/MinGW).
//  - lemon: checker <input> <output> <answer> <full_score> <score_file> <info_file>
//      score is read from score_file (0..full_score).
//
// Timeouts and crashes map to SE; captured output is truncated to 64 KiB.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Verdict } from '@oij/shared';

export const CHECKER_OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LEMON_FULL_SCORE = 100;
const KILL_FALLBACK_MS = 2_000;
const EPSILON = 1e-9;
const TRUNCATED_SUFFIX = '\n...[truncated]';

export type CheckerMode = 'testlib' | 'lemon';

export interface CheckerOptions {
  mode: CheckerMode;
  /** Absolute path of the compiled checker executable. */
  checker: string;
  /** Absolute path of the test input file. */
  input: string;
  /** Absolute path of the contestant output file. */
  output: string;
  /** Absolute path of the expected answer file. */
  answer: string;
  /** Working directory for the checker process. */
  workdir: string;
  /** Wall-clock timeout for the checker process, in milliseconds. */
  timeMs: number;
  /** Lemon only: maximum score. Defaults to 100. */
  fullScore?: number;
}

export interface CheckerResult {
  status: Verdict;
  score: number;
  message: string;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  error?: Error;
}

interface CaptureResult {
  buffer: Buffer;
  truncated: boolean;
}

function appendCapped(current: Buffer, chunk: Buffer): CaptureResult {
  if (current.length >= CHECKER_OUTPUT_LIMIT) {
    return { buffer: current, truncated: true };
  }
  const room = CHECKER_OUTPUT_LIMIT - current.length;
  if (chunk.length <= room) {
    return { buffer: Buffer.concat([current, chunk]), truncated: false };
  }
  return { buffer: Buffer.concat([current, chunk.subarray(0, room)]), truncated: true };
}

function runProcess(
  checker: string,
  args: string[],
  workdir: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let killFallback: NodeJS.Timeout | undefined;

    const snapshot = (): Omit<ProcessResult, 'exitCode' | 'signal' | 'timedOut' | 'error'> => ({
      stdout: stdout.toString('utf8'),
      stderr: stderr.toString('utf8'),
      stdoutTruncated,
      stderrTruncated,
    });

    const finish = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      if (killFallback) {
        clearTimeout(killFallback);
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn(checker, args, {
        cwd: workdir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        exitCode: null,
        signal: null,
        ...snapshot(),
        timedOut: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }

    child.stdout.on('data', (chunk: Buffer) => {
      const captured = appendCapped(stdout, chunk);
      stdout = captured.buffer;
      stdoutTruncated ||= captured.truncated;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const captured = appendCapped(stderr, chunk);
      stderr = captured.buffer;
      stderrTruncated ||= captured.truncated;
    });

    child.once('error', (error) => {
      finish({
        exitCode: null,
        signal: null,
        ...snapshot(),
        timedOut,
        error,
      });
    });

    child.once('close', (code, signal) => {
      finish({
        exitCode: code,
        signal,
        ...snapshot(),
        timedOut,
        ...(timedOut ? { error: new Error(`checker timed out after ${timeoutMs} ms`) } : {}),
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      killFallback = setTimeout(() => {
        finish({
          exitCode: null,
          signal: null,
          ...snapshot(),
          timedOut: true,
          error: new Error(`checker timed out after ${timeoutMs} ms and did not exit`),
        });
      }, KILL_FALLBACK_MS);
    }, timeoutMs);
  });
}

function truncateOutput(text: string): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= CHECKER_OUTPUT_LIMIT) {
    return text;
  }
  const suffix = Buffer.from(TRUNCATED_SUFFIX, 'utf8');
  return Buffer.concat([
    buffer.subarray(0, CHECKER_OUTPUT_LIMIT - suffix.length),
    suffix,
  ]).toString('utf8');
}

function pickMessage(result: ProcessResult): string {
  const text = result.stderr.trim() !== '' ? result.stderr : result.stdout;
  return truncateOutput(text.trim());
}

function describeFailure(result: ProcessResult): string {
  if (result.error) {
    return result.error.message;
  }
  if (result.signal) {
    return `killed by signal ${result.signal}`;
  }
  return `exited with code ${result.exitCode ?? -1}`;
}

function parseTestlibPoints(text: string): number | null {
  // testlib prints the points first: "points 0.5 half credit" (stderr).
  const match = /(?:^|\n)\s*points\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text);
  if (!match) {
    return null;
  }
  const points = Number(match[1]);
  return Number.isFinite(points) ? points : null;
}

function interpretTestlib(result: ProcessResult, fullScore: number | undefined): CheckerResult {
  const message = pickMessage(result);

  if (result.timedOut) {
    return { status: 'SE', score: 0, message: message || 'checker timed out' };
  }
  if (result.error) {
    return { status: 'SE', score: 0, message: `checker failed to run: ${result.error.message}` };
  }

  const code = result.exitCode;
  if (code === 0) {
    return {
      status: 'AC',
      score: fullScore ?? 1,
      message: message || 'ok',
    };
  }
  if (code === 7) {
    const points = parseTestlibPoints(result.stderr) ?? parseTestlibPoints(result.stdout);
    if (points === null) {
      return {
        status: 'SE',
        score: 0,
        message: `checker exited with _points(7) but no parsable points: ${message || '(no output)'}`,
      };
    }
    const maximum = fullScore ?? 1;
    const score = Math.max(0, Math.min(points, maximum));
    if (score <= EPSILON) {
      return { status: 'WA', score: 0, message };
    }
    if (score >= maximum - EPSILON) {
      return { status: 'AC', score, message };
    }
    return { status: 'PC', score, message };
  }
  if (code === 1) {
    return { status: 'WA', score: 0, message: message || 'wrong answer' };
  }
  if (code === 2 || code === 4) {
    return { status: 'PE', score: 0, message: message || 'presentation error' };
  }
  return {
    status: 'SE',
    score: 0,
    message: `checker ${describeFailure(result)}${message ? `: ${message}` : ''}`,
  };
}

async function runLemon(
  options: CheckerOptions,
  fullScore: number,
): Promise<CheckerResult> {
  const token = `${process.pid}-${randomUUID()}`;
  const scoreFile = join(options.workdir, `.oij-score-${token}.txt`);
  const infoFile = join(options.workdir, `.oij-info-${token}.txt`);

  try {
    const result = await runProcess(
      options.checker,
      [
        options.input,
        options.output,
        options.answer,
        String(fullScore),
        scoreFile,
        infoFile,
      ],
      options.workdir,
      options.timeMs,
    );

    const processMessage = pickMessage(result);
    if (result.timedOut) {
      return {
        status: 'SE',
        score: 0,
        message: processMessage || 'lemon checker timed out',
      };
    }
    if (result.error) {
      return {
        status: 'SE',
        score: 0,
        message: `lemon checker failed to run: ${result.error.message}`,
      };
    }
    if (result.exitCode !== 0) {
      return {
        status: 'SE',
        score: 0,
        message: `lemon checker ${describeFailure(result)}${processMessage ? `: ${processMessage}` : ''}`,
      };
    }

    let rawScore: string;
    try {
      rawScore = (await readFile(scoreFile, 'utf8')).trim();
    } catch {
      return {
        status: 'SE',
        score: 0,
        message: `lemon checker did not write a score file (expected ${scoreFile})`,
      };
    }
    if (rawScore === '') {
      return {
        status: 'SE',
        score: 0,
        message: `lemon checker wrote an empty score file (${scoreFile})`,
      };
    }

    const parsedScore = Number(rawScore);
    if (!Number.isFinite(parsedScore)) {
      return {
        status: 'SE',
        score: 0,
        message: `lemon score file is not a finite number: ${rawScore}`,
      };
    }

    let info = '';
    try {
      info = truncateOutput((await readFile(infoFile, 'utf8')).trim());
    } catch {
      info = '';
    }

    let score = parsedScore;
    const warnings: string[] = [];
    if (score < 0) {
      warnings.push(`score ${parsedScore} is below 0, clamped to 0`);
      score = 0;
    } else if (score > fullScore) {
      warnings.push(`score ${parsedScore} is above fullScore ${fullScore}, clamped`);
      score = fullScore;
    }

    const status: Verdict =
      score <= EPSILON ? 'WA' : score >= fullScore - EPSILON ? 'AC' : 'PC';
    const messageParts = [info || processMessage, ...warnings].filter(
      (part): part is string => part !== '',
    );

    return {
      status,
      score,
      message: truncateOutput(messageParts.join(' | ')),
    };
  } finally {
    await Promise.all([
      unlink(scoreFile).catch(() => undefined),
      unlink(infoFile).catch(() => undefined),
    ]);
  }
}

/**
 * Runs a special judge checker and normalizes its protocol into a verdict.
 *
 * testlib partial scores are returned on the protocol's own scale: [0, 1]
 * when `fullScore` is omitted (relative mode), otherwise [0, fullScore].
 * Lemon scores are always on the [0, fullScore] scale (default 100).
 */
export async function runChecker(options: CheckerOptions): Promise<CheckerResult> {
  const timeoutMs =
    Number.isFinite(options.timeMs) && options.timeMs > 0 ? options.timeMs : DEFAULT_TIMEOUT_MS;

  const normalized: CheckerOptions = {
    ...options,
    timeMs: timeoutMs,
  };

  if (normalized.mode === 'testlib') {
    const result = await runProcess(
      normalized.checker,
      [normalized.input, normalized.output, normalized.answer],
      normalized.workdir,
      timeoutMs,
    );
    return interpretTestlib(result, normalized.fullScore);
  }

  if (normalized.mode === 'lemon') {
    const fullScore = normalized.fullScore ?? DEFAULT_LEMON_FULL_SCORE;
    if (!Number.isFinite(fullScore) || fullScore <= 0) {
      return {
        status: 'SE',
        score: 0,
        message: `invalid lemon fullScore: ${String(normalized.fullScore)}`,
      };
    }
    return runLemon(normalized, fullScore);
  }

  return {
    status: 'SE',
    score: 0,
    message: `unknown checker mode: ${String(normalized.mode)}`,
  };
}
