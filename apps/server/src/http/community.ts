import MarkdownIt from 'markdown-it';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  addNotification,
  answerClarification,
  addComment,
  createPost,
  createClarification,
  getClarification,
  getPost,
  listAllPosts,
  listClarifications,
  listComments,
  listConversation,
  listConversationPartners,
  listNotifications,
  listPosts,
  markConversationRead,
  markNotificationsRead,
  sendMessage,
  setPostFlags,
} from '../storage/repos/community.js';
import { getContest } from '../storage/repos/contests.js';
import { getUserById, type UserRow } from '../storage/repos/users.js';
import { authenticateRequest, requireAuth } from '../security/auth.js';

export interface CommunityRouteOptions {
  db: DatabaseSync;
  config: Config;
}

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const POST_CATEGORIES = new Set(['discuss', 'solution', 'announcement']);

function renderMarkdown(value: string): string {
  return md.render(value);
}

function authorDto(db: DatabaseSync, userId: number) {
  const user = getUserById(db, userId);
  return user
    ? {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        className: user.class_name,
      }
    : { id: userId, username: 'unknown', realName: null, className: null };
}

function roleOf(user: UserRow | undefined): string {
  return user?.role ?? 'guest';
}

/** Small in-memory per-user rate limiter (LAN deployment, resets on restart). */
function createLimiter() {
  const buckets = new Map<string, number[]>();
  return (key: string, limit: number, windowMs: number): boolean => {
    const now = Date.now();
    const timestamps = (buckets.get(key) ?? []).filter((value) => now - value < windowMs);
    if (timestamps.length >= limit) {
      buckets.set(key, timestamps);
      return false;
    }
    timestamps.push(now);
    buckets.set(key, timestamps);
    return true;
  };
}

