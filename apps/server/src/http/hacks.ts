import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { judgeHack, promoteHack } from '../judge/hack.js';
import { getContest, getContestProblemEntries, isContestParticipant } from '../storage/repos/contests.js';
import {
  createHack,
  getHack,
  getLock,
  listHacks,
  lockProblem,
} from '../storage/repos/hacks.js';
import { getSubmission, listHackTargets } from '../storage/repos/submissions.js';
import { resolveDataPath } from '../judge/pipeline.js';

export interface HackRouteOptions {
  db: DatabaseSync;
  config: Config;
  auth: preHandlerHookHandler;
  adminGuard: preHandlerHookHandler;
}

function contestProblem(
  db: DatabaseSync,
  contestId: number,
  problemId: number,
): boolean {
  return getContestProblemEntries(db, contestId).some((entry) => entry.problem_id === problemId);
}

function hackWindowOpen(contest: {
  start_at: number | null;
  end_at: number | null;
  ranking_rule_json?: string;
}, now = Date.now()): boolean {
  let windowMinutes = 0;
  try {
    const config = JSON.parse(contest.ranking_rule_json || '{}') as {
      hackWindowMinutes?: number;
    };
    windowMinutes = Math.max(0, Number(config.hackWindowMinutes ?? 0));
  } catch {
    windowMinutes = 0;
  }
  if (contest.start_at !== null && now < contest.start_at) return false;
  if (contest.end_at !== null && now > contest.end_at + windowMinutes * 60_000) return false;
  return true;
}

