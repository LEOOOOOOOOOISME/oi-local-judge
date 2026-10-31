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
