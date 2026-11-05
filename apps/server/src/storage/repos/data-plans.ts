import type { DatabaseSync } from 'node:sqlite';

export interface DataPlanRow {
  id: number;
  problem_id: number;
  schema: string;
  plan_json: string;
  version: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertDataPlanInput {
  problemId: number;
  planJson: string;
  createdBy?: number | null;
  now?: number;
}

export function getDataPlanRow(
  db: DatabaseSync,
  problemId: number,
): DataPlanRow | null {
  return (
    (db
      .prepare('SELECT * FROM problem_data_plans WHERE problem_id = ?')
      .get(problemId) as unknown as DataPlanRow | undefined) ?? null
  );
}

export function upsertDataPlan(
  db: DatabaseSync,
  input: UpsertDataPlanInput,
): DataPlanRow {
  const now = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO problem_data_plans(
       problem_id, schema, plan_json, version, created_by, created_at, updated_at
     ) VALUES (?, 'oijudge.data-plan/1', ?, 1, ?, ?, ?)
     ON CONFLICT(problem_id) DO UPDATE SET
       plan_json = excluded.plan_json,
       version = problem_data_plans.version + 1,
       updated_at = excluded.updated_at`,
  ).run(input.problemId, input.planJson, input.createdBy ?? null, now, now);
  return getDataPlanRow(db, input.problemId)!;
}
