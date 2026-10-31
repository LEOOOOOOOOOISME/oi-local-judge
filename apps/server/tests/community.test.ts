import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'community-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';
let userCookie = '';
let userId = 0;
let contestId = 0;

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  userId = createUser(db, {
    username: 'alice',
    passwordHash: hashPassword('alice123'),
    realName: 'Alice',
    className: '1班',
  });
  contestId = createContest(db, { name: 'Community Cup', problemIds: [] });
  adminCookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  userCookie = `oij.sid=${signSession({ userId, version: 0 }, config.sessionSecret, 3600)}`;
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('community', () => {
  it('creates posts, renders safe markdown and comments', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { cookie: userCookie },
      payload: { category: 'discuss', title: 'Hello', body: '<script>alert(1)</script>\n**bold**' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const postId = (created.json() as { data: { id: number } }).data.id;
    const detail = await app.inject({ method: 'GET', url: `/api/posts/${postId}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as { data: { bodyHtml: string } };
    expect(body.data.bodyHtml).not.toContain('<script>');
    expect(body.data.bodyHtml).toContain('<strong>bold</strong>');

    const comment = await app.inject({
      method: 'POST',
      url: `/api/posts/${postId}/comments`,
      headers: { cookie: adminCookie },
      payload: { body: 'nice' },
    });
    expect(comment.statusCode).toBe(201);
    const notifications = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: userCookie },
    });
    const data = (notifications.json() as { data: Array<{ type: string }> }).data;
    expect(data.some((row) => row.type === 'comment')).toBe(true);
  });

  it('requires moderation for contestant solutions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/posts',
      headers: { cookie: userCookie },
      payload: { category: 'solution', title: 'My solution', body: 'use dp' },
    });
    expect(created.statusCode).toBe(201);
    const postId = (created.json() as { data: { id: number; status: string } }).data;
    expect(postId.status).toBe('pending');
    const hidden = await app.inject({ method: 'GET', url: `/api/posts/${postId.id}` });
    expect(hidden.statusCode).toBe(404);

    const pending = await app.inject({
      method: 'GET',
      url: '/api/admin/posts?status=pending',
      headers: { cookie: adminCookie },
    });
    expect((pending.json() as { data: unknown[] }).data).toHaveLength(1);
    const approved = await app.inject({
      method: 'POST',
      url: `/api/admin/posts/${postId.id}/flags`,
      headers: { cookie: adminCookie },
      payload: { status: 'published', pinned: true },
    });
    expect(approved.statusCode).toBe(200);
    const visible = await app.inject({ method: 'GET', url: `/api/posts/${postId.id}` });
    expect(visible.statusCode).toBe(200);
  });

  it('supports contest clarifications and notifications', async () => {
    const asked = await app.inject({
      method: 'POST',
      url: `/api/contests/${contestId}/clarifications`,
      headers: { cookie: userCookie },
      payload: { question: '数据范围？' },
    });
    expect(asked.statusCode).toBe(201);
    const id = (asked.json() as { data: { id: number } }).data.id;

    const answered = await app.inject({
      method: 'POST',
      url: `/api/admin/contests/${contestId}/clarifications/${id}/answer`,
      headers: { cookie: adminCookie },
      payload: { answer: 'n <= 1e5', public: true },
    });
    expect(answered.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/api/contests/${contestId}/clarifications`,
      headers: { cookie: userCookie },
    });
    const rows = (list.json() as { data: Array<{ answer: string }> }).data;
    expect(rows[0].answer).toBe('n <= 1e5');
    const notifications = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: userCookie },
    });
    expect(
      (notifications.json() as { data: Array<{ type: string }> }).data.some(
        (row) => row.type === 'clarification',
      ),
    ).toBe(true);
  });

  it('sends private messages and lists conversations', async () => {
    const adminId = 1;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/messages/${adminId}`,
      headers: { cookie: userCookie },
      payload: { body: '老师您好' },
    });
    expect(sent.statusCode).toBe(201);
    const conversations = await app.inject({
      method: 'GET',
      url: '/api/messages/conversations',
      headers: { cookie: userCookie },
    });
    expect((conversations.json() as { data: unknown[] }).data).toHaveLength(1);
    const thread = await app.inject({
      method: 'GET',
      url: `/api/messages/${adminId}`,
      headers: { cookie: userCookie },
    });
    const messages = (thread.json() as { data: { messages: Array<{ body: string }> } }).data.messages;
    expect(messages[0].body).toBe('老师您好');
  });
});
