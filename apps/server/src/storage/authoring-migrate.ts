import type { DatabaseSync } from 'node:sqlite';

const AUTHORING_SCHEMA = `
CREATE TABLE IF NOT EXISTS problem_data_plans(
  id INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL UNIQUE,
  schema TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS data_generation_jobs(
  id INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  heartbeat_at INTEGER,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_problem
  ON data_generation_jobs(problem_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_active
  ON data_generation_jobs(problem_id, status);
CREATE TABLE IF NOT EXISTS data_generation_cases(
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  case_index INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_path TEXT,
  output_path TEXT,
  input_sha256 TEXT,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  input_lines INTEGER NOT NULL DEFAULT 0,
  input_utf8 INTEGER NOT NULL DEFAULT 1,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  output_lines INTEGER NOT NULL DEFAULT 0,
  std_exit_code INTEGER,
  std_time_ms INTEGER NOT NULL DEFAULT 0,
  std_memory_kb INTEGER NOT NULL DEFAULT 0,
  validator_ok INTEGER,
  validator_message TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE(job_id, group_id, case_index),
  FOREIGN KEY(job_id) REFERENCES data_generation_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_generation_cases_job
  ON data_generation_cases(job_id, id);
`;

/** Idempotently creates the authoring tables; does not touch schema_migrations. */
export function migrateAuthoring(db: DatabaseSync): void {
  db.exec(AUTHORING_SCHEMA);
}
