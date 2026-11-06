import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { unzipSync } from 'fflate';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { hashPassword } from '../security/password.js';
import { submitSource } from '../services/submissions.js';
import { getProblem } from '../storage/repos/problems.js';
import {
  addBatchItem,
  createBatchJob,
  getBatchJob,
  listBatchItems,
  setBatchStatus,
} from '../storage/repos/batches.js';
import { getSubmission } from '../storage/repos/submissions.js';
import { createUser, getUserByUsername } from '../storage/repos/users.js';

export interface AdminBatchRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
}

const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c']);
const SOURCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.cpp': 'cpp17',
  '.cc': 'cpp17',
  '.cxx': 'cpp17',
  '.c': 'c11',
};

// Batch upload limit for admin routes – very large (10 GB) so admins are never
// blocked by the body-size parser when importing student lists or bulk data.
const MAX_BATCH_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

function safePath(name: string): string | null {
  const normalized = normalize(name).replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) return null;
  return normalized;
}

function zipEntries(body: Buffer): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(body));
}

export function registerAdminBatchRoutes(
  app: FastifyInstance,
  options: AdminBatchRouteOptions,
): void {
  const guard = options.adminGuard;

  app.post(
    '/api/admin/batch/upload',
    { preHandler: guard, bodyLimit: MAX_BATCH_UPLOAD_BYTES },
    async (request, reply) => {
      const body = request.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_BODY' } });
      }
      let files: Record<string, Uint8Array>;
      try {
        files = zipEntries(body);
      } catch (err) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_ZIP', message: (err as Error).message },
        });
      }
      const uploadDir = join(options.config.dataDir, 'uploads', 'batch');
      mkdirSync(uploadDir, { recursive: true });
      const uploadId = randomUUID();
      writeFileSync(join(uploadDir, `${uploadId}.zip`), body);
      const paths = Object.keys(files)
        .filter((name) => !name.endsWith('/'))
        .map((name) => safePath(name))
        .filter((name): name is string => name !== null)
        .sort();
      return reply.code(201).send({ ok: true, data: { uploadId, files: paths } });
    },
  );

  app.post<{
    Body: {
      uploadId?: string;
      problemId?: number;
      studentLevel?: number;
      problemLevel?: number;
      problemMap?: Record<string, number>;
      language?: string;
    };
  }>('/api/admin/batch/run', { preHandler: guard }, async (request, reply) => {
    const { uploadId } = request.body ?? {};
    const problemId = Number(request.body?.problemId);
    const studentLevel = Math.max(1, Math.floor(Number(request.body?.studentLevel ?? 1)));
    const problemLevel = Math.floor(Number(request.body?.problemLevel ?? 0));
    const multiProblem = problemLevel > 0;
    const language = request.body?.language ?? 'cpp17';
    if (!uploadId || (!multiProblem && !Number.isInteger(problemId))) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_REQUEST' } });
    }
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_UPLOAD_ID' } });
    }
    const zipPath = join(options.config.dataDir, 'uploads', 'batch', `${uploadId}.zip`);
    if (!existsSync(zipPath)) {
      return reply.code(404).send({ ok: false, error: { code: 'UPLOAD_NOT_FOUND' } });
    }
    if (!multiProblem && !getProblem(options.db, problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'PROBLEM_NOT_FOUND' } });
    }

    let files: Record<string, Uint8Array>;
    try {
      files = zipEntries(readFileSync(zipPath));
    } catch (err) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'BAD_ZIP', message: (err as Error).message },
      });
    }

    const problemMap = new Map<string, number>();
    for (const [folder, value] of Object.entries(request.body?.problemMap ?? {})) {
      const id = Number(value);
      if (Number.isInteger(id) && getProblem(options.db, id)) problemMap.set(folder, id);
    }
    const resolveProblem = (folder: string): number | null => {
      if (problemMap.has(folder)) return problemMap.get(folder)!;
      const numeric = Number(folder);
      if (Number.isInteger(numeric) && getProblem(options.db, numeric)) return numeric;
      return null;
    };

    const sources = new Map<
      string,
      { path: string; code: string; student: string; problemId: number }
    >();
    const unresolved = new Set<string>();
    const entries = Object.entries(files).sort(([left], [right]) => left.localeCompare(right));
    for (const [rawName, content] of entries) {
      if (content.length === 0) {
        continue;
      }
      if (rawName.endsWith('/')) continue;
      const relative = safePath(rawName);
      if (!relative) {
        return reply.code(400).send({ ok: false, error: { code: 'UNSAFE_PATH', message: rawName } });
      }
      const parts = relative.split('/');
      const maxLevel = Math.max(studentLevel, multiProblem ? problemLevel : studentLevel);
      if (parts.length <= maxLevel) continue;
      const extension = relative.slice(relative.lastIndexOf('.')).toLowerCase();
      if (!SOURCE_EXTENSIONS.has(extension)) continue;
      const student = parts[studentLevel - 1];
      if (!student) continue;
      const sourceProblemId = multiProblem
        ? resolveProblem(parts[problemLevel - 1] ?? '')
        : problemId;
      if (!sourceProblemId) {
        unresolved.add(parts[problemLevel - 1] ?? '(empty)');
        continue;
      }
      const key = `${student}\u0000${sourceProblemId}`;
      if (sources.has(key)) continue;
      sources.set(key, {
        path: relative,
        code: Buffer.from(content).toString('utf8'),
        student,
        problemId: sourceProblemId,
      });
    }
    if (sources.size === 0) {
      if (unresolved.size > 0) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'UNMAPPED_PROBLEMS',
            message: `no problem mapping for folders: ${[...unresolved].join(', ')}`,
          },
        });
      }
      return reply.code(400).send({
        ok: false,
        error: { code: 'NO_SOURCES', message: 'no .cpp sources found at the selected level' },
      });
    }

    const batchId = createBatchJob(options.db, {
      problemId: multiProblem ? 0 : problemId,
      studentLevel,
    });
    const created: Array<{ student: string; problemId: number; submissionId: number }> = [];
    for (const source of [...sources.values()].sort(
      (a, b) =>
        a.student.localeCompare(b.student) || a.problemId - b.problemId,
    )) {
      const student = source.student;
      const username = `batch_${student}`.slice(0, 64);
      let user = getUserByUsername(options.db, username);
      if (!user) {
        const userId = createUser(options.db, {
          username,
          passwordHash: hashPassword(randomUUID()),
          realName: student,
          role: 'contestant',
        });
        user = getUserByUsername(options.db, username);
        if (!user || user.id !== userId) {
          // Fallback: create a minimal synthetic user if user fetch failed
          const fallbackUserId = createUser(options.db, {
            username: `batch_${student}`.slice(0, 64),
            passwordHash: hashPassword(randomUUID()),
            realName: student,
            role: 'contestant',
          });
          const fallbackUser = getUserByUsername(options.db, `batch_${student}`.slice(0, 64));
          if (!fallbackUser) {
            return reply.code(500).send({ ok: false, error: { code: 'USER_CREATE_FAILED' } });
          }
          // Clean up the first failed create (id mismatch) if it exists
          if (user && user.id !== fallbackUser.id) {
            options.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
          }
          user = fallbackUser;
        }
      }
      const { id } = submitSource(
        { db: options.db, config: options.config },
        {
          userId: user.id,
          problemId: source.problemId,
          language: SOURCE_LANGUAGE_BY_EXTENSION[source.path.slice(source.path.lastIndexOf('.'))] ?? language,
          code: source.code,
          contestId: null,
          skipCooldown: true,
          // Admin batch pipelines submit on behalf of synthetic students, so the
          // practice read ACL does not apply.
          skipAccessCheck: true,
        },
      );
      addBatchItem(options.db, {
        batchId,
        student,
        sourcePath: source.path,
        submissionId: id,
        problemId: source.problemId,
      });
      created.push({ student, problemId: source.problemId, submissionId: id });
    }
    return reply.code(201).send({
      ok: true,
      data: { id: batchId, count: created.length, items: created, multiProblem },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/batch/:id',
    { preHandler: guard },
    async (request, reply) => {
      const id = Number(request.params.id);
      const job = getBatchJob(options.db, id);
      if (!job) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      const items = listBatchItems(options.db, id).map((item) => {
        const submission = item.submission_id ? getSubmission(options.db, item.submission_id) : null;
        const itemProblemId = item.problem_id ?? job.problem_id;
        return {
          student: item.student,
          problemId: itemProblemId,
          problemTitle: getProblem(options.db, itemProblemId)?.title ?? null,
          sourcePath: item.source_path,
          submissionId: item.submission_id,
          status: submission?.status ?? 'missing',
          verdict: submission?.verdict ?? null,
          score: submission?.score ?? 0,
          timeMs: submission?.time_ms ?? 0,
          memoryKb: submission?.memory_kb ?? 0,
        };
      });
      const done = items.every((item) => item.status === 'finished' || item.status === 'failed');
      const status = done ? 'finished' : 'running';
      if (job.status !== status) setBatchStatus(options.db, id, status);
      return {
        ok: true,
        data: {
          id,
          problemId: job.problem_id,
          multiProblem: job.problem_id === 0,
          status,
          studentLevel: job.student_level,
          items,
        },
      };
    },
  );
}
