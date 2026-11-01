import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { submitSource } from '../services/submissions.js';
import {
  addBatchItem,
  createBatchJob,
  getBatchJob,
  listBatchItems,
  updateBatchJob,
} from '../storage/repos/batches.js';
import {
  addParticipant,
  archiveContest,
  getContest,
  getContestProblemEntries,
  getParticipantRows,
  updateParticipant,
} from '../storage/repos/contests.js';
import {
  getOfficialScore,
  listOfficialScores,
  seedOfficialScoresFromSubmissions,
  upsertOfficialScore,
} from '../storage/repos/official-scores.js';
import { getProblem } from '../storage/repos/problems.js';
import { getSubmission } from '../storage/repos/submissions.js';
import { getUserByUsername } from '../storage/repos/users.js';

export interface ContestBatchRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
}

type BatchMode = 'overwrite' | 'merge' | 'fill';
const MODES = new Set<BatchMode>(['overwrite', 'merge', 'fill']);
const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx']);

function safePath(name: string): string | null {
  const normalized = name.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null;
  return normalized;
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function applyMode(
  mode: BatchMode,
  current: { score: number; verdict: string } | null,
  batchScore: number,
): number {
  if (!current) return batchScore;
  if (mode === 'overwrite') return batchScore;
  if (mode === 'merge') return Math.max(current.score, batchScore);
  return current.score;
}

function refreshBatchStatus(db: DatabaseSync, batchId: number): void {
  const job = getBatchJob(db, batchId);
  if (!job) return;
  const items = listBatchItems(db, batchId);
  if (items.length === 0) {
    updateBatchJob(db, batchId, { status: 'failed' });
    return;
  }
  const submissions = items.map((item) =>
    item.submission_id ? getSubmission(db, item.submission_id) : null,
  );
  if (submissions.some((submission) => !submission)) return;
  if (submissions.some((submission) => submission!.status === 'failed')) {
    if (job.status === 'draft') updateBatchJob(db, batchId, { status: 'failed' });
    return;
  }
  const allFinished = submissions.every((submission) => submission!.status === 'finished');
  if (allFinished && job.status === 'draft') updateBatchJob(db, batchId, { status: 'ready' });
}

function loadContestBatch(db: DatabaseSync, contestId: number, batchId: number) {
  const job = getBatchJob(db, batchId);
  if (!job || job.contest_id !== contestId) return null;
  return { job, items: listBatchItems(db, batchId) };
}

export function registerContestBatchRoutes(
  app: FastifyInstance,
  options: ContestBatchRouteOptions,
): void {
  const guard = options.adminGuard;

  app.post<{
    Params: { id: string };
    Querystring: { studentLevel?: string; problemLevel?: string; problemMap?: string };
  }>('/api/admin/contests/:id/batches', { preHandler: guard }, async (request, reply) => {
    const contestId = Number(request.params.id);
    const contest = getContest(options.db, contestId);
    if (!contest) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    if (contest.mode !== 'oi') {
      return reply.code(400).send({ ok: false, error: { code: 'BATCH_OI_ONLY' } });
    }
    if (contest.archived_at !== null) {
      return reply.code(409).send({ ok: false, error: { code: 'CONTEST_ARCHIVED' } });
    }
    const studentLevel = Math.max(1, Math.floor(Number(request.query.studentLevel ?? 1)));
    const problemLevel = Math.max(1, Math.floor(Number(request.query.problemLevel ?? 0)));
    if (problemLevel < 1) {
      return reply.code(400).send({ ok: false, error: { code: 'PROBLEM_LEVEL_REQUIRED' } });
    }
    let problemMap: Record<string, number> = {};
    try {
      problemMap = request.query.problemMap ? JSON.parse(request.query.problemMap) : {};
    } catch {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_PROBLEM_MAP' } });
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ ok: false, error: { code: 'EMPTY_BODY' } });
    }

    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(new Uint8Array(body));
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_ZIP', message: (err as Error).message },
      });
    }

    const entries = getContestProblemEntries(options.db, contestId);
    const byId = new Map(entries.map((entry) => [entry.problem_id, entry]));
    const byTitle = new Map(
      entries.map((entry) => {
        const problem = getProblem(options.db, entry.problem_id);
        return [normalizeTitle(problem?.title ?? ''), entry.problem_id];
      }),
    );
    const byOrdinal = new Map(entries.map((entry) => [entry.ordinal, entry.problem_id]));
    const resolveProblem = (folder: string): number | null => {
      const mapped = Number(problemMap[folder]);
      if (Number.isInteger(mapped) && byId.has(mapped)) return mapped;
      const numeric = Number(folder);
      if (Number.isInteger(numeric) && byId.has(numeric)) return numeric;
      const byName = byTitle.get(normalizeTitle(folder));
      if (byName) return byName;
      if (/^[A-Za-z]$/.test(folder)) {
        return byOrdinal.get(folder.toUpperCase().charCodeAt(0) - 64) ?? null;
      }
      return null;
    };

    const sources = new Map<
      string,
      { path: string; code: string; student: string; userId: number; problemId: number }
    >();
    const unknownUsers = new Set<string>();
    const unresolvedProblems = new Set<string>();
    const ignoredFiles: string[] = [];
    const maxLevel = Math.max(studentLevel, problemLevel);

    for (const [rawName, content] of Object.entries(files).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      if (rawName.endsWith('/')) continue;
      const relative = safePath(rawName);
      if (!relative) {
        ignoredFiles.push(rawName);
        continue;
      }
      const parts = relative.split('/');
      if (parts.length <= maxLevel) {
        ignoredFiles.push(relative);
        continue;
      }
      const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension)) continue;
      const student = parts[studentLevel - 1];
      const folder = parts[problemLevel - 1];
      const problemId = resolveProblem(folder);
      if (!problemId) {
        unresolvedProblems.add(folder);
        continue;
      }
      const user = getUserByUsername(options.db, student);
      if (!user) {
        unknownUsers.add(student);
        continue;
      }
      const key = `${user.id}:${problemId}`;
      if (sources.has(key)) continue;
      sources.set(key, {
        path: relative,
        code: Buffer.from(content).toString('utf8'),
        student,
        userId: user.id,
        problemId,
      });
    }

    if (sources.size === 0) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: 'NO_SOURCES',
          message: 'no usable .cpp sources found',
          unknownUsers: [...unknownUsers],
          unresolvedProblems: [...unresolvedProblems],
        },
      });
    }

    const batchId = createBatchJob(options.db, {
      problemId: 0,
      studentLevel,
      contestId,
      problemLevel,
      problemMap,
      createdBy: request.user?.id ?? null,
      meta: {
        unknownUsers: [...unknownUsers],
        unresolvedProblems: [...unresolvedProblems],
        ignoredFiles,
      },
      status: 'draft',
    });
    const items: Array<{ student: string; problemId: number; submissionId: number }> = [];
    for (const source of sources.values()) {
      const { id } = submitSource(
        { db: options.db, config: options.config },
        {
          userId: source.userId,
          problemId: source.problemId,
          language: 'cpp17',
          code: source.code,
          contestId,
          phase: 'batch_draft',
          batchId,
        },
      );
      addBatchItem(options.db, {
        batchId,
        student: source.student,
        sourcePath: source.path,
        submissionId: id,
        problemId: source.problemId,
        userId: source.userId,
      });
      items.push({ student: source.student, problemId: source.problemId, submissionId: id });
    }
    return reply.code(201).send({
      ok: true,
      data: { id: batchId, count: items.length, items, unknownUsers: [...unknownUsers], unresolvedProblems: [...unresolvedProblems] },
    });
  });

  app.get<{ Params: { id: string; batchId: string } }>(
    '/api/admin/contests/:id/batches/:batchId',
    { preHandler: guard },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const batchId = Number(request.params.batchId);
      const loaded = loadContestBatch(options.db, contestId, batchId);
      if (!loaded) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      refreshBatchStatus(options.db, batchId);
      const job = getBatchJob(options.db, batchId)!;
      const items = loaded.items.map((item) => {
        const submission = item.submission_id ? getSubmission(options.db, item.submission_id) : null;
        return {
          student: item.student,
          userId: item.user_id,
          sourcePath: item.source_path,
          problemId: item.problem_id,
          problemTitle: item.problem_id
            ? (getProblem(options.db, item.problem_id)?.title ?? null)
            : null,
          submissionId: item.submission_id,
          status: submission?.status ?? 'missing',
          verdict: submission?.verdict ?? null,
          score: submission?.score ?? 0,
          timeMs: submission?.time_ms ?? 0,
          memoryKb: submission?.memory_kb ?? 0,
        };
      });
      return {
        ok: true,
        data: {
          id: batchId,
          contestId,
          status: job.status,
          mode: job.mode,
          studentLevel: job.student_level,
          problemLevel: job.problem_level,
          problemMap: JSON.parse(job.problem_map_json) as Record<string, number>,
          meta: JSON.parse(job.meta_json) as unknown,
          items,
        },
      };
    },
  );

  app.post<{
    Params: { id: string; batchId: string };
    Body: { mode?: string };
  }>('/api/admin/contests/:id/batches/:batchId/preview', { preHandler: guard }, async (request, reply) => {
    const contestId = Number(request.params.id);
    const batchId = Number(request.params.batchId);
    const mode = (request.body?.mode ?? 'merge') as BatchMode;
    if (!MODES.has(mode)) return reply.code(400).send({ ok: false, error: { code: 'BAD_MODE' } });
    const loaded = loadContestBatch(options.db, contestId, batchId);
    if (!loaded) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    refreshBatchStatus(options.db, batchId);
    const job = getBatchJob(options.db, batchId)!;
    if (job.status !== 'ready') {
      return reply.code(409).send({ ok: false, error: { code: 'BATCH_NOT_READY', status: job.status } });
    }
    const official = new Map(
      listOfficialScores(options.db, contestId).map((row) => [
        `${row.user_id}:${row.problem_id}`,
        row,
      ]),
    );
    const rows = loaded.items.map((item) => {
      const submission = item.submission_id
        ? getSubmission(options.db, item.submission_id)
        : null;
      const current = item.user_id && item.problem_id
        ? official.get(`${item.user_id}:${item.problem_id}`) ?? null
        : null;
      const batchScore = submission?.score ?? 0;
      return {
        student: item.student,
        userId: item.user_id,
        problemId: item.problem_id,
        problemTitle: item.problem_id ? getProblem(options.db, item.problem_id)?.title ?? null : null,
        currentScore: current?.score ?? 0,
        currentVerdict: current?.verdict ?? null,
        batchScore,
        batchVerdict: submission?.verdict ?? null,
        afterScore: applyMode(mode, current, batchScore),
      };
    });
    return {
      ok: true,
      data: {
        mode,
        rows,
        changed: rows.filter(
          (row) => row.afterScore !== row.currentScore,
        ).length,
      },
    };
  });

  app.post<{
    Params: { id: string; batchId: string };
    Body: { mode?: string };
  }>('/api/admin/contests/:id/batches/:batchId/publish', { preHandler: guard }, async (request, reply) => {
    const contestId = Number(request.params.id);
    const batchId = Number(request.params.batchId);
    const contest = getContest(options.db, contestId);
    if (!contest) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    if (contest.mode !== 'oi') {
      return reply.code(400).send({ ok: false, error: { code: 'BATCH_OI_ONLY' } });
    }
    if (contest.archived_at !== null) {
      return reply.code(409).send({ ok: false, error: { code: 'CONTEST_ARCHIVED' } });
    }
    if (contest.status === 'frozen') {
      return reply.code(409).send({ ok: false, error: { code: 'CONTEST_FROZEN' } });
    }
    const mode = (request.body?.mode ?? 'merge') as BatchMode;
    if (!MODES.has(mode)) return reply.code(400).send({ ok: false, error: { code: 'BAD_MODE' } });
    const loaded = loadContestBatch(options.db, contestId, batchId);
    if (!loaded) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    refreshBatchStatus(options.db, batchId);
    const job = getBatchJob(options.db, batchId)!;
    if (job.status !== 'ready') {
      return reply.code(409).send({ ok: false, error: { code: 'BATCH_NOT_READY', status: job.status } });
    }

    try {
      options.db.exec('BEGIN');
      if (listOfficialScores(options.db, contestId).length === 0) {
        seedOfficialScoresFromSubmissions(options.db, contestId);
      }
      let published = 0;
      for (const item of loaded.items) {
        const submission = item.submission_id
          ? getSubmission(options.db, item.submission_id)
          : null;
        if (!submission || submission.status !== 'finished' || !item.user_id || !item.problem_id) {
          throw new Error(`batch item ${item.id} is not ready`);
        }
        addParticipant(options.db, contestId, item.user_id);
        const current = getOfficialScore(options.db, contestId, item.user_id, item.problem_id);
        const afterScore = applyMode(mode, current, submission.score);
        const afterVerdict = afterScore === submission.score ? (submission.verdict ?? 'WA') : current!.verdict;
        upsertOfficialScore(options.db, {
          contestId,
          userId: item.user_id,
          problemId: item.problem_id,
          score: afterScore,
          verdict: afterVerdict,
          source: 'batch',
          batchId,
        });
        options.db
          .prepare("UPDATE submissions SET phase = 'contest' WHERE id = ?")
          .run(submission.id);
        options.db
          .prepare(
            'UPDATE batch_items SET score = ?, verdict = ?, time_ms = ?, memory_kb = ? WHERE id = ?',
          )
          .run(
            submission.score,
            submission.verdict ?? 'WA',
            submission.time_ms,
            submission.memory_kb,
            item.id,
          );
        published += 1;
      }
      updateBatchJob(options.db, batchId, { status: 'published', mode });
      options.db.exec('COMMIT');
      return { ok: true, data: { id: batchId, published, mode } };
    } catch (err) {
      options.db.exec('ROLLBACK');
      return reply.code(500).send({
        ok: false,
        error: { code: 'PUBLISH_FAILED', message: (err as Error).message },
      });
    }
  });

  app.post<{ Params: { id: string; batchId: string } }>(
    '/api/admin/contests/:id/batches/:batchId/discard',
    { preHandler: guard },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const batchId = Number(request.params.batchId);
      const loaded = loadContestBatch(options.db, contestId, batchId);
      if (!loaded) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      updateBatchJob(options.db, batchId, { status: 'discarded' });
      return { ok: true, data: null };
    },
  );

  app.post<{ Params: { id: string }; Body: { csv?: string } }>(
    '/api/admin/contests/:id/participants/import',
    { preHandler: guard },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      if (!getContest(options.db, contestId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const csv = request.body?.csv;
      if (!csv) return reply.code(400).send({ ok: false, error: { code: 'EMPTY_CSV' } });
      const existing = new Set(getParticipantRows(options.db, contestId).map((row) => row.user_id));
      const added: string[] = [];
      const skipped: string[] = [];
      const unknown: string[] = [];
      for (const raw of csv.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^username$/i.test(line) || /^用户名/.test(line)) continue;
        const username = line.split(',')[0]?.trim();
        if (!username) continue;
        const user = getUserByUsername(options.db, username);
        if (!user) {
          unknown.push(username);
          continue;
        }
        if (existing.has(user.id)) {
          skipped.push(username);
          continue;
        }
        addParticipant(options.db, contestId, user.id);
        existing.add(user.id);
        added.push(username);
      }
      return { ok: true, data: { added, skipped, unknown } };
    },
  );

  app.patch<{ Params: { id: string; userId: string }; Body: { hidden?: boolean } }>(
    '/api/admin/contests/:id/participants/:userId',
    { preHandler: guard },
    async (request) => {
      updateParticipant(options.db, Number(request.params.id), Number(request.params.userId), {
        hidden: request.body?.hidden,
      });
      return { ok: true, data: null };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/admin/contests/:id/archive',
    { preHandler: guard },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      if (!getContest(options.db, contestId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      archiveContest(options.db, contestId);
      return { ok: true, data: null };
    },
  );
}
