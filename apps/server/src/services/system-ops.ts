// System diagnostics and data backups (System Ops v1.1).
//
// Diagnostics must never throw: a missing compiler or runner is reported as a
// warn/fail check so the admin page can render it instead of returning a 500.
// Backups are plain directory copies (no archive dependency): the SQLite file
// is checkpointed first, then copied together with the user data directories.
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';

export interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface DiagnosticsReport {
  ok: boolean;
  generatedAt: number;
  checks: DiagnosticCheck[];
  queue: { queued: number; running: number; failed: number };
}

export interface BackupEntry {
  id: string;
  path: string;
  createdAt: number;
  sizeBytes: number;
  manifest: Record<string, unknown>;
}

/** Below this free space the disk check only warns; it never blocks judging. */
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

const BACKUP_DIR_NAME = 'backups';
const DATABASE_FILE_NAME = 'oijudge.db';
/** User data directories copied into every backup, in addition to the database. */
const BACKUP_DATA_DIRS = ['problems', 'submissions', 'plugins', 'hacks'] as const;
const COMPILER_TIMEOUT_MS = 2_000;

interface BackupFileEntry {
  path: string;
  kind: 'file' | 'dir';
  sizeBytes: number;
}

/**
 * Runs one diagnostic and converts an unexpected exception into a warn check.
 * Individual checks report `fail` explicitly; nothing escapes as an exception.
 */
function check(
  name: string,
  probe: () => { status: DiagnosticCheck['status']; detail: string },
): DiagnosticCheck {
  try {
    return { name, ...probe() };
  } catch (error) {
    return { name, status: 'warn', detail: `检查执行失败：${describeError(error)}` };
  }
}

function checkDatabase(db: DatabaseSync): DiagnosticCheck {
  return check('db.integrity', () => {
    const row = db.prepare('PRAGMA integrity_check').get() as unknown as
      | { integrity_check?: string }
      | undefined;
    const result = row?.integrity_check ?? 'unknown';
    return result === 'ok'
      ? { status: 'pass', detail: '数据库完整性检查通过' }
      : { status: 'fail', detail: `数据库完整性检查失败：${result}` };
  });
}

function checkDataDir(dataRoot: string): DiagnosticCheck {
  return check('dataDir.writable', () => {
    if (!existsSync(dataRoot)) {
      return { status: 'fail', detail: `数据目录不存在：${dataRoot}` };
    }
    try {
      accessSync(dataRoot, constants.W_OK);
      // W_OK alone is unreliable on Windows, so prove writability with a probe file.
      const probe = join(dataRoot, `.diagnostics-${process.pid}.tmp`);
      try {
        writeFileSync(probe, '');
      } finally {
        rmSync(probe, { force: true });
      }
    } catch (error) {
      return { status: 'fail', detail: `数据目录不可写：${dataRoot}（${describeError(error)}）` };
    }
    return { status: 'pass', detail: `数据目录可写：${dataRoot}` };
  });
}

function checkRunner(
  name: string,
  runnerPath: string,
  missingStatus: DiagnosticCheck['status'],
): DiagnosticCheck {
  return check(name, () => {
    const absolute = isAbsolute(runnerPath) ? runnerPath : resolve(runnerPath);
    return existsSync(absolute)
      ? { status: 'pass', detail: `运行器可用：${absolute}` }
      : { status: missingStatus, detail: `运行器不存在：${absolute}` };
  });
}

