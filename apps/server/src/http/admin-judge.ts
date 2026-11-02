// Admin judge lifecycle endpoints.
//
// Rejudging never deletes/recreates a submission: it clears the old judge
// output and re-queues the single `judge_tasks` row that belongs to the
// submission, so the unique constraint on `judge_tasks.submission_id` can never
// be violated. Access is admin/setter/contestmanager only.
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  rejudgeSubmission,
  SubmissionBusyError,
} from '../services/submissions.js';
import { getContest } from '../storage/repos/contests.js';
import { listContestSubmissions } from '../storage/repos/submissions.js';

export interface AdminJudgeRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
}

const DEFAULT_BATCH_STATUSES = ['finished', 'failed'];

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseStringList(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return null;
  }
  return value;
}

export function registerAdminJudgeRoutes(
  app: FastifyInstance,
  options: AdminJudgeRouteOptions,
): void {
  app.post<{ Params: { id: string } }>(
    '/api/admin/submissions/:id/rejudge',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      try {
        const result = rejudgeSubmission(options.db, id);
        if (!result) {
          return reply.code(404).send({
            ok: false,
            error: { code: 'NOT_FOUND', message: `submission ${id} not found` },
          });
        }
        return { ok: true, data: { id: result.id, status: 'queued', taskId: result.taskId } };
      } catch (err) {
        if (err instanceof SubmissionBusyError) {
          return reply.code(409).send({
            ok: false,
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { statuses?: unknown; verdicts?: unknown };
  }>(
    '/api/admin/contests/:id/rejudge',
    { preHandler: options.adminGuard },
    async (request, reply) => {
      const contestId = parseId(request.params.id);
      if (contestId === null) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      if (!getContest(options.db, contestId)) {
        return reply.code(404).send({
          ok: false,
          error: { code: 'NOT_FOUND', message: `contest ${contestId} not found` },
        });
      }

      const body = request.body ?? {};
      const statusesRaw = parseStringList(body.statuses);
      const verdictsRaw = parseStringList(body.verdicts);
      if (statusesRaw === null || verdictsRaw === null) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'BAD_REQUEST',
            message: 'statuses and verdicts must be arrays of strings',
          },
        });
      }
      const statuses =
        statusesRaw && statusesRaw.length > 0 ? statusesRaw : DEFAULT_BATCH_STATUSES;
      const statusFilter = new Set(statuses);
      const verdictFilter = verdictsRaw && verdictsRaw.length > 0 ? new Set(verdictsRaw) : null;

      const ids: number[] = [];
      let skipped = 0;
      for (const row of listContestSubmissions(options.db, contestId)) {
        if (!statusFilter.has(row.status)) continue;
        if (verdictFilter && !verdictFilter.has(row.verdict ?? '')) continue;
        try {
          if (rejudgeSubmission(options.db, row.id)) ids.push(row.id);
        } catch (err) {
          if (!(err instanceof SubmissionBusyError)) throw err;
          skipped += 1;
        }
      }

      return {
        ok: true,
        data: { rejudged: ids.length, skipped, ids },
      };
    },
  );
}
