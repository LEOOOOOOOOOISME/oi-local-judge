import type { DatabaseSync } from 'node:sqlite';

export interface TestcaseRow {
  id: number;
  problem_id: number;
  ordinal: number;
  input_path: string;
  output_path: string;
  points: number;
  subtask_id: number | null;
  depends_on: string | null;
  enabled: number;
}

export interface SubtaskRow {
  id: number;
  problem_id: number;
  name: string;
  points: number;
  aggregation: string;
}

export interface ProblemRow {
  id: number;
  title: string;
  type: string;
  difficulty: number | null;
  tags_json: string;
  time_ms: number;
  memory_mb: number;
  io_mode: string;
  input_file: string | null;
  output_file: string | null;
  statement_html: string;
  samples_json: string;
  checker_mode: string;
  checker_path: string | null;
  compare_mode: string;
  visibility: string;
  version: number;
  created_at: number;
}

export interface CreateProblemInput {
  title: string;
  type: string;
  difficulty?: number | null;
  tags?: string[];
  timeMs: number;
  memoryMb: number;
  ioMode?: 'stdio' | 'file';
  inputFile?: string | null;
  outputFile?: string | null;
  statementHtml?: string;
  samples?: Array<{ input: string; output: string; explanation?: string }>;
  checkerMode?: 'builtin' | 'testlib' | 'lemon';
  checkerPath?: string | null;
  compareMode?: string;
  visibility?: string;
  testcases: Array<{
    inputPath: string;
    outputPath: string;
    points: number;
    subtaskId?: number | null;
    dependsOn?: string | null;
    enabled?: boolean;
  }>;
  subtasks?: Array<{ name: string; points: number; aggregation?: string }>;
}

export function createProblem(db: DatabaseSync, input: CreateProblemInput): number {
  const result = db
    .prepare(
      `INSERT INTO problems(title, type, difficulty, tags_json, time_ms, memory_mb,
         io_mode, input_file, output_file, statement_html, samples_json, checker_mode,
         checker_path, compare_mode, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.type,
      input.difficulty ?? null,
      JSON.stringify(input.tags ?? []),
      input.timeMs,
      input.memoryMb,
      input.ioMode ?? 'stdio',
      input.inputFile ?? null,
      input.outputFile ?? null,
      input.statementHtml ?? '',
      JSON.stringify(input.samples ?? []),
      input.checkerMode ?? 'builtin',
      input.checkerPath ?? null,
      input.compareMode ?? 'ignore-trailing',
      input.visibility ?? 'public',
      Date.now(),
    );
  const problemId = Number(result.lastInsertRowid);

  const insertSubtask = db.prepare(
    'INSERT INTO problem_subtasks(problem_id, name, points, aggregation) VALUES (?, ?, ?, ?)',
  );
  input.subtasks?.forEach((subtask) => {
    insertSubtask.run(problemId, subtask.name, subtask.points, subtask.aggregation ?? 'min');
  });

  const insertTestcase = db.prepare(
    `INSERT INTO problem_testcases(problem_id, ordinal, input_path, output_path, points,
       subtask_id, depends_on, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  input.testcases.forEach((testcase, index) => {
    insertTestcase.run(
      problemId,
      index + 1,
      testcase.inputPath,
      testcase.outputPath,
      testcase.points,
      testcase.subtaskId ?? null,
      testcase.dependsOn ?? null,
      testcase.enabled === false ? 0 : 1,
    );
  });
  return problemId;
}

export function getProblem(db: DatabaseSync, id: number): ProblemRow | null {
  return (db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as unknown as ProblemRow) ?? null;
}

export function listProblems(db: DatabaseSync): ProblemRow[] {
  return db.prepare('SELECT * FROM problems WHERE visibility != ? ORDER BY id DESC').all('hidden') as unknown as ProblemRow[];
}

export function getTestcases(db: DatabaseSync, problemId: number): TestcaseRow[] {
  return db
    .prepare('SELECT * FROM problem_testcases WHERE problem_id = ? AND enabled = 1 ORDER BY ordinal')
    .all(problemId) as unknown as TestcaseRow[];
}

export function listAllTestcases(db: DatabaseSync, problemId: number): TestcaseRow[] {
  return db
    .prepare('SELECT * FROM problem_testcases WHERE problem_id = ? ORDER BY ordinal')
    .all(problemId) as unknown as TestcaseRow[];
}

export function replaceTestcases(
  db: DatabaseSync,
  problemId: number,
  items: Array<{
    inputPath: string;
    outputPath: string;
    points: number;
    subtaskId?: number | null;
    dependsOn?: string | null;
  }>,
): void {
  db.prepare('DELETE FROM problem_testcases WHERE problem_id = ?').run(problemId);
  const insert = db.prepare(
    `INSERT INTO problem_testcases(problem_id, ordinal, input_path, output_path, points,
       subtask_id, depends_on, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
  );
  items.forEach((item, index) => {
    insert.run(
      problemId,
      index + 1,
      item.inputPath,
      item.outputPath,
      item.points,
      item.subtaskId ?? null,
      item.dependsOn ?? null,
    );
  });
}

export function updateTestcasePoints(
  db: DatabaseSync,
  problemId: number,
  items: Array<{ id: number; points: number }>,
): void {
  const update = db.prepare(
    'UPDATE problem_testcases SET points = ? WHERE id = ? AND problem_id = ?',
  );
  for (const item of items) update.run(item.points, item.id, problemId);
}

export function getSubtasks(db: DatabaseSync, problemId: number): SubtaskRow[] {
  return db
    .prepare('SELECT * FROM problem_subtasks WHERE problem_id = ? ORDER BY id')
    .all(problemId) as unknown as SubtaskRow[];
}
