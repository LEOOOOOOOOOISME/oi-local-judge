import { ensureDataDirs, loadConfig } from './config.js';
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
ensureDataDirs(config.dataDir);

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
ensureAdmin(db, config);

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

const parentPort = (
  process as unknown as {
    parentPort?: { postMessage(value: unknown): void };
  }
).parentPort;
parentPort?.postMessage({ type: 'ready', port: actualPort });

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
