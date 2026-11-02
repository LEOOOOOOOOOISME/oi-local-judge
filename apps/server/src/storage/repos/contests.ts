import type { DatabaseSync } from 'node:sqlite';

export interface ContestRow {
  id: number;
  name: string;
  mode: string;
  start_at: number | null;
  end_at: number | null;
  freeze_at: number | null;
  unfreeze_at: number | null;
  status: string;
  rules_json: string;
  ranking_rule_json: string;
  archived_at: number | null;
  official_frozen_until: number | null;
}

export interface CreateContestInput {
  name: string;
  mode?: string;
  startAt?: number | null;
  endAt?: number | null;
  freezeAt?: number | null;
  problemIds?: number[];
}

export function createContest(db: DatabaseSync, input: CreateContestInput): number {
  const result = db
    .prepare(
      `INSERT INTO contests(name, mode, start_at, end_at, freeze_at, status)
       VALUES (?, ?, ?, ?, ?, 'draft')`,
    )
    .run(
      input.name,
      input.mode ?? 'oi',
      input.startAt ?? null,
      input.endAt ?? null,
      input.freezeAt ?? null,
    );
  const contestId = Number(result.lastInsertRowid);
  const insert = db.prepare(
    'INSERT INTO contest_problems(contest_id, problem_id, ordinal, points) VALUES (?, ?, ?, ?)',
  );
  input.problemIds?.forEach((problemId, index) => {
    insert.run(contestId, problemId, index + 1, 100);
  });
  return contestId;
}

export function getContest(db: DatabaseSync, id: number): ContestRow | null {
  return (db.prepare('SELECT * FROM contests WHERE id = ?').get(id) as unknown as ContestRow) ?? null;
}

export function listContests(db: DatabaseSync): ContestRow[] {
  return db.prepare('SELECT * FROM contests ORDER BY id DESC').all() as unknown as ContestRow[];
}

export function setContestStatus(db: DatabaseSync, id: number, status: string): void {
  db.prepare('UPDATE contests SET status = ? WHERE id = ?').run(status, id);
}

export interface UpdateContestPatch {
  name?: string;
  mode?: string;
  startAt?: number | null;
  endAt?: number | null;
  freezeAt?: number | null;
  unfreezeAt?: number | null;
  rulesJson?: string;
}

