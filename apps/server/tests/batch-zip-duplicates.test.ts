import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Zip, ZipPassThrough } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { registerAdminBatchRoutes } from '../src/http/admin-batch.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import {
  BatchZipError,
  extractZipEntries,
  scanZipStream,
} from '../src/services/batch-zip.js';
import { planBatchSources } from '../src/services/batch-plan.js';
import { createBatchUpload } from '../src/storage/repos/batch-uploads.js';
import { getBatchJob, listBatchItems } from '../src/storage/repos/batches.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createProblem } from '../src/storage/repos/problems.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

interface ZipEntry {
  name: string;
  data: string;
}

/** fflate's object-based zipSync cannot emit duplicate names; Zip can. */
function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  let error: Error | null = null;
  const zip = new Zip((err, chunk) => {
    if (err) {
      error = err;
      return;
    }
    chunks.push(Buffer.from(chunk));
  });
  for (const entry of entries) {
    const file = new ZipPassThrough(entry.name);
    zip.add(file);
    file.push(new TextEncoder().encode(entry.data), true);
  }
  zip.end();
  if (error) throw error;
  return Buffer.concat(chunks);
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oij-batch-zip-dup-'));
  dirs.push(dir);
  return dir;
}

function writeZip(entries: ZipEntry[]): string {
  const dir = tempDir();
  const path = join(dir, 'archive.zip');
  writeFileSync(path, buildZip(entries));
  return path;
}

describe('duplicate ZIP entry paths fail closed', () => {
  it('rejects an archive with two identical file entries', async () => {
    const zipPath = writeZip([
      { name: 'Alice/main.cpp', data: 'first' },
      { name: 'Bob/main.cpp', data: 'bob' },
      { name: 'Alice/main.cpp', data: 'second' },
    ]);
    await expect(scanZipStream(zipPath)).rejects.toMatchObject({
      name: 'BatchZipError',
      code: 'BATCH_DUPLICATE_PATH',
    });
    await expect(scanZipStream(zipPath)).rejects.toThrow(/duplicate zip entry path/i);
  });

  it('rejects entries that only collide after path normalization', async () => {
    const zipPath = writeZip([
      { name: 'Alice/main.cpp', data: 'first' },
      { name: './Alice/main.cpp', data: 'second' },
    ]);
    await expect(scanZipStream(zipPath)).rejects.toMatchObject({
      code: 'BATCH_DUPLICATE_PATH',
    });
  });

  it('rejects duplicates of non-source files too', async () => {
    const zipPath = writeZip([
      { name: 'Alice/main.cpp', data: 'ok' },
      { name: 'notes/readme.txt', data: 'one' },
      { name: 'notes/readme.txt', data: 'two' },
    ]);
    await expect(scanZipStream(zipPath)).rejects.toMatchObject({
      code: 'BATCH_DUPLICATE_PATH',
    });
  });

  it('extractZipEntries refuses to overwrite a wanted duplicate', async () => {
    const zipPath = writeZip([
      { name: 'Alice/main.cpp', data: 'first' },
      { name: 'Alice/main.cpp', data: 'second' },
    ]);
    await expect(
      extractZipEntries(zipPath, tempDir(), new Set(['Alice/main.cpp'])),
    ).rejects.toBeInstanceOf(BatchZipError);
    await expect(
      extractZipEntries(zipPath, tempDir(), new Set(['Alice/main.cpp'])),
    ).rejects.toMatchObject({ code: 'BATCH_DUPLICATE_PATH' });
  });

  it('allows duplicate directory entries (only files are path-collapsed)', async () => {
    const zipPath = writeZip([
      { name: 'Alice/', data: '' },
      { name: 'Alice/', data: '' },
      { name: 'Alice/main.cpp', data: 'ok' },
    ]);
    const scan = await scanZipStream(zipPath);
    expect(scan.files.map((entry) => entry.path)).toEqual(['Alice/main.cpp']);
  });

  it('planBatchSources keeps the first duplicate deterministically', () => {
    const plan = planBatchSources({
      files: [
        { path: 'Alice/main.cpp', rawPath: 'Alice/main.cpp', size: 5, directory: false },
        { path: 'Alice/main.cpp', rawPath: 'Alice/main.cpp', size: 99, directory: false },
      ],
      directories: [],
      studentLevel: 1,
      problemLevel: 0,
      singleProblemId: 7,
      maxSourceBytes: 1024,
      defaultLanguage: 'cpp17',
      unmapped: 'allow',
    });
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.size).toBe(5);
    expect(plan.duplicatePaths).toEqual(['Alice/main.cpp']);
  });
});

describe('preview and import reject duplicate ZIP entries consistently', () => {
  it('returns a clear preview error and fails the import with the same code', async () => {
    const root = tempDir();
    const db = openDatabase(join(root, 'test.db'));
    migrate(db);
    ensureDataDirs(root);
    const config: Config = {
      ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }),
      dataDir: root,
    };
    const problemId = createProblem(db, {
      title: 'P1',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [],
    });
    const uploadId = 'duplicate-entry-upload';
    const relativePath = `uploads/batch/${uploadId}.zip`;
    mkdirSync(join(root, 'uploads', 'batch'), { recursive: true });
    writeFileSync(
      join(root, relativePath),
      buildZip([
        { name: 'Alice/main.cpp', data: 'first' },
        { name: 'Alice/main.cpp', data: 'second' },
      ]),
    );
    createBatchUpload(db, {
      uploadId,
      zipPath: relativePath,
      sizeBytes: 100,
      sha256: 'sha',
    });
    const app: FastifyInstance = Fastify({ logger: false });
    registerAdminBatchRoutes(app, {
      db,
      config,
      adminGuard: async () => {},
      maxSourceBytes: 1024,
    });
    await app.ready();
    try {
      const preview = await app.inject({
        method: 'GET',
        url: `/api/admin/batch/uploads/${uploadId}/preview?studentLevel=1&problemLevel=0`,
      });
      expect(preview.statusCode, preview.body).toBe(400);
      expect((preview.json() as { error: { code: string } }).error.code).toBe(
        'BATCH_DUPLICATE_PATH',
      );

      const run = await app.inject({
        method: 'POST',
        url: `/api/admin/batch/uploads/${uploadId}/run`,
        payload: { studentLevel: 1, problemLevel: 0, problemId },
      });
      expect(run.statusCode, run.body).toBe(202);
      const jobId = (run.json() as { data: { jobId: number } }).data.jobId;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const job = getBatchJob(db, jobId);
        if (job && job.status !== 'importing' && job.phase !== 'uploaded') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const job = getBatchJob(db, jobId)!;
      expect(job.status).toBe('failed');
      expect(job.meta_json).toContain('BATCH_DUPLICATE_PATH');
      expect(listBatchItems(db, jobId)).toHaveLength(0);
    } finally {
      await app.close();
      db.close();
    }
  }, 30_000);
});
