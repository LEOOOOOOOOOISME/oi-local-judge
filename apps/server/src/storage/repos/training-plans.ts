import type { DatabaseSync } from 'node:sqlite';

export interface TrainingPlanRow {
  id: number;
  group_id: number;
  title: string;
  description: string;
  starts_at: number | null;
  ends_at: number | null;
  created_by: number;
  created_at: number;
  updated_at: number;
}

/** A plan row joined with the group it belongs to. */
export interface TrainingPlanViewRow extends TrainingPlanRow {
  group_name: string;
  group_kind: 'team' | 'class';
}

export interface TrainingPlanItemRow {
  id: number;
  plan_id: number;
  problem_id: number;
  ordinal: number;
  target_score: number;
  due_at: number | null;
  created_at: number;
}

/** An item row joined with the problem metadata shown in API responses. */
export interface TrainingPlanItemViewRow extends TrainingPlanItemRow {
  title: string;
  type: string;
  difficulty: number | null;
  tags_json: string;
  time_ms: number;
  memory_mb: number;
}

/** One group member with the identity fields needed by the progress view. */
export interface TrainingPlanMemberRow {
  user_id: number;
  role: string;
  username: string;
  real_name: string | null;
  class_name: string | null;
}

export interface TrainingPlanItemInput {
  problemId: number;
  targetScore: number;
  dueAt: number | null;
}

