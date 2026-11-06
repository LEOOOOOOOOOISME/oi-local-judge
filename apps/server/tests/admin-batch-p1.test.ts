import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { registerAdminBatchRoutes } from '../src/http/admin-batch.js';
import { registerAdminBodyParsers } from '../src/http/admin-body-parser.js';
import { startScheduler, type SchedulerHandle } from '../src/judge/scheduler.js';
import { recoverInterruptedBatchImports } from '../src/services/batch-import.js';
import { MAX_BATCH_ZIP_BYTES } from '../src/services/batch-zip.js';
import { hashPassword } from '../src/security/password.js';
import { importProblemDirectory } from '../src/services/problems.js';
import { createBatchJob, getBatchJob } from '../src/storage/repos/batches.js';
import { getBatchUpload } from '../src/storage/repos/batch-uploads.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'admin-batch-p1-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: FastifyInstance;
let scheduler: SchedulerHandle;
let problemId = 0;

const AC_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}';
const WA_SOURCE =
  '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b+1<<"\\n";}';

function encode(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

interface UploadResult {
  uploadId: string;
  sizeBytes: number;
  sha256: string;
}

/** Writes a ZIP to a temp file and uploads it as a real request stream. */
async function uploadStreamed(files: Record<string, Uint8Array>): Promise<UploadResult> {
  const zip = zipSync(files);
  const zipPath = join(root, `upload-${Date.now()}-${Math.random().toString(16).slice(2)}.zip`);
  writeFileSync(zipPath, zip);
  const size = statSync(zipPath).size;
  const response = await app.inject({
    method: 'POST',
    url: '/api/admin/batch/uploads',
    headers: {
      'content-type': 'application/zip',
      'content-length': String(size),
    },
    payload: createReadStream(zipPath),
  });
  expect(response.statusCode, response.body).toBe(201);
  const data = (response.json() as { data: UploadResult }).data;
  expect(data.sizeBytes).toBe(size);
  expect(data.sha256).toBe(createHash('sha256').update(zip).digest('hex'));
  return data;
}

async function startAsyncRun(
  uploadId: string,
  body: Record<string, unknown> = {},
): Promise<number> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/admin/batch/uploads/${uploadId}/run`,
    payload: { studentLevel: 1, problemId, ...body },
  });
  expect(response.statusCode, response.body).toBe(202);
  const data = response.json() as { data: { jobId: number; status: string } };
  expect(data.data.status).toBe('importing');
  return data.data.jobId;
}

interface BatchProgressBody {
  id: number;
  status: string;
  jobStatus: string;
  total: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  judgedCount: number;
  progress: { percent: number; phase: string };
  items: Array<{
    student: string;
    sourcePath: string;
    problemId: number | null;
    importStatus: string | null;
    status: string;
    verdict: string | null;
    submissionId: number | null;
    errorCode: string | null;
  }>;
}

async function getBatch(batchId: number, query = ''): Promise<BatchProgressBody> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/admin/batch/${batchId}${query}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { data: BatchProgressBody }).data;
}

async function waitForStatus(
  batchId: number,
  wanted: string[],
  timeoutMs = 30_000,
): Promise<BatchProgressBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await getBatch(batchId);
    if (wanted.includes(body.status) || Date.now() > deadline) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  problemId = importProblemDirectory({
    db,
    config,
    sourceDir: join(process.cwd(), 'tools/seed/sample-problem'),
  });
  app = Fastify({ logger: false });
  registerAdminBodyParsers(app);
  registerAdminBatchRoutes(app, {
    db,
    config,
    adminGuard: async () => {},
    maxSourceBytes: 1024,
  });
  await app.ready();
  scheduler = startScheduler({ db, config, pollIntervalMs: 25 });
});

afterAll(async () => {
  await scheduler.stop();
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('P1 streaming upload', () => {
  it('streams a ZIP larger than the default 1 MiB body limit to disk with a sha256', async () => {
    // Incompressible payload so the archive itself is comfortably > 1 MiB.
    const big = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < big.length; index += 1) big[index] = index % 251;
    const uploaded = await uploadStreamed({ 'big.bin': big });
    const row = getBatchUpload(db, uploaded.uploadId);
    expect(row).toBeTruthy();
    expect(row!.size_bytes).toBe(uploaded.sizeBytes);
    expect(row!.sha256).toBe(uploaded.sha256);
    expect(existsSync(join(config.dataDir, row!.zip_path))).toBe(true);
    expect(row!.entry_count).toBe(0);
  }, 30_000);

  it('rejects an oversized Content-Length before reading the body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/batch/uploads',
      headers: {
        'content-type': 'application/zip',
        'content-length': String(MAX_BATCH_ZIP_BYTES + 1),
      },
      payload: 'not a zip',
    });
    expect(response.statusCode).toBe(413);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'BATCH_ZIP_TOO_LARGE',
    );
  });
});

describe('P1 preview', () => {
  it('reports students, problem folders, duplicates and invalid students', async () => {
    const uploaded = await uploadStreamed({
      'Alice/mapped/main.cpp': encode(AC_SOURCE),
      'Alice/mapped/duplicate.cpp': encode(WA_SOURCE),
      'Bob/mapped/empty.cpp': new Uint8Array(0),
      'Carol/unknown/main.cpp': encode(AC_SOURCE),
      'Dave/notes.txt': encode('not source'),
      'Empty/': new Uint8Array(0),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/batch/uploads/${uploaded.uploadId}/preview?studentLevel=1&problemLevel=2`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const data = (
      response.json() as {
        data: {
          totalFiles: number;
          validCount: number;
          students: number;
          problemFolders: string[];
          invalidStudents: Array<{ student: string }>;
          duplicates: Array<{ student: string; sourcePath: string }>;
          duplicateCount: number;
          treeSample: string[];
          maxDepth: number;
        };
      }
    ).data;
    expect(data.totalFiles).toBe(5);
    expect(data.validCount).toBe(2);
    expect(data.students).toBe(5);
    expect(data.problemFolders.sort()).toEqual(['mapped', 'unknown']);
    expect(new Set(data.invalidStudents.map((item) => item.student))).toEqual(
      new Set(['Dave', 'Empty']),
    );
    expect(data.duplicateCount).toBe(1);
    expect(data.duplicates[0]!.student).toBe('Alice');
    expect(data.duplicates[0]!.sourcePath).toBe('Alice/mapped/main.cpp');
    expect(data.treeSample.length).toBeGreaterThan(0);
    expect(data.maxDepth).toBe(3);

    // The scan counters are persisted on the upload row.
    const row = getBatchUpload(db, uploaded.uploadId);
    expect(row!.entry_count).toBeGreaterThanOrEqual(5);
    expect(row!.total_uncompressed_bytes).toBeGreaterThan(0);
  }, 30_000);

  it('drops traversal and absolute entries instead of failing the archive', async () => {
    const uploaded = await uploadStreamed({
      '../evil/main.cpp': encode(AC_SOURCE),
      '/abs/main.cpp': encode(AC_SOURCE),
      'Good/main.cpp': encode(AC_SOURCE),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/batch/uploads/${uploaded.uploadId}/preview?studentLevel=1&problemLevel=0`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const data = (
      response.json() as {
        data: { validCount: number; skipped: Array<{ path: string; reason: string }> };
      }
    ).data;
    expect(data.validCount).toBe(1);
    expect(data.skipped.map((entry) => entry.reason).sort()).toEqual([
      'UNSAFE_PATH',
      'UNSAFE_PATH',
    ]);
  }, 30_000);
});

describe('P1 async import', () => {
  it('imports in the background, judges, and reaches finished', async () => {
    const uploaded = await uploadStreamed({
      'Alice/main.cpp': encode(AC_SOURCE),
      'Bob/main.cpp': encode(WA_SOURCE),
    });
    const batchId = await startAsyncRun(uploaded.uploadId);

    const body = await waitForStatus(batchId, ['finished']);
    expect(body.status).toBe('finished');
    expect(body.importedCount).toBe(2);
    expect(body.judgedCount).toBe(2);
    expect(body.errorCount).toBe(0);
    expect(body.progress.percent).toBe(100);

    const alice = body.items.find((item) => item.student === 'Alice');
    const bob = body.items.find((item) => item.student === 'Bob');
    expect(alice?.importStatus).toBe('imported');
    expect(alice?.verdict).toBe('AC');
    expect(bob?.verdict).toBe('WA');

    // Batch judge tasks must yield to online submissions (priority 10).
    const priorities = db
      .prepare(
        `SELECT jt.priority AS priority FROM judge_tasks jt
         JOIN submissions s ON s.id = jt.submission_id
         WHERE s.batch_id = ?`,
      )
      .all(batchId) as unknown as Array<{ priority: number }>;
    expect(priorities).toHaveLength(2);
    expect(priorities.every((row) => row.priority === 10)).toBe(true);
  }, 40_000);

  it('isolates per-item failures instead of failing the whole batch', async () => {
    const uploaded = await uploadStreamed({
      'Good/main.cpp': encode(AC_SOURCE),
      'Huge/main.cpp': new Uint8Array(4096).fill(65),
      'Empty/main.cpp': new Uint8Array(0),
      'Notes/readme.txt': encode('no source'),
    });
    const batchId = await startAsyncRun(uploaded.uploadId);
    const body = await waitForStatus(batchId, ['finished', 'failed']);
    expect(body.status).toBe('finished');
    expect(body.importedCount).toBe(1);
    expect(body.errorCount).toBe(2);
    expect(body.skippedCount).toBe(1);
    const byStudent = new Map(body.items.map((item) => [item.student, item]));
    expect(byStudent.get('Good')?.importStatus).toBe('imported');
    expect(byStudent.get('Huge')?.errorCode).toBe('SOURCE_TOO_LARGE');
    expect(byStudent.get('Empty')?.errorCode).toBe('EMPTY_SOURCE');
    expect(byStudent.get('Notes')?.errorCode).toBe('INVALID_STUDENT_FOLDER');
  }, 40_000);

  it('exposes paginated progress and filters by import status', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < 5; index += 1) {
      files[`Student${index}/main.cpp`] = encode(AC_SOURCE);
    }
    const uploaded = await uploadStreamed(files);
    const batchId = await startAsyncRun(uploaded.uploadId);
    await waitForStatus(batchId, ['finished']);

    const page = await getBatch(batchId, '?offset=1&limit=2');
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.progress.phase).toBe('finished');

    const imported = await getBatch(batchId, '?status=imported&limit=100');
    expect(imported.items).toHaveLength(5);
    const errors = await getBatch(batchId, '?status=error');
    expect(errors.items).toHaveLength(0);
  }, 40_000);

  it('cancels a running import and marks the batch canceled', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < 3000; index += 1) {
      files[`Cancel${index}/main.cpp`] = encode(AC_SOURCE);
    }
    const uploaded = await uploadStreamed(files);
    const batchId = await startAsyncRun(uploaded.uploadId);

    const canceled = await app.inject({
      method: 'POST',
      url: `/api/admin/batch/${batchId}/cancel`,
    });
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect((canceled.json() as { data: { status: string } }).data.status).toBe('canceled');

    const body = await waitForStatus(batchId, ['canceled']);
    expect(body.status).toBe('canceled');
  }, 60_000);
});

describe('P1 startup recovery', () => {
  it('marks an import interrupted by a restart as failed', () => {
    const batchId = createBatchJob(db, {
      problemId,
      studentLevel: 1,
      mode: 'async',
      status: 'importing',
      uploadId: 'interrupted-upload',
    });
    const recovered = recoverInterruptedBatchImports(db);
    expect(recovered).toBeGreaterThanOrEqual(1);
    const job = getBatchJob(db, batchId)!;
    expect(job.status).toBe('failed');
    expect(job.meta_json).toContain('BATCH_IMPORT_INTERRUPTED');
  });
});
