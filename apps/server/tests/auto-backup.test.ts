import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { startBackupScheduler } from '../src/services/backup-scheduler.js';
import {
  AUTO_BACKUP_KEEP,
  createBackup,
  listBackups,
  runAutoBackup,
  verifyBackup,
  type BackupEntry,
} from '../src/services/system-ops.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

interface TestContext {
  dir: string;
  config: Config;
  db: ReturnType<typeof openDatabase>;
}

let context: TestContext | null = null;

function setup(): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'oij-auto-backup-'));
  ensureDataDirs(dir);
  const config = loadConfig({ ...process.env, OIJ_DATA_DIR: dir });
  const db = openDatabase(join(dir, 'db', 'oijudge.db'));
  migrate(db);
  context = { dir, config, db };
  return context;
}

afterEach(() => {
  if (!context) return;
  context.db.close();
  rmSync(context.dir, { recursive: true, force: true });
  context = null;
});

function automaticBackups(config: Config): BackupEntry[] {
  return listBackups(config).filter((entry) => entry.kind === 'auto');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('等待条件超时');
}

describe('runAutoBackup', () => {
  it('skips when the newest automatic backup is less than 24 hours old', () => {
    const { config, db } = setup();
    const first = createBackup(db, config, NOW - DAY + 1_000, 'auto');

    const result = runAutoBackup(db, config, NOW);

    expect(result).toEqual({ created: false, skipped: true, pruned: 0 });
    expect(automaticBackups(config).map((entry) => entry.id)).toEqual([first.id]);
  });

  it('creates a verified automatic backup once 24 hours have passed', () => {
    const { config, db } = setup();
    // Exactly 24 hours ago is old enough: the threshold is "younger than 24h".
    createBackup(db, config, NOW - DAY, 'auto');

    const result = runAutoBackup(db, config, NOW);

    expect(result.created).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.pruned).toBe(0);
    expect(result.id).toBeTruthy();

    const created = listBackups(config).find((entry) => entry.id === result.id);
    expect(created).toBeDefined();
    expect(created?.kind).toBe('auto');
    expect(existsSync(join(created!.path, 'db', 'oijudge.db'))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(created!.path, 'manifest.json'), 'utf8'),
    ) as { kind: string; createdAt: number };
    expect(manifest.kind).toBe('auto');
    expect(manifest.createdAt).toBe(NOW);
  });

  it('keeps only the newest 7 automatic backups and never prunes manual/pre-restore ones', () => {
    const { config, db } = setup();
    const oldAutomatic: BackupEntry[] = [];
    for (let days = 8; days >= 1; days -= 1) {
      oldAutomatic.push(createBackup(db, config, NOW - days * DAY, 'auto'));
    }
    const manual = createBackup(db, config, NOW - 30 * DAY, 'manual');
    const preRestore = createBackup(db, config, NOW - 31 * DAY, 'pre-restore');

    const result = runAutoBackup(db, config, NOW);

    expect(result.created).toBe(true);
    expect(result.pruned).toBe(2);
    const remaining = automaticBackups(config);
    expect(remaining).toHaveLength(AUTO_BACKUP_KEEP);
    const remainingIds = remaining.map((entry) => entry.id);
    // The two oldest automatic backups are gone...
    expect(remainingIds).not.toContain(oldAutomatic[0].id);
    expect(remainingIds).not.toContain(oldAutomatic[1].id);
    // ...and every newer one survives.
    for (const entry of oldAutomatic.slice(2)) {
      expect(remainingIds).toContain(entry.id);
    }
    // Retention only ever considers automatic backups.
    expect(existsSync(manual.path)).toBe(true);
    expect(existsSync(preRestore.path)).toBe(true);
  });

  it('does not delete older backups when the new backup fails verification', () => {
    const { config, db } = setup();
    const existing: BackupEntry[] = [];
    for (let days = 8; days >= 1; days -= 1) {
      existing.push(createBackup(db, config, NOW - days * DAY, 'auto'));
    }

    expect(() =>
      runAutoBackup(db, config, NOW, {
        verify: () => {
          throw new Error('verify failed');
        },
      }),
    ).toThrow('verify failed');

    // The new backup was created, but pruning must not run after a failed check.
    expect(automaticBackups(config)).toHaveLength(existing.length + 1);
    for (const entry of existing) {
      expect(existsSync(entry.path)).toBe(true);
    }
  });
});

describe('verifyBackup', () => {
  it('rejects a backup whose database file is missing and leaves it on disk', () => {
    const { config, db } = setup();
    const entry = createBackup(db, config, NOW, 'auto');
    rmSync(join(entry.path, 'db', 'oijudge.db'));

    expect(() => verifyBackup(entry)).toThrow(/数据库文件/);
    expect(existsSync(entry.path)).toBe(true);
  });
});

describe('startBackupScheduler', () => {
  it('creates a backup after the initial delay and stops cleanly', async () => {
    const { config, db } = setup();
    const errors: unknown[] = [];
    const handle = startBackupScheduler({
      db,
      config,
      // Also proves the env timings are honoured.
      env: { OIJ_BACKUP_INITIAL_DELAY_MS: '5', OIJ_BACKUP_INTERVAL_MS: '20' },
      onError: (error) => errors.push(error),
    });
    expect(handle.enabled).toBe(true);

    try {
      await waitFor(() => automaticBackups(config).length > 0);
      expect(automaticBackups(config)).toHaveLength(1);
      expect(errors).toEqual([]);
    } finally {
      handle.stop();
    }

    const afterStop = automaticBackups(config).length;
    await delay(150);
    expect(automaticBackups(config)).toHaveLength(afterStop);
  });

  it('does not run when OIJ_AUTO_BACKUP=0', async () => {
    const { config, db } = setup();
    const handle = startBackupScheduler({
      db,
      config,
      initialDelayMs: 1,
      intervalMs: 5,
      env: { OIJ_AUTO_BACKUP: '0' },
    });
    expect(handle.enabled).toBe(false);

    await delay(80);
    handle.stop();

    expect(automaticBackups(config)).toHaveLength(0);
  });

  it('logs failures instead of throwing and keeps ticking', async () => {
    const { config, db, dir } = setup();
    const brokenConfig: Config = { ...config, dataDir: join(dir, 'missing-data-dir') };
    const errors: unknown[] = [];
    const handle = startBackupScheduler({
      db,
      config: brokenConfig,
      initialDelayMs: 1,
      intervalMs: 20,
      env: {},
      onError: (error) => errors.push(error),
    });

    try {
      await waitFor(() => errors.length > 0);
      expect(errors[0]).toBeInstanceOf(Error);
      // A failure must not stop later ticks either.
      await waitFor(() => errors.length > 1);
    } finally {
      handle.stop();
    }
  });
});
