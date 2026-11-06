import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';
import {
  createBackup,
  getDiagnostics,
  listBackups,
  type BackupEntry,
} from '../src/services/system-ops.js';

const NOW = 1_700_000_000_000;
const dataDir = mkdtempSync(join(tmpdir(), 'oij-system-ops-'));
ensureDataDirs(dataDir);
const db = openDatabase(join(dataDir, 'db', 'oijudge.db'));
const config = {
  ...loadConfig({ ...process.env, OIJ_DATA_DIR: dataDir }),
  dataDir,
  runnerPath: join(dataDir, 'bin', 'ojrunner.exe'),
  interactRunnerPath: join(dataDir, 'bin', 'ojinteract.exe'),
  // A path that cannot exist, so the compiler probe exercises the failure path.
  gxx: join(dataDir, 'bin', 'g++-does-not-exist.exe'),
};

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
let firstBackup: BackupEntry;
let secondBackup: BackupEntry;

beforeAll(async () => {
  migrate(db);
  db.prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)').run(
    1,
    'queued',
    NOW,
  );
  db.prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)').run(
    2,
    'running',
    NOW,
  );
  db.prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)').run(
    3,
    'compiling',
    NOW,
  );
  db.prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)').run(
    4,
    'failed',
    NOW,
  );
  db.prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)').run(
    5,
    'done',
    NOW,
  );

  mkdirSync(join(dataDir, 'bin'), { recursive: true });
  writeFileSync(join(dataDir, 'bin', 'ojrunner.exe'), 'stub');
  writeFileSync(join(dataDir, 'bin', 'ojinteract.exe'), 'stub');
  mkdirSync(join(dataDir, 'problems', '1', 'data'), { recursive: true });
  writeFileSync(join(dataDir, 'problems', '1', 'data', '1.in'), '1 2\n');
  writeFileSync(join(dataDir, 'submissions', 'a.cpp'), 'int main() {}\n');

  const adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('getDiagnostics', () => {
  it('reports integrity, data dir, runners, compiler, queue and memory checks', () => {
    const report = getDiagnostics(db, config, NOW);
    expect(report.generatedAt).toBe(NOW);

    const names = report.checks.map((check) => check.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'db.integrity',
        'dataDir.writable',
        'runner.ojrunner',
        'runner.ojinteract',
        'gxx.version',
        'disk.free',
        'memory',
        'queue',
      ]),
    );
    for (const check of report.checks) {
      expect(['pass', 'warn', 'fail']).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(0);
    }

    expect(report.queue).toEqual({ queued: 1, running: 2, failed: 1 });
    const queueCheck = report.checks.find((check) => check.name === 'queue');
    expect(queueCheck?.detail).toContain('1');
  });

  it('turns a missing compiler into a warn instead of throwing', () => {
    const report = getDiagnostics(db, config, NOW);
    const gxx = report.checks.find((check) => check.name === 'gxx.version');
    expect(gxx?.status).toBe('warn');
    // A missing compiler is a warning, not a hard failure: the rest is healthy.
    expect(report.ok).toBe(true);
  });

  it('turns missing runners into failed checks instead of throwing', () => {
    const brokenConfig = {
      ...config,
      runnerPath: join(dataDir, 'bin', 'missing-ojrunner.exe'),
      interactRunnerPath: join(dataDir, 'bin', 'missing-ojinteract.exe'),
    };
    const report = getDiagnostics(db, brokenConfig, NOW);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'runner.ojrunner')?.status).toBe('fail');
    expect(report.checks.find((check) => check.name === 'runner.ojinteract')?.status).toBe('warn');
  });

  it('fails the data dir check when the directory is missing', () => {
    const report = getDiagnostics(db, { ...config, dataDir: join(dataDir, 'missing') }, NOW);
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.name === 'dataDir.writable')?.status).toBe('fail');
  });
});

describe('createBackup', () => {
  it('writes a manifest and copies the database and problem data', () => {
    firstBackup = createBackup(db, config, NOW);

    expect(firstBackup.createdAt).toBe(NOW);
    expect(firstBackup.kind).toBe('manual');
    expect(firstBackup.id).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
    expect(firstBackup.sizeBytes).toBeGreaterThan(0);
    expect(existsSync(join(firstBackup.path, 'manifest.json'))).toBe(true);

    const manifest = JSON.parse(
      readFileSync(join(firstBackup.path, 'manifest.json'), 'utf8'),
    ) as { createdAt: number; kind: string; version: string; entries: Array<{ path: string }> };
    expect(manifest.createdAt).toBe(NOW);
    expect(manifest.kind).toBe('manual');
    expect(typeof manifest.version).toBe('string');
    expect(manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['db/oijudge.db', 'problems', 'submissions']),
    );

    const sourceDb = join(dataDir, 'db', 'oijudge.db');
    const copiedDb = join(firstBackup.path, 'db', 'oijudge.db');
    expect(readFileSync(copiedDb).equals(readFileSync(sourceDb))).toBe(true);
    expect(readFileSync(join(firstBackup.path, 'problems', '1', 'data', '1.in'), 'utf8')).toBe(
      '1 2\n',
    );
    expect(readFileSync(join(firstBackup.path, 'submissions', 'a.cpp'), 'utf8')).toBe(
      'int main() {}\n',
    );
    // The backups directory itself must never be copied into a backup.
    expect(existsSync(join(firstBackup.path, 'backups'))).toBe(false);
  });
});

describe('listBackups', () => {
  it('returns created backups newest first', () => {
    secondBackup = createBackup(db, config, NOW + 5_000);
    const backups = listBackups(config);
    expect(backups).toHaveLength(2);
    expect(backups[0].id).toBe(secondBackup.id);
    expect(backups[1].id).toBe(firstBackup.id);
    expect(backups[0].createdAt).toBe(NOW + 5_000);
    expect(backups[0].sizeBytes).toBeGreaterThan(0);
    expect(backups[0].manifest.createdAt).toBe(NOW + 5_000);
  });
});

describe('system admin routes', () => {
  it('requires an admin session', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: '/api/admin/system/diagnostics',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('serves diagnostics and creates backups for admins', async () => {
    const diagnostics = await app.inject({
      method: 'GET',
      url: '/api/admin/system/diagnostics',
      headers: { cookie },
    });
    expect(diagnostics.statusCode, diagnostics.body).toBe(200);
    const report = (diagnostics.json() as { data: { checks: unknown[] } }).data;
    expect(report.checks.length).toBeGreaterThan(0);

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/system/backups',
      headers: { cookie },
    });
    expect(created.statusCode, created.body).toBe(201);
    const entry = (created.json() as { data: BackupEntry }).data;
    expect(existsSync(join(entry.path, 'manifest.json'))).toBe(true);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/admin/system/backups',
      headers: { cookie },
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const rows = (listed.json() as { data: BackupEntry[] }).data;
    const ids = rows.map((row) => row.id);
    expect(ids).toContain(entry.id);
    expect(ids).toContain(firstBackup.id);
    expect(ids).toContain(secondBackup.id);
  });
});
