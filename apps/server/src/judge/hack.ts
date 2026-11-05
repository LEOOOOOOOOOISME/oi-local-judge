import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getAsset } from '../storage/repos/assets.js';
import { getContest } from '../storage/repos/contests.js';
import {
  getHack,
  updateHack,
} from '../storage/repos/hacks.js';
import {
  getOfficialScore,
  upsertOfficialScore,
} from '../storage/repos/official-scores.js';
import { getProblem, type TestcaseRow } from '../storage/repos/problems.js';
import {
  clearSubmissionHacked,
  getSubmission,
  listUnhackedContestSubmissions,
  markSubmissionHacked,
} from '../storage/repos/submissions.js';
import { ensureChecker } from './checker-cache.js';
import { ensureCompiledProgram } from './compile-cache.js';
import { judgeTestcase, JUDGE_WALL_CLOCK_BUFFER_MS, resolveDataPath } from './pipeline.js';
import { runSandboxed } from './runner.js';
import { runValidator } from './validator.js';
import { freezeOfficialAfterHack } from '../services/official-freeze.js';
import { invalidateOfficialRanking } from '../services/official-ranking.js';

export function recomputeOfficialCell(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  problemId: number,
): void {
  // Synchronous from here on, so clearing first cannot let a reader re-cache
  // the pre-hack result between the invalidation and the upserts below.
  invalidateOfficialRanking(db, contestId);
  const cell = getOfficialScore(db, contestId, userId, problemId);
  const remaining = listUnhackedContestSubmissions(db, contestId, userId, problemId);
  const best = remaining[0];
  if (best) {
    upsertOfficialScore(db, {
      contestId,
      userId,
      problemId,
      score: best.score,
      verdict: best.verdict ?? 'WA',
      source: 'online',
      submissionId: best.id,
    });
    return;
  }
  if (cell && cell.batch_score !== null && cell.batch_score !== undefined) {
    upsertOfficialScore(db, {
      contestId,
      userId,
      problemId,
      score: cell.batch_score,
      verdict: cell.batch_verdict ?? 'WA',
      source: 'batch',
      batchId: cell.batch_id,
      batchScore: cell.batch_score,
      batchVerdict: cell.batch_verdict,
    });
    return;
  }
  upsertOfficialScore(db, {
    contestId,
    userId,
    problemId,
    score: 0,
    verdict: 'WA',
    source: 'online',
    submissionId: null,
  });
}

export function recomputeOfficialAfterHack(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  problemId: number,
  targetSubmissionId: number,
): void {
  // See recomputeOfficialCell: invalidating before the synchronous upserts is
  // equivalent to invalidating after them and covers every early return.
  invalidateOfficialRanking(db, contestId);
  const cell = getOfficialScore(db, contestId, userId, problemId);
  if (!cell || cell.submission_id !== targetSubmissionId) return;
  const remaining = listUnhackedContestSubmissions(db, contestId, userId, problemId);
  const best = remaining[0];
  if (best) {
    upsertOfficialScore(db, {
      contestId,
      userId,
      problemId,
      score: best.score,
      verdict: best.verdict ?? 'WA',
      source: 'online',
      submissionId: best.id,
    });
    return;
  }
  if (cell.batch_score !== null && cell.batch_score !== undefined) {
    upsertOfficialScore(db, {
      contestId,
      userId,
      problemId,
      score: cell.batch_score,
      verdict: cell.batch_verdict ?? 'WA',
      source: 'batch',
      batchId: cell.batch_id,
      batchScore: cell.batch_score,
      batchVerdict: cell.batch_verdict,
    });
    return;
  }
  upsertOfficialScore(db, {
    contestId,
    userId,
    problemId,
    score: 0,
    verdict: 'WA',
    source: 'online',
    submissionId: null,
  });
}

export function promoteHack(db: DatabaseSync, hackId: number): void {
  const hack = getHack(db, hackId);
  if (!hack) throw new Error('hack not found');
  const target = getSubmission(db, hack.target_submission_id);
  if (!target) throw new Error('hack target not found');
  if (target.hacked_at === null) {
    markSubmissionHacked(db, target.id, hack.hacker_id, hackId);
    recomputeOfficialAfterHack(db, hack.contest_id, target.user_id, target.problem_id, target.id);
  }
  freezeOfficialAfterHack(db, hack.contest_id);
  updateHack(db, hackId, {
    status: 'promoted',
    verdict: hack.verdict ?? 'AC',
    message: hack.message || 'promoted by administrator',
  });
}

export function revertHack(db: DatabaseSync, hackId: number): void {
  const hack = getHack(db, hackId);
  if (!hack) throw new Error('hack not found');
  const target = getSubmission(db, hack.target_submission_id);
  if (!target) throw new Error('hack target not found');
  if (target.hack_id !== hack.id) throw new Error('target was not hacked by this record');
  clearSubmissionHacked(db, target.id);
  recomputeOfficialCell(db, hack.contest_id, target.user_id, target.problem_id);
  updateHack(db, hackId, {
    status: 'reverted',
    verdict: hack.verdict,
    message: 'reverted by administrator',
  });
}

