import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import {
  createProblemCategory,
  getProblemCategoryByCode,
  listProblemCategories,
  ProblemNumberingError,
  updateProblemCategory,
} from '../src/storage/repos/problem-categories.js';
import {
  createProblem,
  getProblem,
  getProblemByIdOrDisplayId,
  resolveProblemReference,
  setProblemDisplayId,
} from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';

function freshDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function problemInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Numbered Problem',
    type: 'standard',
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

describe('problem numbering migration', () => {
  it('migrates legacy problems into P from P1001 in internal id order and is idempotent', () => {
    const db = openDatabase(':memory:');
    // Legacy schema: no categories table and no numbering columns.
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
    // Inserted out of order on purpose: numbering follows internal id, not rowid order.
    insert.run(9, 'third', 'standard', 1000, 64, 3);
    insert.run(2, 'first', 'standard', 1000, 64, 1);
    insert.run(5, 'second', 'standard', 1000, 64, 2);

    migrate(db);
    const rows = db
      .prepare('SELECT id, category_id, seq, display_id FROM problems ORDER BY id')
      .all() as unknown as Array<{
      id: number;
      category_id: number;
      seq: number;
      display_id: string;
    }>;
    expect(rows.map((row) => row.display_id)).toEqual(['P1001', 'P1002', 'P1003']);
    expect(rows.map((row) => row.seq)).toEqual([1001, 1002, 1003]);
    const category = getProblemCategoryByCode(db, 'P');
    expect(category).toMatchObject({ code: 'P', seq_start: 1001, next_seq: 1004 });
    expect(getProblemCategoryByCode(db, 'L')).toBeNull();

    migrate(db);
    const again = db
      .prepare('SELECT id, display_id FROM problems ORDER BY id')
      .all() as unknown as Array<{ id: number; display_id: string }>;
    expect(again.map((row) => row.display_id)).toEqual(['P1001', 'P1002', 'P1003']);
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1004);
    db.close();
  });

  it('backfills numbering columns for a legacy database that already has categories', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    // Simulate a pre-numbering row by clearing its assigned number.
    const legacyId = createProblem(db, problemInput({ title: 'legacy' }));
    db.prepare(
      'UPDATE problems SET category_id = NULL, seq = NULL, display_id = NULL WHERE id = ?',
    ).run(legacyId);
    migrate(db);
    // Numbers are never reused: the consumed P1001 stays reserved, so the
    // unnumbered row gets the next free value.
    expect(getProblem(db, legacyId)?.display_id).toBe('P1002');
    expect(getProblem(db, legacyId)?.seq).toBe(1002);
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1003);
    db.close();
  });
});