export function registerHackRoutes(app: FastifyInstance, options: HackRouteOptions): void {
  app.post<{ Params: { id: string; problemId: string } }>(
    '/api/contests/:id/problems/:problemId/lock',
    { preHandler: options.auth },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const problemId = Number(request.params.problemId);
      const contest = getContest(options.db, contestId);
      if (!contest) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      if (!isContestParticipant(options.db, contestId, request.user!.id)) {
        return reply.code(403).send({ ok: false, error: { code: 'NOT_PARTICIPANT' } });
      }
      if (!contestProblem(options.db, contestId, problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'PROBLEM_NOT_IN_CONTEST' } });
      }
      if (!hackWindowOpen(contest)) {
        return reply.code(409).send({ ok: false, error: { code: 'HACK_WINDOW_CLOSED' } });
      }
      lockProblem(options.db, contestId, request.user!.id, problemId);
      return { ok: true, data: { locked: true } };
    },
  );

  app.get<{ Params: { id: string; problemId: string; submissionId: string } }>(
    '/api/contests/:id/problems/:problemId/submissions/:submissionId/source',
    { preHandler: options.auth },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const problemId = Number(request.params.problemId);
      if (!getLock(options.db, contestId, request.user!.id, problemId)) {
        return reply.code(403).send({ ok: false, error: { code: 'LOCK_REQUIRED' } });
      }
      const target = getSubmission(options.db, Number(request.params.submissionId));
      if (
        !target ||
        target.contest_id !== contestId ||
        target.problem_id !== problemId ||
        target.phase !== 'contest'
      ) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return {
        ok: true,
        data: {
          submissionId: target.id,
          language: target.language,
          code: readFileSync(resolveDataPath(options.config.dataDir, target.source_path), 'utf8'),
        },
      };
    },
  );

  app.post<{
    Params: { id: string; problemId: string };
    Body: { targetSubmissionId?: number; input?: string };
  }>(
    '/api/contests/:id/problems/:problemId/hacks',
    { preHandler: options.auth, bodyLimit: 1024 * 1024 },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const problemId = Number(request.params.problemId);
      const contest = getContest(options.db, contestId);
      if (!contest) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      if (contest.archived_at !== null) {
        return reply.code(409).send({ ok: false, error: { code: 'CONTEST_ARCHIVED' } });
      }
      if (!hackWindowOpen(contest)) {
        return reply.code(409).send({ ok: false, error: { code: 'HACK_WINDOW_CLOSED' } });
      }
      if (!getLock(options.db, contestId, request.user!.id, problemId)) {
        return reply.code(403).send({ ok: false, error: { code: 'LOCK_REQUIRED' } });
      }
      const target = getSubmission(options.db, Number(request.body?.targetSubmissionId));
      if (
        !target ||
        target.contest_id !== contestId ||
        target.problem_id !== problemId ||
        target.phase !== 'contest' ||
        target.hacked_at !== null
      ) {
        return reply.code(400).send({ ok: false, error: { code: 'BAD_TARGET' } });
      }
      if (target.user_id === request.user!.id) {
        return reply.code(400).send({ ok: false, error: { code: 'CANNOT_HACK_SELF' } });
      }
      const input = request.body?.input;
      if (typeof input !== 'string' || input.length === 0) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_INPUT' } });
      }
      if (Buffer.byteLength(input, 'utf8') > 1024 * 1024) {
        return reply.code(413).send({ ok: false, error: { code: 'INPUT_TOO_LARGE' } });
      }
      const inputPath = `hacks/${contestId}/${randomUUID()}.in`;
      mkdirSync(join(options.config.dataDir, 'hacks', String(contestId)), { recursive: true });
      writeFileSync(join(options.config.dataDir, inputPath), input);
      const hackId = createHack(options.db, {
        contestId,
        problemId,
        hackerId: request.user!.id,
        targetSubmissionId: target.id,
        inputPath,
      });
      void judgeHack(options.db, options.config, hackId).catch(() => {});
      return reply.code(201).send({ ok: true, data: { id: hackId, status: 'queued' } });
    },
  );

  app.get<{ Params: { id: string; hackId: string } }>(
    '/api/contests/:id/hacks/:hackId',
    { preHandler: options.auth },
    async (request, reply) => {
      const hack = getHack(options.db, Number(request.params.hackId));
      if (!hack || hack.contest_id !== Number(request.params.id)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const isOwner = hack.hacker_id === request.user!.id;
      const canView = ['admin', 'setter', 'contestmanager'].includes(request.user!.role);
      if (!isOwner && !canView) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN' } });
      }
      return { ok: true, data: hack };
    },
  );

  app.post<{ Params: { id: string; hackId: string } }>(
    '/api/admin/contests/:id/hacks/:hackId/promote',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const hack = getHack(options.db, Number(request.params.hackId));
      if (!hack || hack.contest_id !== Number(request.params.id)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      try {
        promoteHack(options.db, hack.id);
        return { ok: true, data: { id: hack.id, status: 'promoted' } };
      } catch (err) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'PROMOTE_FAILED', message: (err as Error).message },
        });
      }
    },
  );

  app.get<{ Params: { id: string; problemId: string } }>(
    '/api/contests/:id/problems/:problemId/targets',
    { preHandler: options.auth },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      const problemId = Number(request.params.problemId);
      if (!getLock(options.db, contestId, request.user!.id, problemId)) {
        return reply.code(403).send({ ok: false, error: { code: 'LOCK_REQUIRED' } });
      }
      return {
        ok: true,
        data: listHackTargets(options.db, contestId, problemId, request.user!.id).map((row) => ({
          id: row.id,
          userId: row.user_id,
          verdict: row.verdict,
          score: row.score,
          createdAt: row.created_at,
        })),
      };
    },
  );

  app.get<{ Params: { id: string; problemId: string } }>(
    '/api/contests/:id/problems/:problemId/hacks',
    { preHandler: options.auth },
    async (request) => ({
      ok: true,
      data: listHacks(
        options.db,
        Number(request.params.id),
        Number(request.params.problemId),
      ).map((hack) => ({
        id: hack.id,
        hackerId: hack.hacker_id,
        targetSubmissionId: hack.target_submission_id,
        status: hack.status,
        verdict: hack.verdict,
        message: hack.message,
        createdAt: hack.created_at,
      })),
    }),
  );
}
