import type { DatabaseSync } from 'node:sqlite';

export interface PostRow {
  id: number;
  category: string;
  title: string;
  body_md: string;
  problem_id: number | null;
  contest_id: number | null;
  author_id: number;
  status: string;
  pinned: number;
  locked: number;
  created_at: number;
  updated_at: number;
}

export interface CommentRow {
  id: number;
  post_id: number;
  author_id: number;
  body_md: string;
  status: string;
  created_at: number;
}

export function createPost(
  db: DatabaseSync,
  input: {
    category: string;
    title: string;
    bodyMd: string;
    authorId: number;
    problemId?: number | null;
    contestId?: number | null;
    status?: string;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO posts(category, title, body_md, problem_id, contest_id, author_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.category,
      input.title,
      input.bodyMd,
      input.problemId ?? null,
      input.contestId ?? null,
      input.authorId,
      input.status ?? 'published',
      Date.now(),
      Date.now(),
    );
  return Number(result.lastInsertRowid);
}

export function getPost(db: DatabaseSync, id: number): PostRow | null {
  return (db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as unknown as PostRow) ?? null;
}

export function listPosts(
  db: DatabaseSync,
  filter: { category?: string; problemId?: number; contestId?: number; limit?: number },
): PostRow[] {
  const clauses: string[] = ["status = 'published'"];
  const params: Array<string | number> = [];
  if (filter.category) {
    clauses.push('category = ?');
    params.push(filter.category);
  }
  if (filter.problemId) {
    clauses.push('problem_id = ?');
    params.push(filter.problemId);
  }
  if (filter.contestId) {
    clauses.push('contest_id = ?');
    params.push(filter.contestId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 30, 1), 100);
  return db
    .prepare(`SELECT * FROM posts WHERE ${clauses.join(' AND ')} ORDER BY pinned DESC, id DESC LIMIT ?`)
    .all(...params, limit) as unknown as PostRow[];
}

export function listAllPosts(
  db: DatabaseSync,
  filter: { status?: string; limit?: number } = {},
): PostRow[] {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 200);
  return db
    .prepare(`SELECT * FROM posts ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as unknown as PostRow[];
}

export function setPostFlags(
  db: DatabaseSync,
  id: number,
  flags: { status?: string; pinned?: number; locked?: number },
): void {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (flags.status !== undefined) {
    sets.push('status = ?');
    values.push(flags.status);
  }
  if (flags.pinned !== undefined) {
    sets.push('pinned = ?');
    values.push(flags.pinned);
  }
  if (flags.locked !== undefined) {
    sets.push('locked = ?');
    values.push(flags.locked);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  values.push(Date.now());
  db.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
}

export function addComment(
  db: DatabaseSync,
  input: { postId: number; authorId: number; bodyMd: string },
): number {
  const result = db
    .prepare('INSERT INTO comments(post_id, author_id, body_md, created_at) VALUES (?, ?, ?, ?)')
    .run(input.postId, input.authorId, input.bodyMd, Date.now());
  return Number(result.lastInsertRowid);
}

export function listComments(db: DatabaseSync, postId: number): CommentRow[] {
  return db
    .prepare("SELECT * FROM comments WHERE post_id = ? AND status = 'published' ORDER BY id")
    .all(postId) as unknown as CommentRow[];
}

export interface ClarificationRow {
  id: number;
  contest_id: number;
  user_id: number;
  question: string;
  answer: string | null;
  is_public: number;
  answered_by: number | null;
  created_at: number;
  answered_at: number | null;
}

export function createClarification(
  db: DatabaseSync,
  input: { contestId: number; userId: number; question: string },
): number {
  const result = db
    .prepare('INSERT INTO clarifications(contest_id, user_id, question, created_at) VALUES (?, ?, ?, ?)')
    .run(input.contestId, input.userId, input.question, Date.now());
  return Number(result.lastInsertRowid);
}

export function listClarifications(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): ClarificationRow[] {
  return db
    .prepare(
      `SELECT * FROM clarifications
       WHERE contest_id = ? AND (is_public = 1 OR user_id = ?)
       ORDER BY id DESC`,
    )
    .all(contestId, userId) as unknown as ClarificationRow[];
}

export function answerClarification(
  db: DatabaseSync,
  id: number,
  answer: string,
  isPublic: boolean,
  answeredBy: number,
): void {
  db.prepare(
    'UPDATE clarifications SET answer = ?, is_public = ?, answered_by = ?, answered_at = ? WHERE id = ?',
  ).run(answer, isPublic ? 1 : 0, answeredBy, Date.now(), id);
}

export function getClarification(db: DatabaseSync, id: number): ClarificationRow | null {
  return (
    (db.prepare('SELECT * FROM clarifications WHERE id = ?').get(id) as unknown as ClarificationRow) ??
    null
  );
}

export interface MessageRow {
  id: number;
  sender_id: number;
  recipient_id: number;
  body: string;
  read_at: number | null;
  created_at: number;
}

export function sendMessage(
  db: DatabaseSync,
  input: { senderId: number; recipientId: number; body: string },
): number {
  const result = db
    .prepare('INSERT INTO messages(sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)')
    .run(input.senderId, input.recipientId, input.body, Date.now());
  return Number(result.lastInsertRowid);
}

export function listConversation(
  db: DatabaseSync,
  userId: number,
  otherId: number,
  limit = 100,
): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
       ORDER BY id DESC LIMIT ?`,
    )
    .all(userId, otherId, otherId, userId, Math.min(limit, 200)) as unknown as MessageRow[];
}

export function listConversationPartners(
  db: DatabaseSync,
  userId: number,
): Array<{ userId: number; lastMessage: string; lastAt: number; unread: number }> {
  const rows = db
    .prepare(
      `SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other,
              body AS last_message, created_at AS last_at
       FROM messages WHERE sender_id = ? OR recipient_id = ?
       ORDER BY id DESC`,
    )
    .all(userId, userId, userId) as unknown as Array<{
    other: number;
    last_message: string;
    last_at: number;
  }>;
  const unreadRows = db
    .prepare(
      'SELECT sender_id AS other, COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL GROUP BY sender_id',
    )
    .all(userId) as unknown as Array<{ other: number; n: number }>;
  const unread = new Map(unreadRows.map((row) => [row.other, row.n]));
  const seen = new Set<number>();
  const result: Array<{ userId: number; lastMessage: string; lastAt: number; unread: number }> = [];
  for (const row of rows) {
    if (seen.has(row.other)) continue;
    seen.add(row.other);
    result.push({
      userId: row.other,
      lastMessage: row.last_message,
      lastAt: row.last_at,
      unread: unread.get(row.other) ?? 0,
    });
  }
  return result;
}

export function markConversationRead(db: DatabaseSync, userId: number, otherId: number): void {
  db.prepare(
    'UPDATE messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL',
  ).run(Date.now(), userId, otherId);
}

export function addNotification(
  db: DatabaseSync,
  input: { userId: number; type: string; payload: unknown },
): void {
  db.prepare(
    'INSERT INTO notifications(user_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)',
  ).run(input.userId, input.type, JSON.stringify(input.payload ?? {}), Date.now());
}

export function listNotifications(db: DatabaseSync, userId: number, limit = 50) {
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, Math.min(limit, 200)) as unknown as Array<{
    id: number;
    user_id: number;
    type: string;
    payload_json: string;
    read_at: number | null;
    created_at: number;
  }>;
}

export function markNotificationsRead(db: DatabaseSync, userId: number): void {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(
    Date.now(),
    userId,
  );
}
