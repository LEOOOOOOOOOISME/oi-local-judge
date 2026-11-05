import type { DatabaseSync } from 'node:sqlite';

export type ProblemGranteeType = 'user' | 'team';
export type ProblemSharePermission = 'read' | 'edit';

export interface ProblemShareRow {
  problem_id: number;
  grantee_type: ProblemGranteeType;
  grantee_id: number;
  permission: ProblemSharePermission;
  created_by: number;
  created_at: number;
}

export function listProblemShareRows(db: DatabaseSync, problemId: number): ProblemShareRow[] {
  return db
    .prepare(
      'SELECT * FROM problem_shares WHERE problem_id = ? ORDER BY grantee_type, grantee_id',
    )
    .all(problemId) as unknown as ProblemShareRow[];
}

export function getProblemShareRow(
  db: DatabaseSync,
  problemId: number,
  granteeType: ProblemGranteeType,
  granteeId: number,
): ProblemShareRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM problem_shares
         WHERE problem_id = ? AND grantee_type = ? AND grantee_id = ?`,
      )
      .get(problemId, granteeType, granteeId) as unknown as ProblemShareRow) ?? null
  );
}

export function upsertProblemShare(
  db: DatabaseSync,
  input: {
    problemId: number;
    granteeType: ProblemGranteeType;
    granteeId: number;
    permission: ProblemSharePermission;
    createdBy: number;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO problem_shares(problem_id, grantee_type, grantee_id, permission,
       created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(problem_id, grantee_type, grantee_id) DO UPDATE SET
       permission = excluded.permission,
       created_by = excluded.created_by,
       created_at = excluded.created_at`,
  ).run(
    input.problemId,
    input.granteeType,
    input.granteeId,
    input.permission,
    input.createdBy,
    input.createdAt,
  );
}

export function deleteProblemShareRow(
  db: DatabaseSync,
  problemId: number,
  granteeType: ProblemGranteeType,
  granteeId: number,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM problem_shares
       WHERE problem_id = ? AND grantee_type = ? AND grantee_id = ?`,
    )
    .run(problemId, granteeType, granteeId);
  return Number(result.changes) > 0;
}

export function deleteProblemSharesForProblem(db: DatabaseSync, problemId: number): void {
  db.prepare('DELETE FROM problem_shares WHERE problem_id = ?').run(problemId);
}

/**
 * Highest permission granted to a user directly or through one of their teams.
 * Returns null when the user has no share on the problem.
 */
export function getEffectiveProblemShare(
  db: DatabaseSync,
  problemId: number,
  userId: number,
): ProblemSharePermission | null {
  const row = db
    .prepare(
      `SELECT permission FROM problem_shares
       WHERE problem_id = ?
         AND (
           (grantee_type = 'user' AND grantee_id = ?)
           OR (grantee_type = 'team'
               AND grantee_id IN (SELECT team_id FROM team_members WHERE user_id = ?))
         )
       ORDER BY CASE permission WHEN 'edit' THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .get(problemId, userId, userId) as { permission: ProblemSharePermission } | undefined;
  return row?.permission ?? null;
}
