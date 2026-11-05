import { ensureDataDirs, loadConfig } from './config.js';
import { openDatabase } from './storage/db.js';
import { migrate } from './storage/migrate.js';
import { createHub } from './realtime/hub.js';
import { ensureAdmin } from './services/bootstrap.js';
import { applyPendingRestore } from './services/system-ops.js';
import { recoverInterruptedJudgeTasks } from './storage/repos/judge.js';
import { startScheduler } from './judge/scheduler.js';
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
const scheduler = startScheduler({ db, config, events: hub });
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
  contestClock.stop();
  await scheduler.stop();
  await app.close();
  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
