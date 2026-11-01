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
  memory_mb INTEGER NOT NULL, io_mode TEXT NOT NULL DEFAULT 'stdio',
  input_file TEXT, output_file TEXT, statement_html TEXT NOT NULL DEFAULT '',
  samples_json TEXT NOT NULL DEFAULT '[]',
  checker_mode TEXT NOT NULL DEFAULT 'builtin',
  checker_path TEXT,
  compare_mode TEXT NOT NULL DEFAULT 'ignore-trailing',
  objective_json TEXT NOT NULL DEFAULT '{}',
  visibility TEXT NOT NULL DEFAULT 'public', version INTEGER NOT NULL DEFAULT 1,
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
CREATE TABLE IF NOT EXISTS problem_assets(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT NOT NULL, path TEXT NOT NULL, language TEXT,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(problem_id, kind),
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS submissions(
  id INTEGER PRIMARY KEY, contest_id INTEGER, problem_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, language TEXT NOT NULL, source_path TEXT NOT NULL,
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
  PRIMARY KEY(contest_id, user_id)
);
CREATE TABLE IF NOT EXISTS batch_jobs(
  id INTEGER PRIMARY KEY, problem_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'running',
  student_level INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS batch_items(
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL, student TEXT NOT NULL,
  source_path TEXT NOT NULL, submission_id INTEGER, problem_id INTEGER,
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
`;

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  db.exec(SCHEMA);
  ensureColumn(db, 'problems', 'samples_json', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'problems', 'checker_mode', "TEXT NOT NULL DEFAULT 'builtin'");
  ensureColumn(db, 'problems', 'checker_path', 'TEXT');
  ensureColumn(db, 'problems', 'compare_mode', "TEXT NOT NULL DEFAULT 'ignore-trailing'");
  ensureColumn(db, 'problems', 'objective_json', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(db, 'batch_items', 'problem_id', 'INTEGER');
  ensureColumn(db, 'submissions', 'message', "TEXT NOT NULL DEFAULT ''");
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
