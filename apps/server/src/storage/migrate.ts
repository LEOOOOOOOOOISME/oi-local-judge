import type { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  real_name TEXT, class_name TEXT, role TEXT NOT NULL DEFAULT 'contestant',
  status TEXT NOT NULL DEFAULT 'active', session_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS problems(
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
  difficulty INTEGER, tags_json TEXT NOT NULL DEFAULT '[]', time_ms INTEGER NOT NULL,
  memory_mb INTEGER NOT NULL, output_mb INTEGER NOT NULL DEFAULT 64,
  io_mode TEXT NOT NULL DEFAULT 'stdio',
  input_file TEXT, output_file TEXT, statement_html TEXT NOT NULL DEFAULT '',
  samples_json TEXT NOT NULL DEFAULT '[]',
  checker_mode TEXT NOT NULL DEFAULT 'builtin',
  checker_path TEXT,
  compare_mode TEXT NOT NULL DEFAULT 'ignore-trailing',
  objective_json TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'public',
  owner_type TEXT NOT NULL DEFAULT 'system',
  owner_id INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS problem_testcases(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  input_path TEXT NOT NULL, output_path TEXT NOT NULL, points INTEGER NOT NULL,
  subtask_id INTEGER, depends_on TEXT, enabled INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_testcases_problem ON problem_testcases(problem_id, ordinal);
CREATE TABLE IF NOT EXISTS problem_subtasks(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, name TEXT NOT NULL,
  points INTEGER NOT NULL, aggregation TEXT NOT NULL DEFAULT 'min',
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS problem_shares(
  problem_id INTEGER NOT NULL,
  grantee_type TEXT NOT NULL,
  grantee_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(problem_id, grantee_type, grantee_id),
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_problem_shares_grantee
  ON problem_shares(grantee_type, grantee_id);
CREATE TABLE IF NOT EXISTS problem_assets(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, path TEXT NOT NULL, language TEXT,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(problem_id, kind),
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS submissions(
  id INTEGER PRIMARY KEY, contest_id INTEGER, problem_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, team_id INTEGER, language TEXT NOT NULL, source_path TEXT NOT NULL,
  source_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT, score INTEGER NOT NULL DEFAULT 0, time_ms INTEGER NOT NULL DEFAULT 0,
  memory_kb INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, judged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_contest ON submissions(contest_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id, id);
CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions(user_id, id DESC);
CREATE TABLE IF NOT EXISTS test_results(
  submission_id INTEGER NOT NULL, testcase_id INTEGER NOT NULL, verdict TEXT NOT NULL,
  time_ms INTEGER NOT NULL, memory_kb INTEGER NOT NULL, score INTEGER NOT NULL,
  message TEXT NOT NULL DEFAULT '', PRIMARY KEY(submission_id, testcase_id)
);
CREATE TABLE IF NOT EXISTS judge_tasks(
  id INTEGER PRIMARY KEY, submission_id INTEGER NOT NULL UNIQUE,
  priority INTEGER NOT NULL DEFAULT 50, status TEXT NOT NULL DEFAULT 'queued',
  worker TEXT, attempts INTEGER NOT NULL DEFAULT 0, heartbeat_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_judge_tasks_claim ON judge_tasks(status, priority DESC, id);
CREATE TABLE IF NOT EXISTS contests(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'oi',
  team_mode TEXT NOT NULL DEFAULT 'individual',
  registration_mode TEXT NOT NULL DEFAULT 'manual',
  registration_open_at INTEGER, registration_close_at INTEGER,
  start_at INTEGER, end_at INTEGER, freeze_at INTEGER, unfreeze_at INTEGER,
  status TEXT NOT NULL DEFAULT 'draft', rules_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS contest_problems(
  contest_id INTEGER NOT NULL, problem_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  points INTEGER NOT NULL, PRIMARY KEY(contest_id, problem_id)
);
CREATE TABLE IF NOT EXISTS contest_participants(
  contest_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'accepted', extra_time INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER, checked_in_at INTEGER, reviewed_at INTEGER, reviewed_by INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY(contest_id, user_id)
);
CREATE TABLE IF NOT EXISTS contest_official_scores(
  id INTEGER PRIMARY KEY,
  contest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT 'WA',
  source TEXT NOT NULL DEFAULT 'online',
  batch_id INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(contest_id, user_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_official_contest_user
  ON contest_official_scores(contest_id, user_id);
CREATE INDEX IF NOT EXISTS idx_official_contest_problem
  ON contest_official_scores(contest_id, problem_id);
CREATE TABLE IF NOT EXISTS ranking_plugins(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  js_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contest_problem_locks(
  contest_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  locked_at INTEGER NOT NULL,
  PRIMARY KEY(contest_id, user_id, problem_id)
);
CREATE TABLE IF NOT EXISTS contest_hacks(
  id INTEGER PRIMARY KEY,
  contest_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  hacker_id INTEGER NOT NULL,
  target_submission_id INTEGER NOT NULL,
  team_id INTEGER,
  input_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  verdict TEXT,
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  judged_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hacks_contest ON contest_hacks(contest_id, problem_id, id DESC);
CREATE TABLE IF NOT EXISTS batch_jobs(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running',
  student_level INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_items(
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, student TEXT NOT NULL,
  source_path TEXT NOT NULL, submission_id INTEGER, problem_id INTEGER,
  user_id INTEGER,
  FOREIGN KEY(batch_id) REFERENCES batch_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON batch_items(batch_id);
CREATE TABLE IF NOT EXISTS posts(
  id INTEGER PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL,
  body_md TEXT NOT NULL, problem_id INTEGER, contest_id INTEGER,
  author_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'published',
  pinned INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_list ON posts(status, category, id DESC);
CREATE TABLE IF NOT EXISTS comments(
  id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, author_id INTEGER NOT NULL,
  body_md TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, id);
CREATE TABLE IF NOT EXISTS clarifications(
  id INTEGER PRIMARY KEY, contest_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  question TEXT NOT NULL, answer TEXT, is_public INTEGER NOT NULL DEFAULT 1,
  answered_by INTEGER, created_at INTEGER NOT NULL, answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_clarifications_contest ON clarifications(contest_id, id);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, sender_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
  body TEXT NOT NULL, read_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender_id, recipient_id, id);
CREATE TABLE IF NOT EXISTS notifications(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}', read_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, id DESC);
CREATE TABLE IF NOT EXISTS audit_logs(
  id INTEGER PRIMARY KEY, actor_id INTEGER, action TEXT NOT NULL,
  target_type TEXT, target_id TEXT, detail_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(id DESC);
CREATE TABLE IF NOT EXISTS teams(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'team',
  allow_contest INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members(
  team_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(team_id, user_id),
  FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
CREATE TABLE IF NOT EXISTS contest_teams(
  contest_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  registered_by INTEGER,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY(contest_id, team_id)
);
CREATE INDEX IF NOT EXISTS idx_contest_teams_team ON contest_teams(team_id);
CREATE TABLE IF NOT EXISTS problem_sets(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_problem_sets_owner ON problem_sets(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_problem_sets_visibility ON problem_sets(visibility, updated_at DESC);
CREATE TABLE IF NOT EXISTS problem_set_items(
  set_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(set_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_problem_set_items_order ON problem_set_items(set_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_problem_set_items_problem ON problem_set_items(problem_id);
CREATE TABLE IF NOT EXISTS problem_set_shares(
  set_id INTEGER NOT NULL,
  grantee_type TEXT NOT NULL,
  grantee_id INTEGER NOT NULL,
  permission TEXT NOT NULL,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(set_id, grantee_type, grantee_id)
);
CREATE INDEX IF NOT EXISTS idx_problem_set_shares_grantee
  ON problem_set_shares(grantee_type, grantee_id);
CREATE TABLE IF NOT EXISTS training_plans(
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER,
  ends_at INTEGER,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_training_plans_group
  ON training_plans(group_id, id);
CREATE TABLE IF NOT EXISTS training_plan_items(
  id INTEGER PRIMARY KEY,
  plan_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  target_score INTEGER NOT NULL,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(plan_id, problem_id),
  FOREIGN KEY(plan_id) REFERENCES training_plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_training_plan_items_plan
  ON training_plan_items(plan_id, ordinal);
CREATE TABLE IF NOT EXISTS student_problem_stats(
  user_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  best_score INTEGER NOT NULL DEFAULT 0,
  best_verdict TEXT,
  first_ac_at INTEGER,
  last_submit_at INTEGER NOT NULL,
  wrong_attempts INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_student_problem_stats_problem
  ON student_problem_stats(problem_id);
CREATE TABLE IF NOT EXISTS student_tag_stats(
  user_id INTEGER NOT NULL,
  tag TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  solved INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER,
  PRIMARY KEY(user_id, tag)
);
CREATE TABLE IF NOT EXISTS student_daily_stats(
  user_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  submissions INTEGER NOT NULL DEFAULT 0,
  ac_count INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0,
  active_seconds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, date)
);
`;

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  db.exec(SCHEMA);
  ensureColumn(db, 'problems', 'samples_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'problems', 'output_mb', 'INTEGER NOT NULL DEFAULT 64');
  ensureColumn(db, 'problems', 'checker_mode', "TEXT NOT NULL DEFAULT 'builtin'");
  ensureColumn(db, 'problems', 'checker_path', 'TEXT');
  ensureColumn(db, 'problems', 'compare_mode', "TEXT NOT NULL DEFAULT 'ignore-trailing'");
  ensureColumn(db, 'problems', 'objective_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'problems', 'owner_type', "TEXT NOT NULL DEFAULT 'system'");
  ensureColumn(db, 'problems', 'owner_id', 'INTEGER');
  ensureColumn(db, 'batch_items', 'problem_id', 'INTEGER');
  ensureColumn(db, 'batch_items', 'score', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'batch_items', 'verdict', 'TEXT');
  ensureColumn(db, 'batch_items', 'time_ms', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'batch_items', 'memory_kb', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'batch_items', 'user_id', 'INTEGER');
  ensureColumn(db, 'batch_jobs', 'contest_id', 'INTEGER');
  ensureColumn(db, 'batch_jobs', 'mode', 'TEXT');
  ensureColumn(db, 'batch_jobs', 'problem_level', 'INTEGER');
  ensureColumn(db, 'batch_jobs', 'problem_map_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'batch_jobs', 'meta_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'batch_jobs', 'created_by', 'INTEGER');
  ensureColumn(db, 'contest_participants', 'hidden_at', 'INTEGER');
  ensureColumn(db, 'contest_participants', 'registered_at', 'INTEGER');
  ensureColumn(db, 'contest_participants', 'checked_in_at', 'INTEGER');
  ensureColumn(db, 'contest_participants', 'reviewed_at', 'INTEGER');
  ensureColumn(db, 'contest_participants', 'reviewed_by', 'INTEGER');
  ensureColumn(db, 'contest_participants', 'source', "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, 'contests', 'registration_mode', "TEXT NOT NULL DEFAULT 'manual'");
  ensureColumn(db, 'contests', 'registration_open_at', 'INTEGER');
  ensureColumn(db, 'contests', 'registration_close_at', 'INTEGER');
  ensureColumn(db, 'submissions', 'phase', "TEXT NOT NULL DEFAULT 'contest'");
  ensureColumn(db, 'submissions', 'batch_id', 'INTEGER');
  ensureColumn(db, 'contests', 'ranking_rule_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'contests', 'award_config_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'contests', 'archived_at', 'INTEGER');
  ensureColumn(db, 'contests', 'official_frozen_until', 'INTEGER');
  ensureColumn(db, 'submissions', 'hacked_at', 'INTEGER');
  ensureColumn(db, 'submissions', 'hacked_by', 'INTEGER');
  ensureColumn(db, 'submissions', 'hack_id', 'INTEGER');
  ensureColumn(db, 'contest_official_scores', 'submission_id', 'INTEGER');
  ensureColumn(db, 'contest_official_scores', 'batch_score', 'INTEGER');
  ensureColumn(db, 'contest_official_scores', 'batch_verdict', 'TEXT');
  ensureColumn(db, 'submissions', 'message', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'contests', 'team_mode', "TEXT NOT NULL DEFAULT 'individual'");
  ensureColumn(db, 'submissions', 'team_id', 'INTEGER');
  ensureColumn(db, 'contest_hacks', 'team_id', 'INTEGER');
  ensureColumn(db, 'teams', 'kind', "TEXT NOT NULL DEFAULT 'team'");
  ensureColumn(db, 'teams', 'allow_contest', 'INTEGER NOT NULL DEFAULT 1');
  const applied = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
  if (applied.n === 0) {
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (1, ?)').run(Date.now());
  }
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
    name: string;
  }>;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
