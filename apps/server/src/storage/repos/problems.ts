import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db.js';
import {
  ensureDefaultProblemCategory,
  getProblemCategoryByCode,
  getProblemCategoryById,
  parseDisplayId,
  ProblemNumberingError,
} from './problem-categories.js';

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
  category_id: number | null;
  seq: number | null;
  display_id: string | null;
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
  /** Category whose sequence is used for automatic numbering (defaults to `P`). */
  categoryId?: number;
  /** Explicit Luogu-style number such as `P1001`; overrides automatic allocation. */
  displayId?: string;
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
  return transaction(db, () => {
    const numbering = resolveNewProblemNumber(db, input);
    const result = db
      .prepare(
        `INSERT INTO problems(title, type, difficulty, tags_json, time_ms, memory_mb, output_mb,
           io_mode, input_file, output_file, statement_html, samples_json, checker_mode,
           checker_path, compare_mode, objective_json, visibility, owner_type, owner_id,
           category_id, seq, display_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        numbering.categoryId,
        numbering.seq,
        numbering.displayId,
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
  });
}

interface AssignedProblemNumber {
  categoryId: number;
  seq: number;
  displayId: string;
}

/**
 * Allocates the next number of a category, skipping any value already in use
 * (numbers are never reused, even after deletion).
 */
function allocateProblemNumber(db: DatabaseSync, categoryId: number): AssignedProblemNumber {
  const category = getProblemCategoryById(db, categoryId);
  if (!category) {
    throw new ProblemNumberingError('CATEGORY_NOT_FOUND', 400, 'problem category not found');
  }
  let seq = Math.max(category.next_seq, category.seq_start);
  while (problemNumberTaken(db, category.id, category.code, seq)) {
    seq += 1;
    if (seq > 999_999_999) {
      throw new ProblemNumberingError('NUMBER_EXHAUSTED', 409, 'category has no free numbers');
    }
  }
  db.prepare('UPDATE problem_categories SET next_seq = ? WHERE id = ?').run(seq + 1, category.id);
  return { categoryId: category.id, seq, displayId: `${category.code}${seq}` };
}

function problemNumberTaken(
  db: DatabaseSync,
  categoryId: number,
  code: string,
  seq: number,
  excludeProblemId?: number,
): boolean {
  const bySeq = db
    .prepare('SELECT id FROM problems WHERE category_id = ? AND seq = ?')
    .get(categoryId, seq) as { id: number } | undefined;
  if (bySeq && bySeq.id !== excludeProblemId) return true;
  const byDisplay = db
    .prepare('SELECT id FROM problems WHERE display_id = ?')
    .get(`${code}${seq}`) as { id: number } | undefined;
  return byDisplay !== undefined && byDisplay.id !== excludeProblemId;
}

function bumpCategoryNextSeq(db: DatabaseSync, categoryId: number, seq: number): void {
  db.prepare('UPDATE problem_categories SET next_seq = MAX(next_seq, ?) WHERE id = ?').run(
    seq + 1,
    categoryId,
  );
}

function resolveNewProblemNumber(
  db: DatabaseSync,
  input: CreateProblemInput,
): AssignedProblemNumber {
  if (
    input.displayId !== undefined &&
    input.displayId !== null &&
    input.displayId.trim().length > 0
  ) {
    const parsed = parseDisplayId(input.displayId);
    const category = getProblemCategoryByCode(db, parsed.code);
    if (!category) {
      throw new ProblemNumberingError(
        'CATEGORY_NOT_FOUND',
        400,
        `problem category ${parsed.code} does not exist`,
      );
    }
    if (
      input.categoryId !== undefined &&
      input.categoryId !== null &&
      input.categoryId !== category.id
    ) {
      throw new ProblemNumberingError(
        'DISPLAY_ID_CATEGORY_MISMATCH',
        400,
        'display id prefix does not match the selected category',
      );
    }
    if (problemNumberTaken(db, category.id, category.code, parsed.seq)) {
      throw new ProblemNumberingError(
        'DISPLAY_ID_TAKEN',
        409,
        `problem number ${parsed.code}${parsed.seq} is already taken`,
      );
    }
    bumpCategoryNextSeq(db, category.id, parsed.seq);
    return { categoryId: category.id, seq: parsed.seq, displayId: `${category.code}${parsed.seq}` };
  }
  const categoryId = input.categoryId ?? ensureDefaultProblemCategory(db).id;
  return allocateProblemNumber(db, categoryId);
}


export function getProblem(db: DatabaseSync, id: number): ProblemRow | null {
  return (db.prepare('SELECT * FROM problems WHERE id = ?').get(id) as unknown as ProblemRow) ?? null;
}

/** Looks up a problem by its Luogu-style display id (case-insensitive). */
export function getProblemByDisplayId(db: DatabaseSync, displayId: string): ProblemRow | null {
  const value = displayId.trim().toUpperCase();
  if (!value) return null;
  return (
    (db.prepare('SELECT * FROM problems WHERE display_id = ?').get(value) as unknown as
      | ProblemRow
      | undefined) ?? null
  );
}

/** Resolves either the internal numeric id or a display id such as `P1001`. */
export function getProblemByIdOrDisplayId(
  db: DatabaseSync,
  value: string | number | null | undefined,
): ProblemRow | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? getProblem(db, value) : null;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const id = Number(trimmed);
    return Number.isInteger(id) && id > 0 ? getProblem(db, id) : null;
  }
  return getProblemByDisplayId(db, trimmed);
}

/** Batch problem folders accept both `P1001` and the internal numeric id. */
export function resolveProblemReference(
  db: DatabaseSync,
  value: string | number | null | undefined,
): ProblemRow | null {
  return getProblemByIdOrDisplayId(db, value);
}

/**
 * Assigns stable numbers to every unnumbered problem. Legacy rows (usually a
 * database created before numbering existed) all move into `P` in internal id
 * order, producing P1001, P1002, ... Idempotent: numbered rows are left alone.
 */
export function migrateProblemNumbers(db: DatabaseSync): { assigned: number } {
  return transaction(db, () => {
    const defaultCategory = ensureDefaultProblemCategory(db);
    const rows = db
      .prepare('SELECT id, category_id, seq, display_id FROM problems ORDER BY id')
      .all() as unknown as Array<{
      id: number;
      category_id: number | null;
      seq: number | null;
      display_id: string | null;
    }>;
    let assigned = 0;
    for (const row of rows) {
      if (row.display_id !== null && row.category_id !== null && row.seq !== null) continue;
      // A row that already carries a display id only needs its columns backfilled.
      if (row.display_id !== null) {
        const match = /^([A-Z]{1,8})([1-9][0-9]{0,8})$/.exec(row.display_id.trim().toUpperCase());
        if (match) {
          const seq = Number(match[2]);
          const category =
            getProblemCategoryByCode(db, match[1]) ??
            createCategoryForLegacyRow(db, match[1], seq);
          db.prepare('UPDATE problems SET category_id = ?, seq = ? WHERE id = ?').run(
            category.id,
            seq,
            row.id,
          );
          bumpCategoryNextSeq(db, category.id, seq);
          continue;
        }
      }
      let category = getProblemCategoryById(db, defaultCategory.id) ?? defaultCategory;
      let seq = Math.max(category.next_seq, category.seq_start);
      while (problemNumberTaken(db, category.id, category.code, seq)) {
        seq += 1;
      }
      const displayId = `${category.code}${seq}`;
      db.prepare(
        'UPDATE problems SET category_id = ?, seq = ?, display_id = ? WHERE id = ?',
      ).run(category.id, seq, displayId, row.id);
      db.prepare('UPDATE problem_categories SET next_seq = ? WHERE id = ?').run(
        seq + 1,
        category.id,
      );
      assigned += 1;
    }
    return { assigned };
  });
}

function createCategoryForLegacyRow(
  db: DatabaseSync,
  code: string,
  seq: number,
): { id: number; code: string } {
  const existing = getProblemCategoryByCode(db, code);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO problem_categories(code, name, next_seq, seq_start, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).run(code, code, seq + 1, seq, Date.now());
  return getProblemCategoryByCode(db, code)!;
}

export interface SetProblemDisplayIdResult {
  categoryId: number;
  seq: number;
  displayId: string;
}

/** Manually renumbers a problem; enforces format, category and uniqueness. */
export function setProblemDisplayId(
  db: DatabaseSync,
  problemId: number,
  rawDisplayId: unknown,
): SetProblemDisplayIdResult {
  return transaction(db, () => {
    const problem = getProblem(db, problemId);
    if (!problem) {
      throw new ProblemNumberingError('NOT_FOUND', 404, 'problem not found');
    }
    const parsed = parseDisplayId(rawDisplayId);
    const category = getProblemCategoryByCode(db, parsed.code);
    if (!category) {
      throw new ProblemNumberingError(
        'CATEGORY_NOT_FOUND',
        400,
        `problem category ${parsed.code} does not exist`,
      );
    }
    if (problemNumberTaken(db, category.id, category.code, parsed.seq, problemId)) {
      throw new ProblemNumberingError(
        'DISPLAY_ID_TAKEN',
        409,
        `problem number ${parsed.code}${parsed.seq} is already taken`,
      );
    }
    const displayId = `${category.code}${parsed.seq}`;
    db.prepare(
      'UPDATE problems SET category_id = ?, seq = ?, display_id = ? WHERE id = ?',
    ).run(category.id, parsed.seq, displayId, problemId);
    bumpCategoryNextSeq(db, category.id, parsed.seq);
    return { categoryId: category.id, seq: parsed.seq, displayId };
  });
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