export function registerCommunityRoutes(
  app: FastifyInstance,
  options: CommunityRouteOptions,
): void {
  const auth = requireAuth(options);
  const limiter = createLimiter();

  app.get<{
    Querystring: { category?: string; problemId?: string; contestId?: string; limit?: string };
  }>('/api/posts', async (request) => {
    const rows = listPosts(options.db, {
      category: request.query.category,
      problemId: request.query.problemId ? Number(request.query.problemId) : undefined,
      contestId: request.query.contestId ? Number(request.query.contestId) : undefined,
      limit: request.query.limit ? Number(request.query.limit) : undefined,
    });
    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        category: row.category,
        title: row.title,
        author: authorDto(options.db, row.author_id),
        problemId: row.problem_id,
        contestId: row.contest_id,
        pinned: row.pinned === 1,
        locked: row.locked === 1,
        status: row.status,
        createdAt: row.created_at,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/posts/:id', async (request, reply) => {
    const post = getPost(options.db, Number(request.params.id));
    if (!post || post.status !== 'published') {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    return {
      ok: true,
      data: {
        id: post.id,
        category: post.category,
        title: post.title,
        bodyHtml: renderMarkdown(post.body_md),
        author: authorDto(options.db, post.author_id),
        problemId: post.problem_id,
        contestId: post.contest_id,
        pinned: post.pinned === 1,
        locked: post.locked === 1,
        createdAt: post.created_at,
        comments: listComments(options.db, post.id).map((comment) => ({
          id: comment.id,
          bodyHtml: renderMarkdown(comment.body_md),
          author: authorDto(options.db, comment.author_id),
          createdAt: comment.created_at,
        })),
      },
    };
  });

  app.post<{
    Body: {
      category?: string;
      title?: string;
      body?: string;
      problemId?: number | null;
      contestId?: number | null;
    };
  }>('/api/posts', { preHandler: auth }, async (request, reply) => {
    const body = request.body ?? {};
    const user = request.user!;
    const category = body.category ?? 'discuss';
    if (!POST_CATEGORIES.has(category)) {
      return reply.code(400).send({ ok: false, error: { code: 'BAD_CATEGORY' } });
    }
    if (category === 'announcement' && !['admin', 'setter', 'contestmanager'].includes(user.role)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    if (!body.title?.trim() || !body.body?.trim()) {
      return reply.code(400).send({ ok: false, error: { code: 'EMPTY_POST' } });
    }
    if (!limiter(`post:${user.id}`, 5, 60_000)) {
      return reply.code(429).send({ ok: false, error: { code: 'RATE_LIMITED' } });
    }
    const status =
      category === 'solution' && user.role === 'contestant' ? 'pending' : 'published';
    const id = createPost(options.db, {
      category,
      title: body.title.slice(0, 200),
      bodyMd: body.body.slice(0, 50_000),
      authorId: user.id,
      problemId: body.problemId ?? null,
      contestId: body.contestId ?? null,
      status,
    });
    return reply.code(201).send({ ok: true, data: { id, status } });
  });

  app.post<{ Params: { id: string }; Body: { body?: string } }>(
    '/api/posts/:id/comments',
    { preHandler: auth },
    async (request, reply) => {
      const post = getPost(options.db, Number(request.params.id));
      const user = request.user!;
      if (!post || post.status !== 'published') {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      if (post.locked === 1) {
        return reply.code(403).send({ ok: false, error: { code: 'LOCKED' } });
      }
      if (!request.body?.body?.trim()) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_COMMENT' } });
      }
      if (!limiter(`comment:${user.id}`, 20, 60_000)) {
        return reply.code(429).send({ ok: false, error: { code: 'RATE_LIMITED' } });
      }
      const id = addComment(options.db, {
        postId: post.id,
        authorId: user.id,
        bodyMd: request.body.body.slice(0, 20_000),
      });
      if (post.author_id !== user.id) {
        addNotification(options.db, {
          userId: post.author_id,
          type: 'comment',
          payload: { postId: post.id, commentId: id, title: post.title, by: user.username },
        });
      }
      return reply.code(201).send({ ok: true, data: { id } });
    },
  );

  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/api/admin/posts',
    { preHandler: auth },
    async (request, reply) => {
      if (!['admin', 'setter', 'contestmanager'].includes(request.user!.role)) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN' } });
      }
      const rows = listAllPosts(options.db, {
        status: request.query.status,
        limit: request.query.limit ? Number(request.query.limit) : 100,
      });
      return { ok: true, data: rows };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { status?: string; pinned?: boolean; locked?: boolean };
  }>('/api/admin/posts/:id/flags', { preHandler: auth }, async (request, reply) => {
    if (!['admin', 'setter', 'contestmanager'].includes(request.user!.role)) {
      return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    const post = getPost(options.db, Number(request.params.id));
    if (!post) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    const body = request.body ?? {};
    setPostFlags(options.db, post.id, {
      status: ['published', 'pending', 'hidden'].includes(body.status ?? '')
        ? body.status
        : undefined,
      pinned: body.pinned === undefined ? undefined : body.pinned ? 1 : 0,
      locked: body.locked === undefined ? undefined : body.locked ? 1 : 0,
    });
    return { ok: true, data: null };
  });

  app.get<{ Params: { id: string } }>(
    '/api/contests/:id/clarifications',
    { preHandler: auth },
    async (request) => {
      const rows = listClarifications(
        options.db,
        Number(request.params.id),
        request.user!.id,
      );
      return {
        ok: true,
        data: rows.map((row) => ({
          id: row.id,
          question: row.question,
          answer: row.answer,
          isPublic: row.is_public === 1,
          user: authorDto(options.db, row.user_id),
          createdAt: row.created_at,
          answeredAt: row.answered_at,
        })),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { question?: string } }>(
    '/api/contests/:id/clarifications',
    { preHandler: auth },
    async (request, reply) => {
      const contestId = Number(request.params.id);
      if (!getContest(options.db, contestId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      if (!request.body?.question?.trim()) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_QUESTION' } });
      }
      if (!limiter(`clarify:${request.user!.id}`, 10, 60_000)) {
        return reply.code(429).send({ ok: false, error: { code: 'RATE_LIMITED' } });
      }
      const id = createClarification(options.db, {
        contestId,
        userId: request.user!.id,
        question: request.body.question.slice(0, 10_000),
      });
      return reply.code(201).send({ ok: true, data: { id } });
    },
  );

  app.post<{
    Params: { id: string; clarificationId: string };
    Body: { answer?: string; public?: boolean };
  }>(
    '/api/admin/contests/:id/clarifications/:clarificationId/answer',
    { preHandler: auth },
    async (request, reply) => {
      if (!['admin', 'setter', 'contestmanager'].includes(request.user!.role)) {
        return reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN' } });
      }
      const clarification = getClarification(options.db, Number(request.params.clarificationId));
      if (!clarification || clarification.contest_id !== Number(request.params.id)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      if (!request.body?.answer?.trim()) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_ANSWER' } });
      }
      answerClarification(
        options.db,
        clarification.id,
        request.body.answer.slice(0, 10_000),
        request.body.public !== false,
        request.user!.id,
      );
      addNotification(options.db, {
        userId: clarification.user_id,
        type: 'clarification',
        payload: {
          contestId: clarification.contest_id,
          clarificationId: clarification.id,
          answer: request.body.answer.slice(0, 500),
        },
      });
      return { ok: true, data: null };
    },
  );

  app.get('/api/messages/conversations', { preHandler: auth }, async (request) => {
    const rows = listConversationPartners(options.db, request.user!.id);
    return {
      ok: true,
      data: rows.map((row) => ({
        user: authorDto(options.db, row.userId),
        lastMessage: row.lastMessage,
        lastAt: row.lastAt,
        unread: row.unread,
      })),
    };
  });

  app.get<{ Params: { userId: string } }>(
    '/api/messages/:userId',
    { preHandler: auth },
    async (request, reply) => {
      const otherId = Number(request.params.userId);
      const other = getUserById(options.db, otherId);
      if (!other) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      const rows = listConversation(options.db, request.user!.id, otherId);
      markConversationRead(options.db, request.user!.id, otherId);
      return {
        ok: true,
        data: {
          user: authorDto(options.db, otherId),
          messages: rows.reverse().map((row) => ({
            id: row.id,
            senderId: row.sender_id,
            recipientId: row.recipient_id,
            body: row.body,
            createdAt: row.created_at,
            readAt: row.read_at,
          })),
        },
      };
    },
  );

  app.post<{ Params: { userId: string }; Body: { body?: string } }>(
    '/api/messages/:userId',
    { preHandler: auth },
    async (request, reply) => {
      const recipientId = Number(request.params.userId);
      const recipient = getUserById(options.db, recipientId);
      if (!recipient) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      if (recipientId === request.user!.id) {
        return reply.code(400).send({ ok: false, error: { code: 'SELF_MESSAGE' } });
      }
      if (!request.body?.body?.trim()) {
        return reply.code(400).send({ ok: false, error: { code: 'EMPTY_MESSAGE' } });
      }
      if (!limiter(`dm:${request.user!.id}`, 20, 60_000)) {
        return reply.code(429).send({ ok: false, error: { code: 'RATE_LIMITED' } });
      }
      const id = sendMessage(options.db, {
        senderId: request.user!.id,
        recipientId,
        body: request.body.body.slice(0, 10_000),
      });
      addNotification(options.db, {
        userId: recipientId,
        type: 'message',
        payload: { from: request.user!.id, messageId: id, preview: request.body.body.slice(0, 120) },
      });
      return reply.code(201).send({ ok: true, data: { id } });
    },
  );

  app.get('/api/notifications', { preHandler: auth }, async (request) => ({
    ok: true,
    data: listNotifications(options.db, request.user!.id).map((row) => ({
      id: row.id,
      type: row.type,
      payload: JSON.parse(row.payload_json) as unknown,
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
  }));

  app.post('/api/notifications/read', { preHandler: auth }, async (request) => {
    markNotificationsRead(options.db, request.user!.id);
    return { ok: true, data: null };
  });

  // Optional identity for future per-user visibility in public reads.
  app.addHook('onRequest', async (request) => {
    if (!request.user) {
      const authenticated = authenticateRequest(request, options);
      if (authenticated) request.user = authenticated.user;
    }
  });
}