function checkCompiler(compilerPath: string): DiagnosticCheck {
  return check('gxx.version', () => {
    let output: string;
    try {
      output = execFileSync(compilerPath, ['--version'], {
        timeout: COMPILER_TIMEOUT_MS,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      return {
        status: 'warn',
        detail: `编译器不可用（${compilerPath}）：${describeError(error)}`,
      };
    }
    const version = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
    return {
      status: 'pass',
      detail: version.length > 0 ? version : `编译器可用：${compilerPath}`,
    };
  });
}

function checkDisk(dataRoot: string): DiagnosticCheck {
  return check('disk.free', () => {
    let stats: ReturnType<typeof statfsSync>;
    try {
      stats = statfsSync(dataRoot);
    } catch (error) {
      return { status: 'warn', detail: `无法读取磁盘空间：${describeError(error)}` };
    }
    const freeBytes = Number(stats.bsize) * Number(stats.bavail);
    return freeBytes >= MIN_FREE_BYTES
      ? { status: 'pass', detail: `磁盘剩余空间 ${formatBytes(freeBytes)}` }
      : {
          status: 'warn',
          detail: `磁盘剩余空间偏低：${formatBytes(freeBytes)}（建议至少 2 GB）`,
        };
  });
}

function checkMemory(): DiagnosticCheck {
  return check('memory', () => {
    const usage = process.memoryUsage();
    return {
      status: 'pass',
      detail: `堆内存 ${formatBytes(usage.heapUsed)} · 常驻内存 ${formatBytes(usage.rss)}`,
    };
  });
}

/**
 * Counts judge tasks by queue state. `compiling` tasks already occupy a worker,
 * so they are reported together with `running` ones.
 */
function countQueue(db: DatabaseSync): DiagnosticsReport['queue'] {
  const counts = { queued: 0, running: 0, failed: 0 };
  try {
    const rows = db
      .prepare('SELECT status, COUNT(*) AS n FROM judge_tasks GROUP BY status')
      .all() as unknown as Array<{ status: string; n: number }>;
    for (const row of rows) {
      const count = Number(row.n);
      if (row.status === 'queued') counts.queued += count;
      else if (row.status === 'running' || row.status === 'compiling') counts.running += count;
      else if (row.status === 'failed') counts.failed += count;
    }
  } catch {
    // A missing table must not break the whole diagnostics report.
  }
  return counts;
}

export function getDiagnostics(
  db: DatabaseSync,
  config: Config,
  now: number = Date.now(),
): DiagnosticsReport {
  const dataRoot = resolve(config.dataDir);
  const queue = countQueue(db);
  const checks: DiagnosticCheck[] = [
    checkDatabase(db),
    checkDataDir(dataRoot),
    checkRunner('runner.ojrunner', config.runnerPath, 'fail'),
    checkRunner('runner.ojinteract', config.interactRunnerPath, 'warn'),
    checkCompiler(config.gxx),
    checkDisk(dataRoot),
    checkMemory(),
    {
      name: 'queue',
      status: 'pass',
      detail: `排队 ${queue.queued} · 运行中 ${queue.running} · 失败 ${queue.failed}`,
    },
  ];
  return {
    ok: checks.every((entry) => entry.status !== 'fail'),
    generatedAt: now,
    checks,
    queue,
  };
}

export function createBackup(
  db: DatabaseSync,
  config: Config,
  now: number = Date.now(),
): BackupEntry {
  const dataRoot = resolve(config.dataDir);
  const databaseFile = join(dataRoot, 'db', DATABASE_FILE_NAME);
  if (!existsSync(databaseFile)) {
    throw new Error(`数据库文件不存在：${databaseFile}`);
  }
  // Flush the write-ahead log into the main file so the copy is a complete database.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  const backupsRoot = join(dataRoot, BACKUP_DIR_NAME);
  mkdirSync(backupsRoot, { recursive: true });
  const id = nextBackupId(backupsRoot, now);
  const backupDir = join(backupsRoot, id);
  mkdirSync(backupDir);

  try {
    const entries: BackupFileEntry[] = [];

    mkdirSync(join(backupDir, 'db'), { recursive: true });
    copyFileSync(databaseFile, join(backupDir, 'db', DATABASE_FILE_NAME));
    entries.push({
      path: `db/${DATABASE_FILE_NAME}`,
      kind: 'file',
      sizeBytes: statSync(join(backupDir, 'db', DATABASE_FILE_NAME)).size,
    });

    for (const name of BACKUP_DATA_DIRS) {
      const source = join(dataRoot, name);
      if (!existsSync(source)) continue;
      const target = join(backupDir, name);
      cpSync(source, target, { recursive: true });
      entries.push({ path: name, kind: 'dir', sizeBytes: directorySize(target) });
    }

    const manifest = {
      id,
      createdAt: now,
      version: appVersion(),
      source: dataRoot,
      entries,
      totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    };
    writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    return {
      id,
      path: backupDir,
      createdAt: now,
      sizeBytes: directorySize(backupDir),
      manifest: manifest as unknown as Record<string, unknown>,
    };
  } catch (error) {
    // Fail closed: never leave a half-written backup that could be restored later.
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
}

export function listBackups(config: Config): BackupEntry[] {
  const backupsRoot = join(resolve(config.dataDir), BACKUP_DIR_NAME);
  if (!existsSync(backupsRoot)) return [];
  const entries: BackupEntry[] = [];
  for (const dirent of readdirSync(backupsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const backupDir = join(backupsRoot, dirent.name);
    const manifestPath = join(backupDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      const createdAt =
        typeof manifest.createdAt === 'number'
          ? manifest.createdAt
          : statSync(manifestPath).mtimeMs;
      entries.push({
        id: typeof manifest.id === 'string' ? manifest.id : dirent.name,
        path: backupDir,
        createdAt,
        sizeBytes: directorySize(backupDir),
        manifest,
      });
    } catch {
      // A directory without a readable manifest is not a backup; skip it.
    }
  }
  entries.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  return entries;
}

/** Builds a filesystem-safe, sortable backup id; disambiguates same-millisecond runs. */
function nextBackupId(backupsRoot: string, now: number): string {
  const base = new Date(now).toISOString().replace(/[:.]/g, '-');
  let candidate = base;
  for (let suffix = 2; existsSync(join(backupsRoot, candidate)); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  return candidate;
}

function directorySize(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) total += directorySize(child);
    else if (entry.isFile()) total += statSync(child).size;
  }
  return total;
}

function appVersion(): string {
  const candidates = [
    join(process.cwd(), 'package.json'),
    join(process.cwd(), 'apps', 'server', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) return pkg.version;
    } catch {
      // Try the next location.
    }
  }
  return 'unknown';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
