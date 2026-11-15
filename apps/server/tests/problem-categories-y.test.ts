import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import {
  ensureObjectiveProblemCategory,
  getProblemCategoryByCode,
  listProblemCategories,
  ProblemNumberingError,
} from '../src/storage/repos/problem-categories.js';
import {
  createProblem,
  getProblem,
  setProblemDisplayId,
} from '../src/storage/repos/problems.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function freshDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'oij-category-y-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  return db;
}

function problemInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Objective numbering',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [],
    ...overrides,
  };
}

function numberingCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProblemNumberingError) return error.code;
    throw error;
  }
  throw new Error('expected ProblemNumberingError');
}

function displayIds(db: DatabaseSync): string[] {
  return (
    db.prepare('SELECT display_id FROM problems ORDER BY id').all() as unknown as Array<{
      display_id: string;
    }>
  ).map((row) => row.display_id);
}

describe('objective category Y', () => {
  it('creates P and Y on a fresh database with Y starting at 1001', () => {
    const db = freshDb();
    expect(listProblemCategories(db).map((row) => row.code)).toEqual(['P', 'Y']);
    const y = getProblemCategoryByCode(db, 'Y');
    expect(y).toMatchObject({
      code: 'Y',
      name: '客观题题库',
      seq_start: 1001,
      next_seq: 1001,
    });
    // Existing P semantics are untouched.
    expect(getProblemCategoryByCode(db, 'P')).toMatchObject({
      seq_start: 1001,
      next_seq: 1001,
    });
    // Ensuring Y twice is idempotent and never resets its counter.
    expect(ensureObjectiveProblemCategory(db).id).toBe(y!.id);
  });

  it('auto-numbers objective problems Y1001, Y1002 while P keeps its own sequence', () => {
    const db = freshDb();
    const p1 = createProblem(db, problemInput({ type: 'standard' }));
    const y1 = createProblem(db, problemInput());
    const y2 = createProblem(db, problemInput());
    const p2 = createProblem(db, problemInput({ type: 'standard' }));

    expect(getProblem(db, p1)?.display_id).toBe('P1001');
    expect(getProblem(db, p2)?.display_id).toBe('P1002');
    expect(getProblem(db, y1)?.display_id).toBe('Y1001');
    expect(getProblem(db, y2)?.display_id).toBe('Y1002');
    expect(getProblem(db, y1)?.type).toBe('objective');
    expect(getProblem(db, y1)?.category_id).toBe(getProblemCategoryByCode(db, 'Y')!.id);
    expect(getProblemCategoryByCode(db, 'Y')?.next_seq).toBe(1003);
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1003);
    expect(new Set(displayIds(db)).size).toBe(displayIds(db).length);
    expect(displayIds(db)).toEqual(['P1001', 'Y1001', 'Y1002', 'P1002']);
  });

  it('accepts a manual Y1001 and continues allocation after it', () => {
    const db = freshDb();
    const manual = createProblem(db, problemInput({ displayId: 'y1001' }));
    expect(getProblem(db, manual)?.display_id).toBe('Y1001');
    expect(getProblemCategoryByCode(db, 'Y')?.next_seq).toBe(1002);

    const auto = createProblem(db, problemInput());
    expect(getProblem(db, auto)?.display_id).toBe('Y1002');
    expect(getProblemCategoryByCode(db, 'Y')?.next_seq).toBe(1003);

    expect(numberingCode(() => createProblem(db, problemInput({ displayId: 'Y1001' })))).toBe(
      'DISPLAY_ID_TAKEN',
    );
    const other = createProblem(db, problemInput({ type: 'standard' }));
    expect(numberingCode(() => setProblemDisplayId(db, other, 'Y1001'))).toBe('DISPLAY_ID_TAKEN');
    expect(numberingCode(() => setProblemDisplayId(db, other, 'Y1002'))).toBe('DISPLAY_ID_TAKEN');
    // Failed renumbering attempts leave every existing number intact.
    expect(getProblem(db, manual)?.display_id).toBe('Y1001');
    expect(getProblem(db, other)?.display_id).toBe('P1001');
  });

  it('adds Y to an existing database without touching P numbers', () => {
    const db = freshDb();
    const p = createProblem(db, problemInput({ type: 'standard' }));
    // Simulate a database created before Y existed: an objective problem that
    // was already numbered in P, and no Y category at all.
    const legacyObjective = createProblem(db, problemInput({ displayId: 'P1002' }));
    db.prepare('DELETE FROM problem_categories WHERE code = ?').run('Y');

    migrate(db);

    expect(getProblem(db, p)?.display_id).toBe('P1001');
    expect(getProblem(db, legacyObjective)?.display_id).toBe('P1002');
    expect(getProblem(db, legacyObjective)?.category_id).toBe(
      getProblemCategoryByCode(db, 'P')!.id,
    );
    expect(getProblemCategoryByCode(db, 'Y')).toMatchObject({
      seq_start: 1001,
      next_seq: 1001,
    });
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1003);

    const y = createProblem(db, problemInput());
    expect(getProblem(db, y)?.display_id).toBe('Y1001');
    expect(getProblemCategoryByCode(db, 'Y')?.next_seq).toBe(1002);
  });

  it('keeps legacy backfill in P and leaves the empty Y sequence alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-category-y-legacy-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'test.db'));
    dbs.push(db);
    db.exec(`
      CREATE TABLE problems(
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, type TEXT NOT NULL,
        difficulty INTEGER, tags_json TEXT NOT NULL DEFAULT '[]', time_ms INTEGER NOT NULL,
        memory_mb INTEGER NOT NULL, output_mb INTEGER NOT NULL DEFAULT 64,
        io_mode TEXT NOT NULL DEFAULT 'stdio', input_file TEXT, output_file TEXT,
        statement_html TEXT NOT NULL DEFAULT '', samples_json TEXT NOT NULL DEFAULT '[]',
        checker_mode TEXT NOT NULL DEFAULT 'builtin', checker_path TEXT,
        compare_mode TEXT NOT NULL DEFAULT 'ignore-trailing',
        objective_json TEXT NOT NULL DEFAULT '{}',
        visibility TEXT NOT NULL DEFAULT 'public', owner_type TEXT NOT NULL DEFAULT 'system',
        owner_id INTEGER, version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
      )
    `);
    const insert = db.prepare(
      'INSERT INTO problems(id, title, type, time_ms, memory_mb, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insert.run(9, 'legacy objective', 'objective', 1000, 64, 3);
    insert.run(2, 'legacy standard', 'standard', 1000, 64, 1);
    insert.run(5, 'legacy standard 2', 'standard', 1000, 64, 2);

    migrate(db);
    expect(displayIds(db)).toEqual(['P1001', 'P1002', 'P1003']);
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1004);
    expect(getProblemCategoryByCode(db, 'Y')).toMatchObject({
      seq_start: 1001,
      next_seq: 1001,
    });

    migrate(db);
    expect(displayIds(db)).toEqual(['P1001', 'P1002', 'P1003']);
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1004);
    expect(getProblemCategoryByCode(db, 'Y')?.next_seq).toBe(1001);
  });
});