describe('category based numbering', () => {
  it('creates categories with normalized codes and starts a new problem at seq_start', () => {
    const db = freshDb();
    const category = createProblemCategory(db, { code: 'b', name: 'B 题库', seqStart: 100 });
    expect(category).toMatchObject({ code: 'B', name: 'B 题库', seq_start: 100, next_seq: 100 });
    expect(listProblemCategories(db).map((row) => row.code)).toContain('B');
    expect(() => createProblemCategory(db, { code: 'B' })).toThrow(ProblemNumberingError);
    expect(() => createProblemCategory(db, { code: 'p' })).toThrow(ProblemNumberingError);
    expect(() => createProblemCategory(db, { code: '1X' })).toThrow(ProblemNumberingError);
    db.close();
  });

  it('increments each category independently and defaults new problems to P', () => {
    const db = freshDb();
    const b = createProblemCategory(db, { code: 'B', seqStart: 100 });
    const p1 = createProblem(db, problemInput());
    const b1 = createProblem(db, problemInput({ categoryId: b.id }));
    const b2 = createProblem(db, problemInput({ categoryId: b.id }));
    const p2 = createProblem(db, problemInput());

    expect(getProblem(db, p1)?.display_id).toBe('P1001');
    expect(getProblem(db, p2)?.display_id).toBe('P1002');
    expect(getProblem(db, b1)?.display_id).toBe('B100');
    expect(getProblem(db, b2)?.display_id).toBe('B101');
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1003);
    expect(getProblemCategoryByCode(db, 'B')?.next_seq).toBe(102);
    db.close();
  });

  it('honors an explicit display id on creation and keeps the sequence collision free', () => {
    const db = freshDb();
    const manual = createProblem(db, problemInput({ displayId: 'p1500' }));
    expect(getProblem(db, manual)?.display_id).toBe('P1500');
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(1501);
    const next = createProblem(db, problemInput());
    expect(getProblem(db, next)?.display_id).toBe('P1501');
    expect(numberingCode(() => createProblem(db, problemInput({ displayId: 'P1500' })))).toBe(
      'DISPLAY_ID_TAKEN',
    );
    db.close();
  });

  it('lets admins move a problem to another category or number', () => {
    const db = freshDb();
    const b = createProblemCategory(db, { code: 'B', seqStart: 100 });
    const problemId = createProblem(db, problemInput());
    expect(setProblemDisplayId(db, problemId, 'P2000')).toMatchObject({
      displayId: 'P2000',
      seq: 2000,
    });
    expect(getProblem(db, problemId)?.display_id).toBe('P2000');
    expect(getProblemCategoryByCode(db, 'P')?.next_seq).toBe(2001);

    expect(setProblemDisplayId(db, problemId, 'b105')).toMatchObject({
      displayId: 'B105',
      categoryId: b.id,
      seq: 105,
    });
    expect(getProblemCategoryByCode(db, 'B')?.next_seq).toBe(106);
    const afterMove = createProblem(db, problemInput({ categoryId: b.id }));
    expect(getProblem(db, afterMove)?.display_id).toBe('B106');
    db.close();
  });

  it('rejects invalid and conflicting manual numbers', () => {
    const db = freshDb();
    createProblemCategory(db, { code: 'B', seqStart: 100 });
    const first = createProblem(db, problemInput());
    const second = createProblem(db, problemInput());
    expect(numberingCode(() => setProblemDisplayId(db, second, 'P1001'))).toBe('DISPLAY_ID_TAKEN');
    expect(numberingCode(() => setProblemDisplayId(db, second, '1001'))).toBe('INVALID_DISPLAY_ID');
    expect(numberingCode(() => setProblemDisplayId(db, second, 'P0'))).toBe('INVALID_DISPLAY_ID');
    expect(numberingCode(() => setProblemDisplayId(db, second, 'P1001x'))).toBe(
      'INVALID_DISPLAY_ID',
    );
    expect(numberingCode(() => setProblemDisplayId(db, second, 'ZZ100'))).toBe(
      'CATEGORY_NOT_FOUND',
    );
    expect(numberingCode(() => setProblemDisplayId(db, 999_999, 'P1001'))).toBe('NOT_FOUND');
    // The failed attempts above must not have changed anything.
    expect(getProblem(db, first)?.display_id).toBe('P1001');
    expect(getProblem(db, second)?.display_id).toBe('P1002');
    db.close();
  });

  it('renames a category without touching existing numbers', () => {
    const db = freshDb();
    const p = getProblemCategoryByCode(db, 'P')!;
    expect(updateProblemCategory(db, p.id, { name: '公共题库' })).toMatchObject({
      code: 'P',
      name: '公共题库',
    });
    expect(updateProblemCategory(db, 999_999, { name: 'nope' })).toBeNull();
    db.close();
  });

  it('resolves internal ids, numeric strings and display ids', () => {
    const db = freshDb();
    const id = createProblem(db, problemInput());
    expect(getProblemByIdOrDisplayId(db, 'P1001')?.id).toBe(id);
    expect(getProblemByIdOrDisplayId(db, 'p1001')?.id).toBe(id);
    expect(getProblemByIdOrDisplayId(db, String(id))?.id).toBe(id);
    expect(getProblemByIdOrDisplayId(db, id)?.id).toBe(id);
    expect(getProblemByIdOrDisplayId(db, 'P9999')).toBeNull();
    expect(getProblemByIdOrDisplayId(db, 999_999)).toBeNull();

    expect(resolveProblemReference(db, 'P1001')?.id).toBe(id);
    expect(resolveProblemReference(db, 'p1001')?.id).toBe(id);
    expect(resolveProblemReference(db, id)?.id).toBe(id);
    expect(resolveProblemReference(db, 'not-a-number')).toBeNull();
    db.close();
  });
});

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'problem-numbering-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';
let setterCookie = '';
let contestantCookie = '';

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'number-admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  const setterId = createUser(db, {
    username: 'number-setter',
    passwordHash: hashPassword('setter123'),
    role: 'setter',
  });
  const contestantId = createUser(db, {
    username: 'number-contestant',
    passwordHash: hashPassword('contestant123'),
    role: 'contestant',
  });
  const sign = (userId: number) =>
    `oij.sid=${signSession({ userId, version: 0 }, config.sessionSecret, 3600)}`;
  adminCookie = sign(adminId);
  setterCookie = sign(setterId);
  contestantCookie = sign(contestantId);
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('problem numbering HTTP API', () => {
  it('manages categories (admin only) and exposes P by default', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/admin/problem-categories',
      headers: { cookie: adminCookie },
    });
    expect(list.statusCode).toBe(200);
    const categories = (list.json() as { data: Array<{ code: string }> }).data;
    expect(categories.map((category) => category.code)).toContain('P');

    const setterList = await app.inject({
      method: 'GET',
      url: '/api/admin/problem-categories',
      headers: { cookie: setterCookie },
    });
    expect(setterList.statusCode).toBe(200);

    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/admin/problem-categories',
      headers: { cookie: contestantCookie },
      payload: { code: 'C' },
    });
    expect(forbidden.statusCode).toBe(403);

    const setterForbidden = await app.inject({
      method: 'POST',
      url: '/api/admin/problem-categories',
      headers: { cookie: setterCookie },
      payload: { code: 'C' },
    });
    expect(setterForbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problem-categories',
      headers: { cookie: adminCookie },
      payload: { code: 'C', name: 'C 题库', seqStart: 1 },
    });
    expect(created.statusCode).toBe(201);
    const category = (created.json() as { data: { id: number; code: string; nextSeq: number } })
      .data;
    expect(category).toMatchObject({ code: 'C', nextSeq: 1 });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/admin/problem-categories/${category.id}`,
      headers: { cookie: adminCookie },
      payload: { name: 'C 组题' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { data: { name: string } }).data.name).toBe('C 组题');

    const setterPatch = await app.inject({
      method: 'PATCH',
      url: `/api/admin/problem-categories/${category.id}`,
      headers: { cookie: setterCookie },
      payload: { name: 'nope' },
    });
    expect(setterPatch.statusCode).toBe(403);
  });

  it('creates numbered problems and resolves both display ids and internal ids', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: setterCookie },
      payload: { title: 'Numbered', type: 'standard', timeMs: 1000, memoryMb: 64 },
    });
    expect(created.statusCode).toBe(201);
    const data = (created.json() as { data: { id: number; displayId: string } }).data;
    expect(data.displayId).toBe('P1001');

    const byDisplay = await app.inject({ method: 'GET', url: '/api/problems/P1001' });
    expect(byDisplay.statusCode).toBe(200);
    expect((byDisplay.json() as { data: { id: number; displayId: string } }).data).toMatchObject({
      id: data.id,
      displayId: 'P1001',
    });

    const byId = await app.inject({ method: 'GET', url: `/api/problems/${data.id}` });
    expect(byId.statusCode).toBe(200);
    expect((byId.json() as { data: { displayId: string } }).data.displayId).toBe('P1001');

    const unknown = await app.inject({ method: 'GET', url: '/api/problems/P9999' });
    expect(unknown.statusCode).toBe(404);

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/admin/problems',
      headers: { cookie: adminCookie },
    });
    const adminRows = (adminList.json() as { data: Array<{ id: number; displayId: string }> }).data;
    expect(adminRows.find((row) => row.id === data.id)?.displayId).toBe('P1001');
  });

  it('creates problems in a chosen category and with an explicit number', async () => {
    const categories = await app.inject({
      method: 'GET',
      url: '/api/admin/problem-categories',
      headers: { cookie: adminCookie },
    });
    const c = (categories.json() as { data: Array<{ id: number; code: string }> }).data.find(
      (category) => category.code === 'C',
    )!;

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: adminCookie },
      payload: {
        title: 'C Manual',
        type: 'standard',
        timeMs: 1000,
        memoryMb: 64,
        categoryId: c.id,
        displayId: 'C42',
      },
    });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { data: { displayId: string } }).data.displayId).toBe('C42');

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: adminCookie },
      payload: {
        title: 'Bad',
        type: 'standard',
        timeMs: 1000,
        memoryMb: 64,
        displayId: 'C42x',
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: { code: string } }).error.code).toBe('INVALID_DISPLAY_ID');

    const taken = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: adminCookie },
      payload: {
        title: 'Taken',
        type: 'standard',
        timeMs: 1000,
        memoryMb: 64,
        displayId: 'C42',
      },
    });
    expect(taken.statusCode).toBe(409);
  });

  it('changes a display id with admin/setter permissions and reports conflicts', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/problems',
      headers: { cookie: adminCookie },
      payload: { title: 'Renumber', type: 'standard', timeMs: 1000, memoryMb: 64 },
    });
    const problemId = (created.json() as { data: { id: number } }).data.id;

    const forbidden = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/display-id`,
      headers: { cookie: contestantCookie },
      payload: { displayId: 'P3000' },
    });
    expect(forbidden.statusCode).toBe(403);

    const renumbered = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/display-id`,
      headers: { cookie: setterCookie },
      payload: { displayId: 'p3000' },
    });
    expect(renumbered.statusCode).toBe(200);
    expect((renumbered.json() as { data: { displayId: string } }).data.displayId).toBe('P3000');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}`,
      headers: { cookie: adminCookie },
    });
    expect(
      (detail.json() as { data: { displayId: string; seq: number } }).data,
    ).toMatchObject({ displayId: 'P3000', seq: 3000 });

    const conflict = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/display-id`,
      headers: { cookie: adminCookie },
      payload: { displayId: 'P1001' },
    });
    expect(conflict.statusCode).toBe(409);
    expect((conflict.json() as { error: { code: string } }).error.code).toBe('DISPLAY_ID_TAKEN');

    const invalid = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/display-id`,
      headers: { cookie: adminCookie },
      payload: { displayId: '1001' },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('accepts P-numbers and numeric ids as batch problem folders', () => {
    const id = createProblem(db, problemInput({ title: 'batch-folder' }));
    const display = getProblem(db, id)!.display_id!;
    expect(resolveProblemReference(db, display)?.id).toBe(id);
    expect(resolveProblemReference(db, String(id))?.id).toBe(id);
  });
});
