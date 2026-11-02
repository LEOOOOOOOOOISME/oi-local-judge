import { ensureDataDirs, loadConfig } from './config.js';
import { openDatabase } from './storage/db.js';
import { migrate } from './storage/migrate.js';
import { createHub } from './realtime/hub.js';
import { ensureAdmin } from './services/bootstrap.js';
import { recoverInterruptedJudgeTasks } from './storage/repos/judge.js';
import { startScheduler } from './judge/scheduler.js';
import { startContestClock } from './services/contest-clock.js';
import { buildApp } from './app.js';
import { join } from 'node:path';

const config = loadConfig();
ensureDataDirs(config.dataDir);
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