export function updateContest(db: DatabaseSync, id: number, patch: UpdateContestPatch): boolean {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  add('name', patch.name);
  add('mode', patch.mode);
  add('start_at', patch.startAt);
  add('end_at', patch.endAt);
  add('freeze_at', patch.freezeAt);
  add('unfreeze_at', patch.unfreezeAt);
  add('rules_json', patch.rulesJson);
  if (sets.length === 0) return false;
  const result = db
    .prepare(`UPDATE contests SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return Number(result.changes) > 0;
}

export function setContestProblems(
  db: DatabaseSync,
  contestId: number,
  entries: Array<{ problemId: number; points: number }>,
): void {
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contestId);
  const insert = db.prepare(
    'INSERT INTO contest_problems(contest_id, problem_id, ordinal, points) VALUES (?, ?, ?, ?)',
  );
  entries.forEach((entry, index) => {
    insert.run(contestId, entry.problemId, index + 1, entry.points);
  });
}

export function listContestParticipants(
  db: DatabaseSync,
  contestId: number,
): Array<{
  user_id: number;
  username: string;
  real_name: string | null;
  class_name: string | null;
  status: string;
  extra_time: number;
}> {
  return db
    .prepare(
      `SELECT p.user_id, u.username, u.real_name, u.class_name, p.status, p.extra_time
       FROM contest_participants p JOIN users u ON u.id = p.user_id
       WHERE p.contest_id = ? ORDER BY u.class_name, u.username`,
    )
    .all(contestId) as unknown as Array<{
    user_id: number;
    username: string;
    real_name: string | null;
    class_name: string | null;
    status: string;
    extra_time: number;
  }>;
}

export function removeParticipant(db: DatabaseSync, contestId: number, userId: number): void {
  db.prepare('DELETE FROM contest_participants WHERE contest_id = ? AND user_id = ?').run(
    contestId,
    userId,
  );
}

export function updateParticipant(
  db: DatabaseSync,
  contestId: number,
  userId: number,
  patch: { extraTime?: number; status?: string; hidden?: boolean },
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.extraTime !== undefined) {
    sets.push('extra_time = ?');
    values.push(Math.max(0, Math.floor(patch.extraTime)));
  }
  if (patch.status !== undefined && ['accepted', 'pending', 'rejected'].includes(patch.status)) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.hidden !== undefined) {
    sets.push('hidden_at = ?');
    values.push(patch.hidden ? Date.now() : null);
  }
  if (sets.length === 0) return;
  db.prepare(
    `UPDATE contest_participants SET ${sets.join(', ')} WHERE contest_id = ? AND user_id = ?`,
  ).run(...values, contestId, userId);
}

export function archiveContest(db: DatabaseSync, contestId: number): void {
  db.prepare("UPDATE contests SET status = 'archived', archived_at = ? WHERE id = ?").run(
    Date.now(),
    contestId,
  );
}

export function deleteContest(db: DatabaseSync, contestId: number): void {
  db.prepare('DELETE FROM contest_problems WHERE contest_id = ?').run(contestId);
  db.prepare('DELETE FROM contest_participants WHERE contest_id = ?').run(contestId);
  db.prepare('DELETE FROM contests WHERE id = ?').run(contestId);
}

export function countContestSubmissions(db: DatabaseSync, contestId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM submissions WHERE contest_id = ?')
    .get(contestId) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

export function getContestProblemIds(db: DatabaseSync, contestId: number): number[] {
  return (
    db
      .prepare('SELECT problem_id FROM contest_problems WHERE contest_id = ? ORDER BY ordinal')
      .all(contestId) as unknown as Array<{ problem_id: number }>
  ).map((row) => row.problem_id);
}

export function getContestProblemEntries(
  db: DatabaseSync,
  contestId: number,
): Array<{ problem_id: number; ordinal: number; points: number }> {
  return db
    .prepare(
      'SELECT problem_id, ordinal, points FROM contest_problems WHERE contest_id = ? ORDER BY ordinal',
    )
    .all(contestId) as unknown as Array<{ problem_id: number; ordinal: number; points: number }>;
}

export function addParticipant(db: DatabaseSync, contestId: number, userId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO contest_participants(contest_id, user_id) VALUES (?, ?)",
  ).run(contestId, userId);
}

export function getParticipants(db: DatabaseSync, contestId: number): number[] {
  return (
    db
      .prepare('SELECT user_id FROM contest_participants WHERE contest_id = ? ORDER BY user_id')
      .all(contestId) as Array<{ user_id: number }>
  ).map((row) => row.user_id);
}

export function getVisibleParticipants(db: DatabaseSync, contestId: number): number[] {
  return (
    db
      .prepare(
        'SELECT user_id FROM contest_participants WHERE contest_id = ? AND hidden_at IS NULL ORDER BY user_id',
      )
      .all(contestId) as Array<{ user_id: number }>
  ).map((row) => row.user_id);
}

export function isContestParticipant(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM contest_participants WHERE contest_id = ? AND user_id = ?')
    .get(contestId, userId) as { ok: number } | undefined;
  return row !== undefined;
}

export function getContestParticipantStatus(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): 'accepted' | 'pending' | 'rejected' | null {
  const row = db
    .prepare('SELECT status FROM contest_participants WHERE contest_id = ? AND user_id = ?')
    .get(contestId, userId) as { status: string } | undefined;
  if (!row) return null;
  if (row.status === 'accepted' || row.status === 'pending' || row.status === 'rejected') {
    return row.status;
  }
  return null;
}

export function getParticipantRows(db: DatabaseSync, contestId: number) {
  return db
    .prepare(
      `SELECT p.user_id, p.status, p.extra_time, p.hidden_at,
              u.username, u.real_name, u.class_name
       FROM contest_participants p JOIN users u ON u.id = p.user_id
       WHERE p.contest_id = ? ORDER BY u.username`,
    )
    .all(contestId) as unknown as Array<{
    user_id: number;
    status: string;
    extra_time: number;
    hidden_at: number | null;
    username: string;
    real_name: string | null;
    class_name: string | null;
  }>;
}
