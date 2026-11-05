import type { DatabaseSync } from 'node:sqlite';

export type ProblemSetOwnerType = 'user' | 'team';
export type ProblemSetVisibility = 'private' | 'public';
export type ProblemSetGranteeType = 'user' | 'team';
export type ProblemSetSharePermission = 'read' | 'edit';

export interface ProblemSetRow {
  id: number;
  title: string;
  description: string;
  owner_type: ProblemSetOwnerType;
  owner_id: number;
  visibility: ProblemSetVisibility;
  created_by: number;
  created_at: number;
  updated_at: number;
}

export interface ProblemSetItemRow {
  set_id: number;
  problem_id: number;
  ordinal: number;
  added_at: number;
}

export interface ProblemSetItemViewRow extends ProblemSetItemRow {
  title: string;
  type: string;
  difficulty: number | null;
  tags_json: string;
  time_ms: number;
  memory_mb: number;
  visibility: string;
}

export interface ProblemSetShareRow {
  set_id: number;
  grantee_type: ProblemSetGranteeType;
  grantee_id: number;
  permission: ProblemSetSharePermission;
  created_by: number;
  created_at: number;
}

export function insertProblemSet(
  db: DatabaseSync,
  input: {
    title: string;
    description: string;
    ownerType: ProblemSetOwnerType;
    ownerId: number;
    visibility: ProblemSetVisibility;
    createdBy: number;
    createdAt: number;
    updatedAt: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO problem_sets(title, description, owner_type, owner_id, visibility,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.description,
      input.ownerType,
      input.ownerId,
      input.visibility,
      input.createdBy,
      input.createdAt,
      input.updatedAt,
    );
  return Number(result.lastInsertRowid);
}

export function getProblemSetRow(db: DatabaseSync, setId: number): ProblemSetRow | null {
  return (
    (db.prepare('SELECT * FROM problem_sets WHERE id = ?').get(setId) as unknown as ProblemSetRow) ??
    null
  );
}

/**
 * Sets visible to a user through ownership, team membership, public visibility
 * or a direct/team share. `DISTINCT` collapses duplicate grants.
 */
export function listProblemSetRowsForUser(
  db: DatabaseSync,
  input: { userId: number; includePublic: boolean },
): ProblemSetRow[] {
  return db
    .prepare(
      `SELECT DISTINCT s.*
       FROM problem_sets s
       WHERE (s.owner_type = 'user' AND s.owner_id = ?)
          OR (s.owner_type = 'team'
              AND s.owner_id IN (SELECT team_id FROM team_members WHERE user_id = ?))
          OR (? = 1 AND s.visibility = 'public')
          OR EXISTS (
            SELECT 1 FROM problem_set_shares sh
            WHERE sh.set_id = s.id
              AND (
                (sh.grantee_type = 'user' AND sh.grantee_id = ?)
                OR (sh.grantee_type = 'team'
                    AND sh.grantee_id IN (SELECT team_id FROM team_members WHERE user_id = ?))
              )
          )
       ORDER BY s.updated_at DESC, s.id DESC`,
    )
    .all(input.userId, input.userId, input.includePublic ? 1 : 0, input.userId, input.userId) as unknown as ProblemSetRow[];
}

export function updateProblemSetRow(
  db: DatabaseSync,
  setId: number,
  patch: {
    title?: string;
    description?: string;
    visibility?: ProblemSetVisibility;
  },
  updatedAt: number,
): boolean {
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    values.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    values.push(patch.description);
  }
  if (patch.visibility !== undefined) {
    sets.push('visibility = ?');
    values.push(patch.visibility);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  values.push(updatedAt);
  const result = db
    .prepare(`UPDATE problem_sets SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, setId);
  return Number(result.changes) > 0;
}

export function touchProblemSet(db: DatabaseSync, setId: number, updatedAt: number): void {
  db.prepare('UPDATE problem_sets SET updated_at = ? WHERE id = ?').run(updatedAt, setId);
}

export function deleteProblemSetGraph(db: DatabaseSync, setId: number): void {
  db.prepare('DELETE FROM problem_set_shares WHERE set_id = ?').run(setId);
  db.prepare('DELETE FROM problem_set_items WHERE set_id = ?').run(setId);
  db.prepare('DELETE FROM problem_sets WHERE id = ?').run(setId);
}

export function countProblemSetItems(db: DatabaseSync, setId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM problem_set_items WHERE set_id = ?')
    .get(setId) as { n: number };
  return Number(row.n);
}

export function listProblemSetItemRows(db: DatabaseSync, setId: number): ProblemSetItemViewRow[] {
  return db
    .prepare(
      `SELECT i.set_id, i.problem_id, i.ordinal, i.added_at,
              p.title, p.type, p.difficulty, p.tags_json, p.time_ms, p.memory_mb, p.visibility
       FROM problem_set_items i
       JOIN problems p ON p.id = i.problem_id
       WHERE i.set_id = ?
       ORDER BY i.ordinal, i.problem_id`,
    )
    .all(setId) as unknown as ProblemSetItemViewRow[];
}

export function getProblemSetItemRow(
  db: DatabaseSync,
  setId: number,
  problemId: number,
): ProblemSetItemRow | null {
  return (
    (db
      .prepare('SELECT * FROM problem_set_items WHERE set_id = ? AND problem_id = ?')
      .get(setId, problemId) as unknown as ProblemSetItemRow) ?? null
  );
}

export function nextProblemSetOrdinal(db: DatabaseSync, setId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(ordinal), 0) AS n FROM problem_set_items WHERE set_id = ?')
    .get(setId) as { n: number };
  return Number(row.n) + 1;
}

export function insertProblemSetItem(
  db: DatabaseSync,
  input: { setId: number; problemId: number; ordinal: number; addedAt: number },
): void {
  db.prepare(
    'INSERT INTO problem_set_items(set_id, problem_id, ordinal, added_at) VALUES (?, ?, ?, ?)',
  ).run(input.setId, input.problemId, input.ordinal, input.addedAt);
}

export function deleteProblemSetItemRow(
  db: DatabaseSync,
  setId: number,
  problemId: number,
): boolean {
  const result = db
    .prepare('DELETE FROM problem_set_items WHERE set_id = ? AND problem_id = ?')
    .run(setId, problemId);
  return Number(result.changes) > 0;
}

export function listProblemSetProblemIds(db: DatabaseSync, setId: number): number[] {
  const rows = db
    .prepare('SELECT problem_id FROM problem_set_items WHERE set_id = ? ORDER BY ordinal')
    .all(setId) as unknown as Array<{ problem_id: number }>;
  return rows.map((row) => row.problem_id);
}

export function updateProblemSetItemOrdinal(
  db: DatabaseSync,
  setId: number,
  problemId: number,
  ordinal: number,
): void {
  db.prepare(
    'UPDATE problem_set_items SET ordinal = ? WHERE set_id = ? AND problem_id = ?',
  ).run(ordinal, setId, problemId);
}

export function listProblemSetShareRows(db: DatabaseSync, setId: number): ProblemSetShareRow[] {
  return db
    .prepare('SELECT * FROM problem_set_shares WHERE set_id = ? ORDER BY grantee_type, grantee_id')
    .all(setId) as unknown as ProblemSetShareRow[];
}

export function getProblemSetShareRow(
  db: DatabaseSync,
  setId: number,
  granteeType: ProblemSetGranteeType,
  granteeId: number,
): ProblemSetShareRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM problem_set_shares
         WHERE set_id = ? AND grantee_type = ? AND grantee_id = ?`,
      )
      .get(setId, granteeType, granteeId) as unknown as ProblemSetShareRow) ?? null
  );
}

