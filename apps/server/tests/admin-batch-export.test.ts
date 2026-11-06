import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { registerAdminBatchRoutes } from '../src/http/admin-batch.js';
import {
  iterateBatchCsv,
  iterateBatchExportRows,
} from '../src/services/batch-export.js';
import { hashPassword } from '../src/security/password.js';
import { openDatabase, transaction } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { addBatchItem, createBatchJob } from '../src/storage/repos/batches.js';
import { createProblem } from '../src/storage/repos/problems.js';
import {
  createSubmission,
  finishSubmission,
  replaceTestResults,
} from '../src/storage/repos/submissions.js';
import { createUser, getUserByUsername } from '../src/storage/repos/users.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-batch-export-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: FastifyInstance;
let problemA = 0;
let problemB = 0;

function makeUser(username: string): number {
  const existing = getUserByUsername(db, username);
  if (existing) return existing.id;
  return createUser(db, {
    username,
    passwordHash: hashPassword('x'),
    role: 'contestant',
  });
}

function addResultSubmission(input: {
  batchId: number;
  student: string;
  problemId: number;
  userId: number;
  verdict: 'AC' | 'WA';
  score: number;
  timeMs: number;
  memoryKb: number;
  tests: Array<{ verdict: 'AC' | 'WA'; score: number }>;
}): number {
  const submissionId = createSubmission(db, {
    problemId: input.problemId,
    userId: input.userId,
    language: 'cpp17',
    sourcePath: `${input.student}/main.cpp`,
    sourceHash: `hash-${input.student}-${input.problemId}`,
    batchId: input.batchId,
  });
  finishSubmission(db, submissionId, {
    status: 'finished',
    verdict: input.verdict,
    score: input.score,
    timeMs: input.timeMs,
    memoryKb: input.memoryKb,
  });
  replaceTestResults(
    db,
    submissionId,
    input.tests.map((test, index) => ({
      testcaseId: index + 1,
      verdict: test.verdict,
      timeMs: input.timeMs,
      memoryKb: input.memoryKb,
      score: test.score,
      message: '',
    })),
  );
  addBatchItem(db, {
    batchId: input.batchId,
    student: input.student,
    sourcePath: `${input.student}/main.cpp`,
    submissionId,
    problemId: input.problemId,
    userId: input.userId,
    status: 'imported',
  });
  return submissionId;
}

/** Batch with two problems, five students, and one unjudged item of each kind. */
function seedExportBatch(): number {
  const batchId = createBatchJob(db, {
    problemId: 0,
    studentLevel: 1,
    mode: 'sync',
    problemLevel: 2,
    status: 'finished',
  });
  const alice = makeUser('alice');
  const bob = makeUser('bob');
  const weird = makeUser('weird');
  addResultSubmission({
    batchId,
    student: 'Alice',
    problemId: problemA,
    userId: alice,
    verdict: 'AC',
    score: 100,
    timeMs: 12,
    memoryKb: 3400,
    tests: [
      { verdict: 'AC', score: 50 },
      { verdict: 'AC', score: 50 },
    ],
  });
  addResultSubmission({
    batchId,
    student: 'Bob',
    problemId: problemA,
    userId: bob,
    verdict: 'WA',
    score: 40,
    timeMs: 55,
    memoryKb: 12000,
    tests: [
      { verdict: 'AC', score: 50 },
      { verdict: 'WA', score: 0 },
    ],
  });
  addResultSubmission({
    batchId,
    student: 'Alice',
    problemId: problemB,
    userId: alice,
    verdict: 'WA',
    score: 0,
    timeMs: 7,
    memoryKb: 900,
    tests: [{ verdict: 'WA', score: 0 }],
  });
  // Import failure: quoted, comma-containing student name, no submission.
  addBatchItem(db, {
    batchId,
    student: '李"四,五',
    sourcePath: '李"四,五/main.cpp',
    problemId: problemA,
    userId: weird,
    status: 'error',
    errorCode: 'SOURCE_TOO_LARGE',
    errorMessage: 'too large',
  });
  // Skipped student folder.
  addBatchItem(db, {
    batchId,
    student: 'Carol',
    sourcePath: 'Carol',
    problemId: null,
    status: 'skipped',
    errorCode: 'INVALID_STUDENT_FOLDER',
    errorMessage: 'no source',
  });
  // Imported but the submission row is gone: must render as missing, not crash.
  addBatchItem(db, {
    batchId,
    student: 'Dave',
    sourcePath: 'Dave/main.cpp',
    problemId: problemA,
    status: 'imported',
  });
  return batchId;
}