export async function judgeHack(
  db: DatabaseSync,
  config: Config,
  hackId: number,
): Promise<void> {
  const hack = getHack(db, hackId);
  if (!hack || hack.status !== 'queued') return;
  updateHack(db, hackId, { status: 'judging' });
  const target = getSubmission(db, hack.target_submission_id);
  const problem = getProblem(db, hack.problem_id);
  if (!target || !problem || target.phase !== 'contest' || target.hacked_at !== null) {
    updateHack(db, hackId, { status: 'failed', message: 'target submission is invalid' });
    return;
  }

  const tmpRoot = join(config.dataDir, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const workdir = mkdtempSync(join(tmpRoot, `hack-${hackId}-`));
  const relativeWorkdir = relative(config.dataDir, workdir).replace(/\\/g, '/');
  const inputPath = join(workdir, 'hack.in');
  const answerPath = join(workdir, 'expected.out');
  const stdOutPath = join(workdir, 'std.out');
  const stdErrPath = join(workdir, 'std.err');

  try {
    try {
      writeFileSync(inputPath, readFileSync(join(config.dataDir, hack.input_path)));
    } catch {
      updateHack(db, hackId, { status: 'failed', message: 'hack input is missing' });
      return;
    }

    const validatorAsset = getAsset(db, problem.id, 'validator');
    if (validatorAsset?.language) {
      const validator = await ensureCompiledProgram({
        gxx: config.gxx,
        dataDir: config.dataDir,
        sourcePath: resolveDataPath(config.dataDir, validatorAsset.path),
        language: validatorAsset.language,
      });
      if (!validator.ok || !validator.exe) {
        updateHack(db, hackId, {
          status: 'unjudgeable',
          message: `validator compilation failed: ${validator.message}`.slice(0, 512),
        });
        return;
      }
      const validated = await runValidator({ validator: validator.exe, input: inputPath, workdir });
      if (!validated.ok) {
        updateHack(db, hackId, {
          status: 'invalid',
          message: `validator rejected input: ${validated.message}`.slice(0, 512),
        });
        return;
      }
    }

    const stdAsset = getAsset(db, problem.id, 'std');
    if (!stdAsset?.language) {
      updateHack(db, hackId, { status: 'unjudgeable', message: 'problem has no std solution' });
      return;
    }
    const std = await ensureCompiledProgram({
      gxx: config.gxx,
      dataDir: config.dataDir,
      sourcePath: resolveDataPath(config.dataDir, stdAsset.path),
      language: stdAsset.language,
    });
    if (!std.ok || !std.exe) {
      updateHack(db, hackId, {
        status: 'unjudgeable',
        message: `std compilation failed: ${std.message}`.slice(0, 512),
      });
      return;
    }
    const stdRun = await runSandboxed({
      runner: config.runnerPath,
      exe: std.exe,
      workdir,
      timeMs: Math.max(1, problem.time_ms),
      wallMs: Math.max(1, problem.time_ms) + JUDGE_WALL_CLOCK_BUFFER_MS,
      memoryMb: Math.max(1, problem.memory_mb),
      processLimit: 1,
      stdinFile: inputPath,
      stdoutFile: stdOutPath,
      stderrFile: stdErrPath,
    });
    if (stdRun.exitCode !== 0 || stdRun.timedOut || stdRun.oom || stdRun.signal !== 0) {
      updateHack(db, hackId, {
        status: 'unjudgeable',
        message: `std failed on this input (exit ${stdRun.exitCode})`,
      });
      return;
    }
    writeFileSync(answerPath, readFileSync(stdOutPath));

    const targetSource = resolveDataPath(config.dataDir, target.source_path);
    const targetCompiled = await ensureCompiledProgram({
      gxx: config.gxx,
      dataDir: config.dataDir,
      sourcePath: targetSource,
      language: target.language,
    });
    if (!targetCompiled.ok || !targetCompiled.exe) {
      updateHack(db, hackId, {
        status: 'failed',
        message: `target compilation failed: ${targetCompiled.message}`.slice(0, 512),
      });
      return;
    }

    let checkerExe: string | undefined;
    if (problem.checker_mode !== 'builtin') {
      if (!problem.checker_path) {
        updateHack(db, hackId, { status: 'unjudgeable', message: 'problem has no checker source' });
        return;
      }
      const checker = await ensureChecker({
        gxx: config.gxx,
        dataDir: config.dataDir,
        sourcePath: resolveDataPath(config.dataDir, problem.checker_path),
      });
      if (!checker.ok || !checker.exe) {
        updateHack(db, hackId, {
          status: 'unjudgeable',
          message: `checker compilation failed: ${checker.message}`.slice(0, 512),
        });
        return;
      }
      checkerExe = checker.exe;
    }

    const testcase: TestcaseRow = {
      id: hackId,
      problem_id: problem.id,
      ordinal: 1,
      input_path: `${relativeWorkdir}/hack.in`,
      output_path: `${relativeWorkdir}/expected.out`,
      points: 100,
      subtask_id: null,
      depends_on: null,
      enabled: 1,
    };
    const result = await judgeTestcase({
      config,
      problem,
      testcase,
      workdir,
      outExe: targetCompiled.exe,
      checkerExe,
    });
    if (result.verdict === 'AC') {
      updateHack(db, hackId, {
        status: 'failed',
        verdict: 'AC',
        message: 'target produced an accepted output',
      });
      return;
    }
    markSubmissionHacked(db, target.id, hack.hacker_id, hackId);
    recomputeOfficialAfterHack(db, hack.contest_id, target.user_id, target.problem_id, target.id);
    freezeOfficialAfterHack(db, hack.contest_id);
    updateHack(db, hackId, {
      status: 'success',
      verdict: result.verdict,
      message: result.message || `target ${result.verdict}`,
    });
  } catch (err) {
    updateHack(db, hackId, {
      status: 'unjudgeable',
      message: (err instanceof Error ? err.message : String(err)).slice(0, 512),
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
