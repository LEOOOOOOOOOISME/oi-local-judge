import { join } from 'node:path';
import { ensureDataDirs, loadConfig } from '../../apps/server/src/config.js';
import { ensureAdmin } from '../../apps/server/src/services/bootstrap.js';
import { importProblemDirectory } from '../../apps/server/src/services/problems.js';
import { createContest } from '../../apps/server/src/storage/repos/contests.js';
import { listProblems } from '../../apps/server/src/storage/repos/problems.js';
import { openDatabase } from '../../apps/server/src/storage/db.js';
import { migrate } from '../../apps/server/src/storage/migrate.js';

const config = loadConfig();
ensureDataDirs(config.dataDir);
const db = openDatabase(join(config.dataDir, 'db', 'oijudge.db'));
migrate(db);

const adminId = ensureAdmin(db, config);
let problems = listProblems(db);
let problemId: number;
if (problems.length === 0) {
  problemId = importProblemDirectory({
    db,
    config,
    sourceDir: join(process.cwd(), 'tools/seed/sample-problem'),
  });
  problems = listProblems(db);
} else {
  problemId = problems[0].id;
}

const existingContests = db.prepare('SELECT COUNT(*) AS n FROM contests').get() as unknown as {
  n: number;
};
let contestId: number | null = null;
if (existingContests.n === 0) {
  contestId = createContest(db, {
    name: '演示赛',
    mode: 'oi',
    startAt: Date.now() - 60_000,
    endAt: Date.now() + 7 * 24 * 3600_000,
    problemIds: [problemId],
  });
  db.prepare(
    "INSERT OR IGNORE INTO contest_participants(contest_id, user_id) SELECT ?, id FROM users",
  ).run(contestId);
}

console.log(
  JSON.stringify(
    {
      dataDir: config.dataDir,
      admin: config.adminUsername,
      adminCreated: adminId !== null,
      problemId,
      contestId,
    },
    null,
    2,
  ),
);
db.close();
