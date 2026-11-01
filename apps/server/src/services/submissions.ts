import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { SubmissionDto, TestResultDto, Verdict } from '@oij/shared';
import type { Config } from '../config.js';
import { getProblem } from '../storage/repos/problems.js';
import {
  getContest,
  isContestParticipant,
} from '../storage/repos/contests.js';
import { getLock } from '../storage/repos/hacks.js';
import {
  createSubmission,
  getSubmission,
  getTestResults,
  type SubmissionRow,
} from '../storage/repos/submissions.js';
import { createJudgeTask } from '../storage/repos/judge.js';

export const ALLOWED_LANGUAGES = new Set(['cpp17', 'c11', 'objective', 'answer']);
export const MAX_SOURCE_BYTES = 256 * 1024;

export interface SubmitInput {
  userId: number;
  problemId: number;
  language: string;
  code: string;
  contestId?: number | null;
  phase?: string;
  batchId?: number | null;
}

export function submitSource(
  deps: { db: DatabaseSync; config: Config },
  input: SubmitInput,
): { id: number } {
  const problem = getProblem(deps.db, input.problemId);
  if (!problem || (problem.visibility === 'hidden' && !input.contestId)) {
    throw new Error('problem not found');
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
  if (!input.phase && input.contestId) {
    const contest = getContest(deps.db, input.contestId);
    if (!contest) throw new Error('contest not found');
    const ended =
      contest.status === 'ended' ||
      contest.status === 'archived' ||
      (contest.end_at !== null && Date.now() >= contest.end_at);
    if (ended) {
      if (!isContestParticipant(deps.db, input.contestId, input.userId)) {
        throw new Error('only contest participants may submit corrections');
      }
      phase = 'correction';
    } else if (getLock(deps.db, input.contestId, input.userId, input.problemId)) {
      throw new Error('problem is locked; no further submissions are accepted');
    }
  }

  const now = new Date();
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
  });
  createJudgeTask(deps.db, id, input.contestId ? 100 : 50);
  return { id };
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
    results: getTestResults(db, id).map(toResultDto),
  };
}