export function insertTrainingPlan(
  db: DatabaseSync,
  input: {
    groupId: number;
    title: string;
    description: string;
    startsAt: number | null;
    endsAt: number | null;
    createdBy: number;
    createdAt: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO training_plans(group_id, title, description, starts_at, ends_at,
         created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.groupId,
      input.title,
      input.description,
      input.startsAt,
      input.endsAt,
      input.createdBy,
      input.createdAt,
      input.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function getTrainingPlanRow(db: DatabaseSync, planId: number): TrainingPlanViewRow | null {
  return (
    (db
      .prepare(
        `SELECT p.*, t.name AS group_name, t.kind AS group_kind
         FROM training_plans p
         JOIN teams t ON t.id = p.group_id
         WHERE p.id = ?`,
      )
      .get(planId) as unknown as TrainingPlanViewRow) ?? null
  );
}

/**
 * Plans of every group (class or team) the user belongs to. A class and a team
 * share the same `teams` table, so membership alone decides visibility.
 */
export function listTrainingPlanRowsForUser(
  db: DatabaseSync,
  userId: number,
): TrainingPlanViewRow[] {
  return db
    .prepare(
      `SELECT p.*, t.name AS group_name, t.kind AS group_kind
       FROM training_plans p
       JOIN teams t ON t.id = p.group_id
       WHERE p.group_id IN (SELECT team_id FROM team_members WHERE user_id = ?)
       ORDER BY p.updated_at DESC, p.id DESC`,
    )
    .all(userId) as unknown as TrainingPlanViewRow[];
}

export function updateTrainingPlanRow(
  db: DatabaseSync,
  planId: number,
  patch: {
    title?: string;
    description?: string;
    startsAt?: number | null;
    endsAt?: number | null;
  },
  updatedAt: number,
): boolean {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    values.push(patch.title);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    values.push(patch.description);
  }
  if (patch.startsAt !== undefined) {
    sets.push('starts_at = ?');
    values.push(patch.startsAt);
  }
  if (patch.endsAt !== undefined) {
    sets.push('ends_at = ?');
    values.push(patch.endsAt);
  }
  if (sets.length === 0) return false;
  sets.push('updated_at = ?');
  values.push(updatedAt);
  const result = db
    .prepare(`UPDATE training_plans SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, planId);
  return Number(result.changes) > 0;
}

export function touchTrainingPlan(db: DatabaseSync, planId: number, updatedAt: number): void {
  db.prepare('UPDATE training_plans SET updated_at = ? WHERE id = ?').run(updatedAt, planId);
}

export function deleteTrainingPlanGraph(db: DatabaseSync, planId: number): void {
  db.prepare('DELETE FROM training_plan_items WHERE plan_id = ?').run(planId);
  db.prepare('DELETE FROM training_plans WHERE id = ?').run(planId);
}

export function countTrainingPlanItems(db: DatabaseSync, planId: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM training_plan_items WHERE plan_id = ?')
    .get(planId) as { n: number };
  return Number(row.n);
}

export function listTrainingPlanItemRows(
  db: DatabaseSync,
  planId: number,
): TrainingPlanItemViewRow[] {
  return db
    .prepare(
      `SELECT i.*, p.title, p.type, p.difficulty, p.tags_json, p.time_ms, p.memory_mb
       FROM training_plan_items i
       JOIN problems p ON p.id = i.problem_id
       WHERE i.plan_id = ?
       ORDER BY i.ordinal, i.id`,
    )
    .all(planId) as unknown as TrainingPlanItemViewRow[];
}

export function getTrainingPlanItemRow(
  db: DatabaseSync,
  planId: number,
  itemId: number,
): TrainingPlanItemRow | null {
  return (
    (db
      .prepare('SELECT * FROM training_plan_items WHERE id = ? AND plan_id = ?')
      .get(itemId, planId) as unknown as TrainingPlanItemRow) ?? null
  );
}

export function getTrainingPlanItemByProblem(
  db: DatabaseSync,
  planId: number,
  problemId: number,
): TrainingPlanItemRow | null {
  return (
    (db
      .prepare('SELECT * FROM training_plan_items WHERE plan_id = ? AND problem_id = ?')
      .get(planId, problemId) as unknown as TrainingPlanItemRow) ?? null
  );
}

export function nextTrainingPlanOrdinal(db: DatabaseSync, planId: number): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(ordinal), 0) AS n FROM training_plan_items WHERE plan_id = ?')
    .get(planId) as { n: number };
  return Number(row.n) + 1;
}

export function insertTrainingPlanItem(
  db: DatabaseSync,
  input: {
    planId: number;
    problemId: number;
    ordinal: number;
    targetScore: number;
    dueAt: number | null;
    createdAt: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO training_plan_items(plan_id, problem_id, ordinal, target_score, due_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.planId,
      input.problemId,
      input.ordinal,
      input.targetScore,
      input.dueAt,
      input.createdAt,
    );
  return Number(result.lastInsertRowid);
}

export function deleteTrainingPlanItemRow(
  db: DatabaseSync,
  planId: number,
  itemId: number,
): boolean {
  const result = db
    .prepare('DELETE FROM training_plan_items WHERE id = ? AND plan_id = ?')
    .run(itemId, planId);
  return Number(result.changes) > 0;
}

export function listTrainingPlanItemIds(db: DatabaseSync, planId: number): number[] {
  const rows = db
    .prepare('SELECT id FROM training_plan_items WHERE plan_id = ? ORDER BY ordinal, id')
    .all(planId) as unknown as Array<{ id: number }>;
  return rows.map((row) => row.id);
}

export function updateTrainingPlanItemOrdinal(
  db: DatabaseSync,
  planId: number,
  itemId: number,
  ordinal: number,
): void {
  db.prepare('UPDATE training_plan_items SET ordinal = ? WHERE id = ? AND plan_id = ?').run(
    ordinal,
    itemId,
    planId,
  );
}

/** Re-numbers every item to 1..n in insertion order (used after a deletion). */
export function compactTrainingPlanOrdinals(db: DatabaseSync, planId: number): void {
  listTrainingPlanItemIds(db, planId).forEach((itemId, index) => {
    updateTrainingPlanItemOrdinal(db, planId, itemId, index + 1);
  });
}

export function listTrainingPlanMembers(
  db: DatabaseSync,
  planId: number,
): TrainingPlanMemberRow[] {
  return db
    .prepare(
      `SELECT m.user_id, m.role, u.username, u.real_name, u.class_name
       FROM training_plans p
       JOIN team_members m ON m.team_id = p.group_id
       JOIN users u ON u.id = m.user_id
       WHERE p.id = ?
       ORDER BY CASE m.role
                  WHEN 'captain' THEN 0
                  WHEN 'coach' THEN 1
                  WHEN 'assistant' THEN 2
                  ELSE 3
                END, u.username`,
    )
    .all(planId) as unknown as TrainingPlanMemberRow[];
}

/** Full score of a problem, i.e. the sum of its enabled testcase points. */
export function getProblemFullScore(db: DatabaseSync, problemId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(points), 0) AS n
       FROM problem_testcases WHERE problem_id = ? AND enabled = 1`,
    )
    .get(problemId) as { n: number };
  return Number(row.n);
}

export interface TrainingPlanSubmissionRow {
  user_id: number;
  problem_id: number;
  verdict: string | null;
  score: number;
  created_at: number;
}

/**
 * Finished, unhacked practice/contest submissions for a set of members and
 * problems. Ordered chronologically so progress can find the first attempt that
 * reached a threshold.
 */
export function listTrainingPlanProgressSubmissions(
  db: DatabaseSync,
  input: { userIds: number[]; problemIds: number[] },
): TrainingPlanSubmissionRow[] {
  if (input.userIds.length === 0 || input.problemIds.length === 0) return [];
  const userPlaceholders = input.userIds.map(() => '?').join(', ');
  const problemPlaceholders = input.problemIds.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT user_id, problem_id, verdict, score, created_at
       FROM submissions
       WHERE user_id IN (${userPlaceholders})
         AND problem_id IN (${problemPlaceholders})
         AND status = 'finished'
         AND hacked_at IS NULL
         AND phase IN ('practice', 'contest')
       ORDER BY created_at, id`,
    )
    .all(...input.userIds, ...input.problemIds) as unknown as TrainingPlanSubmissionRow[];
}
