import type { DatabaseSync } from 'node:sqlite';

export type ProblemOwnerType = 'system' | 'user' | 'team';

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
  /** stdout/stderr output limit in MiB; exceeding it yields OLE. */
  output_mb: number;
  io_mode: string;
  input_file: string | null;
  output_file: string | null;
  statement_html: string;
  samples_json: string;
  checker_mode: string;
  checker_path: string | null;
  compare_mode: string;
  objective_json: string;
  visibility: string;
  owner_type: ProblemOwnerType;
  owner_id: number | null;
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
  /** Output limit in MiB (default 64). */
  outputMb?: number;
  ioMode?: 'stdio' | 'file';
  inputFile?: string | null;
  outputFile?: string | null;
  statementHtml?: string;
  samples?: Array<{ input: string; output: string; explanation?: string }>;
  checkerMode?: 'builtin' | 'testlib' | 'lemon';
  checkerPath?: string | null;
  compareMode?: string;
  objective?: unknown;
  visibility?: string;
  /** Ownership of the problem; imported/seed problems stay `system`. */
  ownerType?: ProblemOwnerType;
  ownerId?: number | null;
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
      `INSERT INTO problems(title, type, difficulty, tags_json, time_ms, memory_mb, output_mb,
         io_mode, input_file, output_file, statement_html, samples_json, checker_mode,
         checker_path, compare_mode, objective_json, visibility, owner_type, owner_id,
         created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title,
      input.type,
      input.difficulty ?? null,
      JSON.stringify(input.tags ?? []),
      input.timeMs,
      input.memoryMb,
      input.outputMb ?? 64,
      input.ioMode ?? 'stdio',
      input.inputFile ?? null,
      input.outputFile ?? null,
      input.statementHtml ?? '',
      JSON.stringify(input.samples ?? []),
      input.checkerMode ?? 'builtin',
      input.checkerPath ?? null,
      input.compareMode ?? 'ignore-trailing',
      JSON.stringify(input.objective ?? {}),
      input.visibility ?? 'public',
      input.ownerType ?? 'system',
      input.ownerId ?? null,
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

export interface UpdateProblemPatch {
  title?: string;
  type?: string;
  difficulty?: number | null;
  tags?: string[];
  timeMs?: number;
  memoryMb?: number;
  ioMode?: 'stdio' | 'file';
  inputFile?: string | null;
  outputFile?: string | null;
  statementHtml?: string;
  visibility?: string;
  checkerMode?: 'builtin' | 'testlib' | 'lemon';
  compareMode?: string;
  objectiveJson?: string;
  /** Changing ownership; `system` clears `owner_id`. */
  ownerType?: ProblemOwnerType;
  ownerId?: number | null;
}

export function updateProblem(db: DatabaseSync, id: number, patch: UpdateProblemPatch): boolean {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    sets.push(`${column} = ?`);
    values.push(value);
  };
  add('title', patch.title);
  add('type', patch.type);
  add('difficulty', patch.difficulty === undefined ? undefined : patch.difficulty);
  add('tags_json', patch.tags === undefined ? undefined : JSON.stringify(patch.tags));
  add('time_ms', patch.timeMs);
  add('memory_mb', patch.memoryMb);
  add('io_mode', patch.ioMode);
  add('input_file', patch.inputFile === undefined ? undefined : patch.inputFile);
  add('output_file', patch.outputFile === undefined ? undefined : patch.outputFile);
  add('statement_html', patch.statementHtml);
  add('visibility', patch.visibility);
  add('checker_mode', patch.checkerMode);
  add('compare_mode', patch.compareMode);
  add('objective_json', patch.objectiveJson);
  if (patch.ownerType !== undefined) {
    add('owner_type', patch.ownerType);
    // A system-owned problem never carries an owner id.
    if (patch.ownerType === 'system' && patch.ownerId === undefined) {
      sets.push('owner_id = NULL');
    }
  }
  add('owner_id', patch.ownerId);
  if (sets.length === 0) return false;
  sets.push('version = version + 1');
  const result = db
    .prepare(`UPDATE problems SET ${sets.join(', ')} WHERE id = ?`)
    .run(...values, id);
  return Number(result.changes) > 0;
}

export function listProblems(db: DatabaseSync): ProblemRow[] {
  return db.prepare('SELECT * FROM problems WHERE visibility != ? ORDER BY id DESC').all('hidden') as unknown as ProblemRow[];
}

export function listAllProblems(db: DatabaseSync): ProblemRow[] {
  return db.prepare('SELECT * FROM problems ORDER BY id DESC').all() as unknown as ProblemRow[];
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

export function replaceSubtasks(
  db: DatabaseSync,
  problemId: number,
  items: Array<{ name: string; points: number; aggregation: string }>,
): number[] {
  db.prepare('DELETE FROM problem_subtasks WHERE problem_id = ?').run(problemId);
  const insert = db.prepare(
    'INSERT INTO problem_subtasks(problem_id, name, points, aggregation) VALUES (?, ?, ?, ?)',
  );
  return items.map((item) =>
    Number(insert.run(problemId, item.name, item.points, item.aggregation).lastInsertRowid),
  );
}

export function getSubtasks(db: DatabaseSync, problemId: number): SubtaskRow[] {
  return db
    .prepare('SELECT * FROM problem_subtasks WHERE problem_id = ? ORDER BY id')
    .all(problemId) as unknown as SubtaskRow[];
}
