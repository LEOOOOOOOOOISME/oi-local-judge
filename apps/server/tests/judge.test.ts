import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TestResultDto } from '@oij/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { detectGxx, ensureDataDirs, loadConfig } from '../src/config.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import { startScheduler } from '../src/judge/scheduler.js';
import { aggregateSubtask } from '../src/judge/subtask.js';
import { openDatabase } from '../src/storage/db.js';
import { createJudgeTask } from '../src/storage/repos/judge.js';
import { createProblem } from '../src/storage/repos/problems.js';
import {
  createSubmission,
  getSubmission,
  getTestResults,
} from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';

const repoRoot = process.cwd();
const WINLIBS_GXX =
  'C:\\Users\\leo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\\mingw64\\bin\\g++.exe';

function resolveGxx(): string {
  if (process.env.OIJ_GXX) return process.env.OIJ_GXX;
  if (existsSync(WINLIBS_GXX)) return WINLIBS_GXX;
  return detectGxx();
}

const AC_SOURCE = [
  '#include <cstdio>',
  'int main() {',
  '  int a = 0, b = 0;',
  '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
  '  std::printf("%d\\n", a + b);',
  '  return 0;',
  '}',
  '',
].join('\n');

const WA_SOURCE = [
  '#include <cstdio>',
  'int main() {',
  '  int a = 0, b = 0;',
  '  if (std::scanf("%d %d", &a, &b) != 2) return 1;',
  '  std::printf("%d\\n", a - b);',
  '  return 0;',
  '}',
  '',
].join('\n');

const TLE_SOURCE = [
  'int main() {',
  '  volatile unsigned long long counter = 0;',
  '  for (;;) counter = counter + 1;',
  '}',
  '',
].join('\n');

const CE_SOURCE = [
  '#include <cstdio>',
  'int main() { this is not valid C++; }',
  '',
].join('\n');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

function removeDirWithRetry(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // A terminated native process can keep its image locked for a moment.
      const buffer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buffer, 0, 0, 100);
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

// The native runner is spawned by the judge and cannot write to %TEMP% under the
// DSH workspace-write sandbox, so all scratch data lives inside the workspace
// (native/runner/out is git-ignored).
let dataDir = '';
let db: DatabaseSync;
let config: Config;
let problemId = 0;
let userId = 0;

function enqueue(source: string): number {
  const dir = mkdtempSync(join(dataDir, 'submissions', 'sub-'));
  const sourcePath = join(dir, 'main.cpp');
  writeFileSync(sourcePath, source);
  return createSubmission(db, {
    problemId,
    userId,
    language: 'cpp17',
    sourcePath,
    sourceHash: `test-${Date.now()}`,
  });
}

function enqueueTask(source: string): number {
  const submissionId = enqueue(source);
  createJudgeTask(db, submissionId);
  return submissionId;
}

beforeAll(() => {
  const runner = join(repoRoot, 'native/runner/out/ojrunner.exe');
  expect(existsSync(runner), 'build the runner first: node tools/build-runner.mjs').toBe(true);

  mkdirSync(join(repoRoot, 'native/runner/out'), { recursive: true });
  dataDir = mkdtempSync(join(repoRoot, 'native/runner/out/judge-test-'));
  ensureDataDirs(dataDir);

  db = openDatabase(join(dataDir, 'db', 'test.db'));
  migrate(db);

  config = {
    ...loadConfig(),
    dataDir,
    gxx: resolveGxx(),
    runnerPath: runner,
    judgeConcurrency: 2,
  };

  userId = createUser(db, { username: 'judge-tester', passwordHash: 'not-used' });

  const problemData = join(dataDir, 'problems', 'p1');
  mkdirSync(problemData, { recursive: true });
  writeFileSync(join(problemData, '1.in'), '1 2\n');
  writeFileSync(join(problemData, '1.out'), '3\n');
  writeFileSync(join(problemData, '2.in'), '2 3\n');
  writeFileSync(join(problemData, '2.out'), '5\n');

  // Relative testcase paths: the pipeline must resolve them against dataDir.
  problemId = createProblem(db, {
    title: 'A+B',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [
      { inputPath: 'problems/p1/1.in', outputPath: 'problems/p1/1.out', points: 50 },
      { inputPath: 'problems/p1/2.in', outputPath: 'problems/p1/2.out', points: 50 },
    ],
  });
}, 120000);

afterAll(() => {
  db?.close();
  if (dataDir) removeDirWithRetry(dataDir);
});