async function exportFile(
  batchId: number,
  query: string,
  headers: Record<string, string> = { 'x-admin': '1' },
): Promise<{ statusCode: number; body: string; raw: Buffer; headers: Record<string, unknown> }> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/admin/batch/${batchId}/export?${query}`,
    headers,
  });
  return {
    statusCode: response.statusCode,
    body: response.body,
    raw: response.rawPayload,
    headers: response.headers as Record<string, unknown>,
  };
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  problemA = createProblem(db, {
    title: 'A+B 问题',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 256,
    displayId: 'P1001',
    testcases: [
      { inputPath: '1.in', outputPath: '1.out', points: 50 },
      { inputPath: '2.in', outputPath: '2.out', points: 50 },
    ],
  });
  problemB = createProblem(db, {
    title: '逗号, 引号"题"',
    type: 'standard',
    timeMs: 2000,
    memoryMb: 512,
    displayId: 'P1002',
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  app = Fastify({ logger: false });
  registerAdminBatchRoutes(app, {
    db,
    config,
    adminGuard: async (request, reply) => {
      if (request.headers['x-admin'] !== '1') {
        await reply.code(403).send({ ok: false, error: { code: 'FORBIDDEN' } });
      }
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('batch export auth and validation', () => {
  it('rejects requests without the admin guard', async () => {
    const batchId = seedExportBatch();
    const result = await exportFile(batchId, 'format=csv', {});
    expect(result.statusCode).toBe(403);
  });

  it('404s for an unknown batch and 400s for an unknown format', async () => {
    const missing = await exportFile(999_999, 'format=csv');
    expect(missing.statusCode).toBe(404);
    const batchId = seedExportBatch();
    const bad = await exportFile(batchId, 'format=pdf');
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('INVALID_FORMAT');
  });
});

describe('batch CSV export', () => {
  it('streams a long table with the required columns and escaped fields', async () => {
    const batchId = seedExportBatch();
    const result = await exportFile(batchId, 'format=csv');
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('text/csv');
    expect(result.headers['content-disposition']).toContain('attachment');
    const text = result.body.replace(/^\uFEFF/, '');
    const lines = text.split('\r\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe(
      '学生,题号,题目,状态,verdict,得分,用时(ms),内存(KB),通过测试点,总测试点',
    );
    // Quote/comma in a student name and a problem title must survive round-trip.
    expect(text).toContain('"李""四,五"');
    expect(text).toContain('"逗号, 引号""题"""');
    const bobLine = lines.find((line) => line.startsWith('Bob,'));
    expect(bobLine).toBe(`Bob,P1001,A+B 问题,已完成,WA,40,55,12000,1,2`);
    const aliceA = lines.find(
      (line) => line.startsWith('Alice,P1001,') && line.includes('AC,100'),
    );
    expect(aliceA).toContain(',AC,100,12,3400,2,2');
    const failed = lines.find((line) => line.includes('SOURCE') || line.includes('李'));
    expect(failed).toContain('导入失败');
    expect(failed).toContain('0,0,0,0,0');
  });

  it('exports the student × problem matrix when matrix=1', async () => {
    const batchId = seedExportBatch();
    const result = await exportFile(batchId, 'format=csv&matrix=1');
    expect(result.statusCode).toBe(200);
    const lines = result.body
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .filter((line) => line.length > 0);
    expect(lines[0]).toContain('学生');
    expect(lines[0]).toContain('P1001');
    expect(lines[0]).toContain('P1002');
    expect(lines[0]).toContain('总分');
    expect(lines[0]).toContain('AC 数');
    const alice = lines.find((line) => line.startsWith('Alice,'));
    expect(alice).toBe('Alice,100,0,100,1');
    const bob = lines.find((line) => line.startsWith('Bob,'));
    expect(bob).toBe('Bob,40,,40,0');
  });

  it('writes 5000 rows as one chunk per row instead of one giant string', async () => {
    const batchId = createBatchJob(db, {
      problemId: problemA,
      studentLevel: 1,
      mode: 'sync',
      status: 'finished',
    });
    transaction(db, () => {
      for (let index = 0; index < 5000; index += 1) {
        addBatchItem(db, {
          batchId,
          student: `Student${String(index).padStart(4, '0')}`,
          sourcePath: `Student${index}/main.cpp`,
          problemId: problemA,
          status: 'error',
          errorCode: 'EMPTY_SOURCE',
          errorMessage: 'source file is empty',
        });
      }
    });
    const rowCount = [];
    for await (const _row of iterateBatchExportRows(db, batchId)) {
      rowCount.push(1);
    }
    expect(rowCount).toHaveLength(5000);

    const chunks: string[] = [];
    for await (const chunk of iterateBatchCsv(db, batchId)) chunks.push(chunk);
    expect(chunks).toHaveLength(5001);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThan(4096);

    const result = await exportFile(batchId, 'format=csv');
    const lines = result.body
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(5001);
    expect(lines[1]).toContain('Student0000');
    expect(lines[5000]).toContain('Student4999');
  }, 60_000);
});

describe('batch HTML export', () => {
  it('is self-contained, printable, escaped, and includes an analysis summary', async () => {
    const batchId = seedExportBatch();
    const result = await exportFile(batchId, 'format=html');
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain('text/html');
    const html = result.body;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('@media print');
    expect(html).toContain('自动分析');
    expect(html).toContain('学生 × 题目矩阵');
    expect(html).toContain('P1001');
    expect(html).toContain('P1002');
    expect(html).toContain('李&quot;四,五');
    expect(html).toContain('逗号, 引号&quot;题&quot;');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    // The matrix cell for Alice/P1001 carries the score.
    expect(html).toContain('>100<');
    expect(html).toContain('AC 率');
  });
});

describe('batch XLSX export', () => {
  it('writes a long-table sheet plus a matrix sheet', async () => {
    const batchId = seedExportBatch();
    const result = await exportFile(batchId, 'format=xlsx');
    expect(result.statusCode).toBe(200);
    expect(result.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result.raw.length).toBeGreaterThan(0);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.raw);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      '成绩明细',
      '学生题目矩阵',
    ]);
    const detail = workbook.getWorksheet('成绩明细')!;
    expect(detail.rowCount).toBe(7);
    expect(detail.getRow(1).getCell(1).value).toBe('学生');
    expect(detail.getRow(1).getCell(10).value).toBe('总测试点');
    const bobRow = detail
      .getRows(2, detail.rowCount)
      ?.find((row) => row.getCell(1).value === 'Bob');
    expect(bobRow?.getCell(2).value).toBe('P1001');
    expect(bobRow?.getCell(5).value).toBe('WA');
    expect(bobRow?.getCell(6).value).toBe(40);
    expect(bobRow?.getCell(9).value).toBe(1);
    expect(bobRow?.getCell(10).value).toBe(2);

    const matrix = workbook.getWorksheet('学生题目矩阵')!;
    expect(matrix.getRow(1).getCell(1).value).toBe('学生');
    expect(String(matrix.getRow(1).getCell(2).value)).toContain('P1001');
    expect(String(matrix.getRow(1).getCell(3).value)).toContain('P1002');
    const aliceRow = matrix
      .getRows(2, matrix.rowCount)
      ?.find((row) => row.getCell(1).value === 'Alice');
    expect(aliceRow?.getCell(2).value).toBe(100);
    expect(aliceRow?.getCell(3).value).toBe(0);
  });
});

describe('batch export without data', () => {
  it('renders headers only for CSV/XLSX and an empty-state HTML page', async () => {
    const batchId = createBatchJob(db, {
      problemId: problemA,
      studentLevel: 1,
      mode: 'sync',
      status: 'finished',
    });
    const csv = await exportFile(batchId, 'format=csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.body.replace(/^\uFEFF/, '').trim().split('\r\n')).toHaveLength(1);

    const html = await exportFile(batchId, 'format=html');
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('没有可导出的成绩记录');

    const xlsx = await exportFile(batchId, 'format=xlsx');
    expect(xlsx.statusCode).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.raw);
    expect(workbook.getWorksheet('成绩明细')!.rowCount).toBe(1);
    expect(workbook.getWorksheet('学生题目矩阵')!.rowCount).toBe(1);
  });
});
