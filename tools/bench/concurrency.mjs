import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDataDirs, loadConfig } from '../../apps/server/src/config.ts';
import { startScheduler } from '../../apps/server/src/judge/scheduler.ts';
import { importProblemDirectory } from '../../apps/server/src/services/problems.ts';
import { submitSource } from '../../apps/server/src/services/submissions.ts';
import { createUser } from '../../apps/server/src/storage/repos/users.ts';
import { migrate } from '../../apps/server/src/storage/migrate.ts';
import { openDatabase } from '../../apps/server/src/storage/db.ts';

const SUBMISSIONS = Number(process.env.OIJ_BENCH_SUBMISSIONS ?? 50);
const CONCURRENCY = Number(process.env.OIJ_BENCH_CONCURRENCY ?? 2);
const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'bench-concurrency-'));
const db = openDatabase(join(root, 'bench.db'));
const config = {
  ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }),
  dataDir: root,
  judgeConcurrency: CONCURRENCY,
};
ensureDataDirs(root);
migrate(db);
const userId = createUser(db, { username: 'bench', passwordHash: 'x' });
const problemId = importProblemDirectory({
  db,
  config,
  sourceDir: join(process.cwd(), 'tools/seed/sample-problem'),
});
const code = '#include <iostream>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}';
const ids = [];
for (let i = 0; i < SUBMISSIONS; i++) {
  ids.push(submitSource({ db, config }, { userId, problemId, language: 'cpp17', code }).id);
}
const scheduler = startScheduler({ db, config, pollIntervalMs: 20 });
const startedAt = performance.now();
const deadline = Date.now() + 120_000;
for (;;) {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE id IN (" + ids.join(',') + ") AND status IN ('finished','failed')",
    )
    .get();
  if (Number(row.n) >= SUBMISSIONS) break;
  if (Date.now() > deadline) throw new Error('concurrency bench timed out');
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const totalMs = performance.now() - startedAt;
await scheduler.stop();
const verdicts = db
  .prepare('SELECT verdict, COUNT(*) AS n FROM submissions WHERE id IN (' + ids.join(',') + ') GROUP BY verdict')
  .all();
console.log(
  JSON.stringify(
    {
      submissions: SUBMISSIONS,
      concurrency: CONCURRENCY,
      totalMs: Math.round(totalMs * 100) / 100,
      perSubmissionMs: Math.round((totalMs / SUBMISSIONS) * 100) / 100,
      throughputPerSec: Math.round((SUBMISSIONS / (totalMs / 1000)) * 100) / 100,
      verdicts,
    },
    null,
    2,
  ),
);
db.close();
rmSync(root, { recursive: true, force: true });
