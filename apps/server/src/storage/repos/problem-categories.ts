import type { DatabaseSync } from 'node:sqlite';

/** A problem-number prefix such as `P`, `B`, `UVA`. */
export interface ProblemCategoryRow {
  id: number;
  code: string;
  name: string;
  next_seq: number;
  seq_start: number;
  created_at: number;
}

/** Raised for invalid/conflicting problem numbers and category changes. */
export class ProblemNumberingError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ProblemNumberingError';
    this.code = code;
    this.status = status;
  }
}

export const CATEGORY_CODE_PATTERN = /^[A-Z]{1,8}$/;
/** Luogu-style display id: an uppercase prefix plus a positive sequence. */
export const DISPLAY_ID_PATTERN = /^([A-Z]{1,8})([1-9][0-9]{0,8})$/;
export const MAX_PROBLEM_SEQ = 999_999_999;

export interface ParsedDisplayId {
  code: string;
  seq: number;
}

export function normalizeCategoryCode(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ProblemNumberingError('INVALID_CATEGORY_CODE', 400, 'category code is required');
  }
  const code = raw.trim().toUpperCase();
  if (!CATEGORY_CODE_PATTERN.test(code)) {
    throw new ProblemNumberingError(
      'INVALID_CATEGORY_CODE',
      400,
      'category code must be 1-8 uppercase letters',
    );
  }
  return code;
}

/** Parses and normalizes `p1001` / `P1001`; rejects anything that is not prefix+sequence. */
export function parseDisplayId(raw: unknown): ParsedDisplayId {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  const match = DISPLAY_ID_PATTERN.exec(value);
  if (!match) {
    throw new ProblemNumberingError(
      'INVALID_DISPLAY_ID',
      400,
      'display id must look like P1001 (uppercase category prefix + number)',
    );
  }
  const seq = Number(match[2]);
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > MAX_PROBLEM_SEQ) {
    throw new ProblemNumberingError('INVALID_DISPLAY_ID', 400, 'display id sequence is out of range');
  }
  return { code: match[1], seq };
}

export function listProblemCategories(db: DatabaseSync): ProblemCategoryRow[] {
  return db
    .prepare('SELECT * FROM problem_categories ORDER BY id')
    .all() as unknown as ProblemCategoryRow[];
}

export function getProblemCategoryById(
  db: DatabaseSync,
  id: number,
): ProblemCategoryRow | null {
  return (
    (db.prepare('SELECT * FROM problem_categories WHERE id = ?').get(id) as unknown as
      | ProblemCategoryRow
      | undefined) ?? null
  );
}

export function getProblemCategoryByCode(
  db: DatabaseSync,
  code: string,
): ProblemCategoryRow | null {
  return (
    (db
      .prepare('SELECT * FROM problem_categories WHERE code = ?')
      .get(code.trim().toUpperCase()) as unknown as ProblemCategoryRow | undefined) ?? null
  );
}

/** Ensures the default `P` category exists (seq starts at 1001; no `L` is created). */
export function ensureDefaultProblemCategory(
  db: DatabaseSync,
  now = Date.now(),
): ProblemCategoryRow {
  const existing = getProblemCategoryByCode(db, 'P');
  if (existing) return existing;
  db.prepare(
    `INSERT INTO problem_categories(code, name, next_seq, seq_start, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).run('P', 'P', 1001, 1001, now);
  return getProblemCategoryByCode(db, 'P')!;
}

export interface CreateProblemCategoryInput {
  code: string;
  name?: string;
  seqStart?: number;
}

export function createProblemCategory(
  db: DatabaseSync,
  input: CreateProblemCategoryInput,
  now = Date.now(),
): ProblemCategoryRow {
  const code = normalizeCategoryCode(input.code);
  if (getProblemCategoryByCode(db, code)) {
    throw new ProblemNumberingError('CATEGORY_CODE_TAKEN', 409, `category ${code} already exists`);
  }
  const seqStart = normalizeSeqStart(input.seqStart, 1);
  const name = typeof input.name === 'string' && input.name.trim().length > 0 ? input.name.trim() : code;
  db.prepare(
    `INSERT INTO problem_categories(code, name, next_seq, seq_start, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  ).run(code, name, seqStart, seqStart, now);
  return getProblemCategoryByCode(db, code)!;
}

export interface UpdateProblemCategoryPatch {
  name?: string;
  seqStart?: number;
}

export function updateProblemCategory(
  db: DatabaseSync,
  id: number,
  patch: UpdateProblemCategoryPatch,
): ProblemCategoryRow | null {
  const current = getProblemCategoryById(db, id);
  if (!current) return null;
  const sets: string[] = [];
  const values: Array<string | number> = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0) {
      throw new ProblemNumberingError('INVALID_CATEGORY_NAME', 400, 'category name is required');
    }
    sets.push('name = ?');
    values.push(name);
  }
  if (patch.seqStart !== undefined) {
    const seqStart = normalizeSeqStart(patch.seqStart, current.seq_start);
    sets.push('seq_start = ?', 'next_seq = ?');
    values.push(seqStart);
    values.push(Math.max(current.next_seq, seqStart));
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE problem_categories SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
  return getProblemCategoryById(db, id);
}

function normalizeSeqStart(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PROBLEM_SEQ
  ) {
    throw new ProblemNumberingError(
      'INVALID_SEQ_START',
      400,
      'seqStart must be a positive integer',
    );
  }
  return value;
}
