import { ensureDataDirs, loadConfig, workerIsolationIssue } from './config.js';
import { ensureWorkerDataDirAcl, workerRunOptions } from './judge/worker.js';
import { openDatabase } from './storage/db.js';
import { migrate } from './storage/migrate.js';
import { createHub } from './realtime/hub.js';
import { ensureAdmin } from './services/bootstrap.js';
import { applyPendingRestore } from './services/system-ops.js';
import { recoverInterruptedJudgeTasks } from './storage/repos/judge.js';
import { recoverInterruptedBatchImports } from './services/batch-import.js';
import { startScheduler } from './judge/scheduler.js';
import { startBackupScheduler } from './services/backup-scheduler.js';
import { startLearningStatsScheduler } from './services/learning-stats-scheduler.js';
import { startContestClock } from './services/contest-clock.js';
import { buildApp } from './app.js';
import { join } from 'node:path';

const config = loadConfig();
// Fail closed at startup: required worker isolation must never degrade to
// running contestant code as the service account.
const workerIssue = workerIsolationIssue(config);
if (workerIssue) {
  console.error(`[security] ${workerIssue}`);
  process.exit(1);
}
ensureDataDirs(config.dataDir);
if (workerRunOptions(config)) {
  const aclError = ensureWorkerDataDirAcl(config);
  if (aclError) {
    console.warn(`[worker] could not apply the data-directory deny ACL: ${aclError}`);
    if (config.workerIsolation === 'required') {
      console.error('[security] worker isolation required but the data-directory ACL failed');
      process.exit(1);
    }
  }
}

const parentPort = (
  process as unknown as {
    parentPort?: { postMessage(value: unknown): void };
  }
).parentPort;
// In Electron the password is delivered only through the ready IPC message and
// shown in a native dialog. Writing it to stdout would put it in desktop.log.
const embedded = parentPort !== undefined;

// Apply a staged restore before the database is opened: replacing the SQLite
// file while a handle exists is unsafe, and a failure must abort startup rather
// than continue against half-restored data. The pending marker is kept on
// failure, so the next start retries.
try {
  const restore = applyPendingRestore(config);
  if (restore.restored) {
    console.log(
      `[restore] restored backup ${restore.backupId} (pre-restore snapshot: ${restore.preRestoreId})`,
    );
  }
} catch (error) {
  console.error(
    `[restore] 恢复失败，已中止启动：${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

const db = openDatabase(join(config.dataDir, 'db', 'oijudge.db'));
migrate(db);
// The bootstrap password is shown exactly once. Electron receives the same
// record in the `ready` message and displays it in a dialog; a CLI deployment
// only sees this banner (and the server log).
const initialAdmin = ensureAdmin(db, config);
if (!embedded && initialAdmin?.reason === 'created' && initialAdmin.password) {
  console.warn('');
  console.warn('============================================================');
  console.warn(' OiJudge 首次启动已生成管理员账号（密码只显示这一次）');
  console.warn(` 用户名: ${initialAdmin.username}`);
  console.warn(` 初始密码: ${initialAdmin.password}`);
  console.warn(' 首次登录后必须立即修改密码。');
  console.warn('============================================================');
  console.warn('');
} else if (!embedded && initialAdmin?.reason === 'legacy-default') {
  console.warn(
    `[security] 管理员 ${initialAdmin.username} 仍在使用默认密码 admin123；` +
      '已强制要求下次登录时修改密码。',
  );
}

const hub = createHub();
const app = await buildApp({ db, config, hub, logger: true });
const recoveredTasks = recoverInterruptedJudgeTasks(db);
if (recoveredTasks > 0) {
  app.log.info({ recoveredTasks }, 'requeued interrupted judge tasks');
}
// Async batch imports resume after a restart: recorded batch_items are final
// and the importer continues with the remaining sources of the same upload.
const resumedImports = recoverInterruptedBatchImports(db, { config });
if (resumedImports > 0) {
  app.log.info({ resumedImports }, 'resuming interrupted batch imports');
}
const scheduler = startScheduler({ db, config, events: hub });
// Automatic backups run on their own timer (initial delay + hourly check), so
// they do not share timers or state with the judge scheduler.
const backupScheduler = startBackupScheduler({
  db,
  config,
  onError: (error) => app.log.warn({ err: error }, '自动备份失败'),
  onSlow: (elapsedMs) => app.log.warn({ elapsedMs }, '自动备份阻塞事件循环时间过长'),
  onRun: (result) => {
    if (result.created) {
      app.log.info({ id: result.id, pruned: result.pruned }, '已创建自动备份');
    }
  },
});
// Learning analytics caches are derived data: rebuild them shortly after boot
// and every few hours, independent of the judge and backup timers.
const statsScheduler = startLearningStatsScheduler({
  db,
  onError: (error) => app.log.warn({ err: error }, '学习统计定时重建失败'),
  onSlow: (elapsedMs) => app.log.warn({ elapsedMs }, '学习统计重建阻塞事件循环时间过长'),
  onRun: (result) => app.log.info(result, '已完成学习统计定时重建'),
});
const contestClock = startContestClock(db);
const port = config.port;
const host = config.host;
await app.listen({ port, host });

const address = app.server.address();
const actualPort = typeof address === 'object' && address ? address.port : port;
app.log.info({ port: actualPort, host, dataDir: config.dataDir }, 'ojserver listening');

parentPort?.postMessage({
  type: 'ready',
  port: actualPort,
  host,
  ...(initialAdmin ? { initialAdmin } : {}),
});

async function shutdown() {
  backupScheduler.stop();
  statsScheduler.stop();
  contestClock.stop();
  await scheduler.stop();
  await app.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
