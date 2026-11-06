import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { recoverInterruptedBatchImports } from '../src/services/batch-import.js';
import { hashPassword } from '../src/security/password.js';
import {
  addBatchItem,
  createBatchJob,
  getBatchItemStats,
  getBatchJob,
  listBatchItems,
  setBatchStatus,
} from '../src/storage/repos/batches.js';
import { createBatchUpload } from '../src/storage/repos/batch-uploads.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'batch-resume-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let problemId = 0;

const AC_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}';

function encode(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function createUpload(files: Record<string, Uint8Array>): string {
  const uploadId = randomUUID();
  const zip = zipSync(files);
  const directory = join(config.dataDir, 'uploads', 'batch');
  mkdirSync(directory, { recursive: true });
  const relativePath = `uploads/batch/${uploadId}.zip`;
  writeFileSync(join(config.dataDir, relativePath), zip);
  createBatchUpload(db, {
    uploadId,
    zipPath: relativePath,
    sizeBytes: zip.byteLength,
    sha256: 'test-sha256',
  });
  return uploadId;
}

function createInterruptedJob(
  uploadId: string | null,
  existing: Array<{ student: string; status: 'imported' | 'error' }> = [],
): number {
  const batchId = createBatchJob(db, {
    problemId,
    studentLevel: 1,
    mode: 'async',
    status: 'importing',
    uploadId,
  });
  for (const item of existing) {
    addBatchItem(db, {
      batchId,
      student: item.student,
      sourcePath: `${item.student}/main.cpp`,
      problemId,
      status: item.status,
      errorCode: item.status === 'error' ? 'EMPTY_SOURCE' : null,
      errorMessage: item.status === 'error' ? 'source file is empty' : null,
    });
  }
  return batchId;
}

async function waitForJobToSettle(batchId: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getBatchJob(db, batchId);
    if (!job || job.status !== 'importing') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

beforeAll(() => {
  ensureDataDirs(root);
  migrate(db);
  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  expect(adminId).toBeGreaterThan(0);
  problemId = createProblem(db, {
    title: 'A+B',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 128,
    displayId: 'P1001',
    testcases: [],
  });
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('interrupted batch import resume', () => {
  it('skips already imported items and imports the remaining sources', async () => {
    const uploadId = createUpload({
      'Alice/main.cpp': encode(AC_SOURCE),
      'Bob/main.cpp': encode(AC_SOURCE),
      'Carol/main.cpp': encode(AC_SOURCE),
      'Dave/main.cpp': encode(AC_SOURCE),
    });
    const batchId = createInterruptedJob(uploadId, [
      { student: 'Alice', status: 'imported' },
      { student: 'Bob', status: 'imported' },
    ]);

    const handled = recoverInterruptedBatchImports(db, { config });
    expect(handled).toBeGreaterThanOrEqual(1);
    await waitForJobToSettle(batchId);

    const job = getBatchJob(db, batchId)!;
    expect(job.status).toBe('queued');
    const items = listBatchItems(db, batchId);
    expect(items).toHaveLength(4);
    expect(new Set(items.map((item) => item.source_path)).size).toBe(4);
    expect(items.filter((item) => item.student === 'Alice')).toHaveLength(1);
    expect(items.filter((item) => item.student === 'Bob')).toHaveLength(1);
    const imported = items.filter((item) => item.status === 'imported');
    expect(imported).toHaveLength(4);
    // Only the sources imported by the resumed run have a real submission; the
    // pre-existing rows stand in for items committed before the restart.
    for (const item of imported.filter((entry) => entry.student !== 'Alice' && entry.student !== 'Bob')) {
      expect(item.submission_id).not.toBeNull();
      expect(item.problem_id).toBe(problemId);
    }
    expect(getBatchItemStats(db, batchId).imported).toBe(4);
  }, 30_000);

  it('is idempotent when the same job is resumed again', async () => {
    const uploadId = createUpload({
      'Alice/main.cpp': encode(AC_SOURCE),
      'Bob/main.cpp': encode(AC_SOURCE),
    });
    const batchId = createInterruptedJob(uploadId);
    recoverInterruptedBatchImports(db, { config });
    await waitForJobToSettle(batchId);
    const firstItems = listBatchItems(db, batchId);
    expect(firstItems).toHaveLength(2);

    // Pretend the process restarted again while the same job was importing.
    setBatchStatus(db, batchId, 'importing');
    const handled = recoverInterruptedBatchImports(db, { config });
    expect(handled).toBeGreaterThanOrEqual(1);
    await waitForJobToSettle(batchId);

    const secondItems = listBatchItems(db, batchId);
    expect(secondItems).toHaveLength(2);
    expect(new Set(secondItems.map((item) => item.source_path)).size).toBe(2);
    expect(secondItems.filter((item) => item.status === 'imported')).toHaveLength(2);
    expect(getBatchJob(db, batchId)!.status).toBe('queued');
  }, 30_000);

  it('does not re-insert a recorded failure while importing the rest', async () => {
    const uploadId = createUpload({
      'Good/main.cpp': encode(AC_SOURCE),
      'Empty/main.cpp': new Uint8Array(0),
    });
    const batchId = createInterruptedJob(uploadId, [{ student: 'Empty', status: 'error' }]);

    recoverInterruptedBatchImports(db, { config });
    await waitForJobToSettle(batchId);

    const items = listBatchItems(db, batchId);
    expect(items).toHaveLength(2);
    const empty = items.filter((item) => item.student === 'Empty');
    expect(empty).toHaveLength(1);
    expect(empty[0]!.status).toBe('error');
    const good = items.find((item) => item.student === 'Good');
    expect(good?.status).toBe('imported');
    expect(good?.submission_id).not.toBeNull();
  }, 30_000);

  it('marks the job failed when its upload archive is unavailable', async () => {
    const batchId = createInterruptedJob(null);
    const handled = recoverInterruptedBatchImports(db, { config });
    expect(handled).toBeGreaterThanOrEqual(1);
    const job = getBatchJob(db, batchId)!;
    expect(job.status).toBe('failed');
    expect(job.meta_json).toContain('BATCH_RESUME_UPLOAD_MISSING');

    const missingZipJob = createInterruptedJob(randomUUID());
    recoverInterruptedBatchImports(db, { config });
    const missingZip = getBatchJob(db, missingZipJob)!;
    expect(missingZip.status).toBe('failed');
    expect(missingZip.meta_json).toContain('BATCH_RESUME_UPLOAD_MISSING');
  });

  it('leaves jobs that are not in the importing state alone', () => {
    const canceled = createBatchJob(db, {
      problemId,
      studentLevel: 1,
      mode: 'async',
      status: 'canceled',
      uploadId: null,
    });
    const failed = createBatchJob(db, {
      problemId,
      studentLevel: 1,
      mode: 'async',
      status: 'failed',
      uploadId: null,
    });
    recoverInterruptedBatchImports(db, { config });
    expect(getBatchJob(db, canceled)!.status).toBe('canceled');
    expect(getBatchJob(db, failed)!.status).toBe('failed');
  });
});