describe('judge pipeline', () => {
  it('judges an AC submission, writes results and cleans its temp dir', async () => {
    const submissionId = enqueue(AC_SOURCE);

    await judgeSubmission({ db, config, submissionId });

    const submission = getSubmission(db, submissionId);
    expect(submission?.status).toBe('finished');
    expect(submission?.verdict).toBe('AC');
    expect(submission?.score).toBe(100);
    expect(submission?.judged_at).not.toBeNull();
    expect(submission?.memory_kb).toBeGreaterThan(0);

    const results = getTestResults(db, submissionId);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.verdict)).toEqual(['AC', 'AC']);
    expect(results.map((result) => result.score)).toEqual([50, 50]);

    expect(readdirSync(join(dataDir, 'tmp'))).toEqual([]);
  }, 60000);

  it('scheduler judges queued WA, TLE and CE submissions', async () => {
    const waId = enqueueTask(WA_SOURCE);
    const tleId = enqueueTask(TLE_SOURCE);
    const ceId = enqueueTask(CE_SOURCE);
    const ids = [waId, tleId, ceId];
    const events: Array<{ type: string; data: unknown }> = [];

    const scheduler = startScheduler({
      db,
      config,
      events: { publish: (event) => events.push(event) },
    });

    try {
      await waitFor(
        () =>
          ids.every((id) => {
            const status = getSubmission(db, id)?.status;
            return status === 'finished' || status === 'failed';
          }),
        60000,
        'all submissions to finish',
      );
    } finally {
      await scheduler.stop();
    }

    // WA: both testcases wrong, score 0.
    const wa = getSubmission(db, waId);
    expect(wa?.status).toBe('finished');
    expect(wa?.verdict).toBe('WA');
    expect(wa?.score).toBe(0);
    const waResults = getTestResults(db, waId);
    expect(waResults).toHaveLength(2);
    expect(waResults.every((result) => result.verdict === 'WA')).toBe(true);

    // TLE: infinite loop killed by the wall clock / CPU budget on both tests.
    const tle = getSubmission(db, tleId);
    expect(tle?.status).toBe('finished');
    expect(tle?.verdict).toBe('TLE');
    expect(tle?.score).toBe(0);
    const tleResults = getTestResults(db, tleId);
    expect(tleResults).toHaveLength(2);
    expect(tleResults.every((result) => result.verdict === 'TLE')).toBe(true);

    // CE: compile failure, finished with CE and no testcase rows.
    const ce = getSubmission(db, ceId);
    expect(ce?.status).toBe('finished');
    expect(ce?.verdict).toBe('CE');
    expect(ce?.score).toBe(0);
    expect(getTestResults(db, ceId)).toHaveLength(0);

    // Scheduler bookkeeping: every claimed task is done.
    const tasks = db
      .prepare('SELECT submission_id, status FROM judge_tasks')
      .all() as unknown as Array<{ submission_id: number; status: string }>;
    for (const id of ids) {
      expect(tasks.find((task) => task.submission_id === id)?.status).toBe('done');
    }

    // One submission.updated event per finished submission.
    const updates = events.filter(
      (event) =>
        event.type === 'submission.updated' &&
        typeof event.data === 'object' &&
        event.data !== null &&
        ids.includes((event.data as { submissionId: number }).submissionId),
    );
    expect(updates).toHaveLength(3);

    // All judging temp dirs are gone.
    expect(readdirSync(join(dataDir, 'tmp'))).toEqual([]);
  }, 120000);

  it('aggregates subtask scores with min, sum and no-subtask rules', () => {
    const results: TestResultDto[] = [
      { testcaseId: 1, verdict: 'AC', timeMs: 5, memoryKb: 100, score: 50, message: '' },
      { testcaseId: 2, verdict: 'AC', timeMs: 5, memoryKb: 100, score: 50, message: '' },
      { testcaseId: 3, verdict: 'WA', timeMs: 5, memoryKb: 100, score: 0, message: 'diff' },
    ];

    expect(aggregateSubtask(results, [])).toBe(100);

    const easy = {
      id: 1,
      problem_id: problemId,
      name: 'easy',
      points: 100,
      aggregation: 'min',
      testcaseIds: [1, 2],
    };
    const hard = {
      id: 2,
      problem_id: problemId,
      name: 'hard',
      points: 50,
      aggregation: 'min',
      testcaseIds: [3],
    };
    expect(aggregateSubtask(results, [easy, hard])).toBe(100);

    expect(
      aggregateSubtask(results, [{ ...easy, aggregation: 'sum', testcaseIds: [1, 2, 3] }]),
    ).toBe(100);

    // Testcase 2 and 3 are ungrouped and still contribute directly.
    expect(aggregateSubtask(results, [{ ...easy, testcaseIds: [1] }])).toBe(150);
    // A subtask containing a failing testcase awards 0 under "min".
    expect(aggregateSubtask(results, [{ ...easy, testcaseIds: [1, 3] }])).toBe(50);
  });
});
