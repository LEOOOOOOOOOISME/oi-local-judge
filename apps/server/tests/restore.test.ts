import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';
import { createUser } from '../src/storage/repos/users.js';
import {
  RestoreError,
  applyPendingRestore,
  createBackup,
  requestRestore,
  type BackupEntry,
} from '../src/services/system-ops.js';

const T0 = 1_700_000_000_000;
const T1 = T0 + 60_000;

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oij-restore-'));
  ensureDataDirs(dir);
  return dir;
}

function makeConfig(dir: string): Config {
  return loadConfig({ OIJ_DATA_DIR: dir });
}

function markerPath(dir: string): string {
  return join(dir, 'restore', 'pending.json');
}

function countJudgeTasks(dir: string): number {
  const db = openDatabase(join(dir, 'db', 'oijudge.db'));
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM judge_tasks').get() as unknown as {
      n: number;
    };
    return Number(row.n);
  } finally {
    db.close();
  }
}

describe('requestRestore', () => {
  it('writes a pending marker and does not modify the database', () => {
    const dir = makeDataDir();
    const config = makeConfig(dir);
    const db = openDatabase(join(dir, 'db', 'oijudge.db'));
    try {
      migrate(db);
      const backup = createBackup(db, config, T0);

      const request = requestRestore(config, backup.id, T1);

      expect(request).toEqual({
        backupId: backup.id,
        requestedAt: T1,
        restartRequired: true,
      });
      const marker = markerPath(dir);
      expect(existsSync(marker)).toBe(true);
      expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual(request);
      // Requesting a restore must not replace the live database: the backup
      // directory is only read to verify the manifest.
      expect(existsSync(join(backup.path, 'manifest.json'))).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a backup id that could escape the backups directory', () => {
    const dir = makeDataDir();
    const config = makeConfig(dir);
    try {
      for (const badId of ['', '.', '..', '../escape', 'a/b', 'a\\b', 'with space', 'x'.repeat(129)]) {
        expect(() => requestRestore(config, badId, T1), `backupId ${JSON.stringify(badId)}`).toThrow(
          RestoreError,
        );
      }
      expect(existsSync(markerPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown backup id', () => {
    const dir = makeDataDir();
    const config = makeConfig(dir);
    try {
      expect(() => requestRestore(config, '2099-01-01T00-00-00-000Z', T1)).toThrow(RestoreError);
      expect(existsSync(markerPath(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applyPendingRestore', () => {
  it('returns restored:false when no marker is pending', () => {
    const dir = makeDataDir();
    const config = makeConfig(dir);
    try {
      expect(applyPendingRestore(config)).toEqual({ restored: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restores the database and problem data and keeps a pre-restore backup', () => {
    const dir = makeDataDir();
    const config = makeConfig(dir);
    const db = openDatabase(join(dir, 'db', 'oijudge.db'));
    let backup: BackupEntry;
    try {
      migrate(db);
      db.prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)').run(
        1,
        'done',
        T0,
      );
      mkdirSync(join(dir, 'problems', '1', 'data'), { recursive: true });
      writeFileSync(join(dir, 'problems', '1', 'data', '1.in'), '1 2\n');
      backup = createBackup(db, config, T0);

      // Mutate the live data after the backup was taken.
      db.prepare('INSERT INTO judge_tasks(submission_id, status, created_at) VALUES (?, ?, ?)').run(
        2,
        'done',
        T1,
      );
      writeFileSync(join(dir, 'problems', '1', 'data', '1.in'), '9 9\n');
      requestRestore(config, backup.id, T1);
    } finally {
      db.close();
    }

    // Simulate a stale WAL/SHM pair left by the pre-restore database.
    writeFileSync(join(dir, 'db', 'oijudge.db-wal'), 'stale-wal');
    writeFileSync(join(dir, 'db', 'oijudge.db-shm'), 'stale-shm');

    try {
      const result = applyPendingRestore(config);

      expect(result.restored).toBe(true);
      expect(result.backupId).toBe(backup.id);
      expect(result.preRestoreId).toMatch(/^pre-restore-/);

      // The marker is consumed only after a successful restore.
      expect(existsSync(markerPath(dir))).toBe(false);

      // The restored database is the backed-up snapshot, without the new row.
      expect(countJudgeTasks(dir)).toBe(1);
      expect(readFileSync(join(dir, 'problems', '1', 'data', '1.in'), 'utf8')).toBe('1 2\n');

      // Stale WAL/SHM files must never be replayed against the restored file.
      expect(existsSync(join(dir, 'db', 'oijudge.db-wal'))).toBe(false);
      expect(existsSync(join(dir, 'db', 'oijudge.db-shm'))).toBe(false);

      // The pre-restore backup captures the data that was live before the restore.
      const preRestoreDir = join(dir, 'backups', result.preRestoreId as string);
      expect(existsSync(join(preRestoreDir, 'db', 'oijudge.db'))).toBe(true);
      expect(readFileSync(join(preRestoreDir, 'problems', '1', 'data', '1.in'), 'utf8')).toBe(
        '9 9\n',
      );
      expect(existsSync(join(preRestoreDir, 'manifest.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the marker when the restore fails so it can be retried', () => {
    const dir = makeDataDir();
    const config = makeConfig(dir);
    const db = openDatabase(join(dir, 'db', 'oijudge.db'));
    let backup: BackupEntry;
    try {
      migrate(db);
      backup = createBackup(db, config, T0);
      requestRestore(config, backup.id, T1);
    } finally {
      db.close();
    }
    // Make the pending restore impossible: the backup disappears after the
    // request but the marker must survive for a later retry.
    rmSync(backup.path, { recursive: true, force: true });
    try {
      expect(() => applyPendingRestore(config)).toThrow(RestoreError);
      expect(existsSync(markerPath(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a tampered marker that points outside the backups directory', () => {
    const dir = makeDataDir();
    const config = makeConfig(dir);
    mkdirSync(join(dir, 'restore'), { recursive: true });
    writeFileSync(
      markerPath(dir),
      JSON.stringify({ backupId: '../outside', requestedAt: T1, restartRequired: true }),
      'utf8',
    );
    try {
      expect(() => applyPendingRestore(config)).toThrow(RestoreError);
      // A failed restore is never silently dropped: retry requires the marker.
      expect(existsSync(markerPath(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('admin restore route', () => {
  const dir = makeDataDir();
  const config = makeConfig(dir);
  const db = openDatabase(join(dir, 'db', 'oijudge.db'));
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = '';
  let backup: BackupEntry;

  beforeAll(async () => {
    migrate(db);
    const adminId = createUser(db, {
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      role: 'admin',
    });
    cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
    app = await buildApp({ db, config });
    backup = createBackup(db, config, T0);
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires an admin session', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/system/restore',
      payload: { backupId: backup.id, confirm: 'RESTORE' },
    });
    expect(response.statusCode).toBe(401);
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  it.each([
    ['missing confirm', { backupId: 'unused' }],
    ['wrong confirm', { backupId: 'unused', confirm: 'restore' }],
    ['whitespace confirm', { backupId: 'unused', confirm: 'RESTORE ' }],
  ])('rejects %s with 400 and writes no marker', async (_label, payload) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/system/restore',
      headers: { cookie },
      payload,
    });
    expect(response.statusCode, response.body).toBe(400);
    const body = response.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  it('returns 404 for an unknown backup', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/system/restore',
      headers: { cookie },
      payload: { backupId: '2099-01-01T00-00-00-000Z', confirm: 'RESTORE' },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  it('rejects a path-traversal backup id with 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/system/restore',
      headers: { cookie },
      payload: { backupId: '../../outside', confirm: 'RESTORE' },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(existsSync(markerPath(dir))).toBe(false);
  });

  it('accepts a valid request and returns restartRequired', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/admin/system/restore',
      headers: { cookie },
      payload: { backupId: backup.id, confirm: 'RESTORE' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json().data as {
      backupId: string;
      requestedAt: number;
      restartRequired: boolean;
    };
    expect(data).toMatchObject({ backupId: backup.id, restartRequired: true });
    expect(typeof data.requestedAt).toBe('number');
    expect(existsSync(markerPath(dir))).toBe(true);
    // The running database is untouched: restore only happens on next start.
    expect(countJudgeTasks(dir)).toBe(0);
  });
});