export function upsertProblemSetShare(
  db: DatabaseSync,
  input: {
    setId: number;
    granteeType: ProblemSetGranteeType;
    granteeId: number;
    permission: ProblemSetSharePermission;
    createdBy: number;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO problem_set_shares(set_id, grantee_type, grantee_id, permission, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(set_id, grantee_type, grantee_id) DO UPDATE SET
       permission = excluded.permission,
       created_by = excluded.created_by,
       created_at = excluded.created_at`,
  ).run(
    input.setId,
    input.granteeType,
    input.granteeId,
    input.permission,
    input.createdBy,
    input.createdAt,
  );
}

export function deleteProblemSetShareRow(
  db: DatabaseSync,
  setId: number,
  granteeType: ProblemSetGranteeType,
  granteeId: number,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM problem_set_shares
       WHERE set_id = ? AND grantee_type = ? AND grantee_id = ?`,
    )
    .run(setId, granteeType, granteeId);
  return Number(result.changes) > 0;
}

/**
 * Highest permission granted to a user, either directly or through one of the
 * user's teams. Returns null when there is no share.
 */
export function getEffectiveProblemSetShare(
  db: DatabaseSync,
  setId: number,
  userId: number,
): ProblemSetSharePermission | null {
  const row = db
    .prepare(
      `SELECT permission FROM problem_set_shares
       WHERE set_id = ?
         AND (
           (grantee_type = 'user' AND grantee_id = ?)
           OR (grantee_type = 'team'
               AND grantee_id IN (SELECT team_id FROM team_members WHERE user_id = ?))
         )
       ORDER BY CASE permission WHEN 'edit' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(setId, userId, userId) as { permission: ProblemSetSharePermission } | undefined;
  return row?.permission ?? null;
}
