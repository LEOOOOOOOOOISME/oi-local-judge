import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { startContestClock, tickContests } from '../src/services/contest-clock.js';
import { createContest, getContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { getOfficialScore } from '../src/storage/repos/official-scores.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-clock-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return { db };
}

it('starts a draft contest at start_at', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000 });
  tickContests(db, 999);
  expect(getContest(db, id)!.status).toBe('draft');
  tickContests(db, 1000);
  expect(getContest(db, id)!.status).toBe('running');
  db.close();
});

it('freezes and ends at the configured times', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000, freezeAt: 3000 });
  tickContests(db, 1000);
  expect(getContest(db, id)!.status).toBe('running');
  tickContests(db, 3000);
  expect(getContest(db, id)!.status).toBe('frozen');
  tickContests(db, 5000);
  expect(getContest(db, id)!.status).toBe('ended');
  db.close();
});

it('unfreezes at unfreeze_at', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000, freezeAt: 3000 });
  db.prepare('UPDATE contests SET unfreeze_at = 4000 WHERE id = ?').run(id);
  tickContests(db, 1000);
  expect(getContest(db, id)!.status).toBe('running');
  tickContests(db, 3000);
  expect(getContest(db, id)!.status).toBe('frozen');
  tickContests(db, 4000);
  expect(getContest(db, id)!.status).toBe('running');
  db.close();
});

it('does not reopen an ended contest', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000 });
  db.prepare("UPDATE contests SET status = 'ended' WHERE id = ?").run(id);
  tickContests(db, 6000);
  expect(getContest(db, id)!.status).toBe('ended');
  db.close();
});

it('publishes OI official scores when the clock ends a frozen contest', () => {
  const { db } = setup();
  const problemId = createProblem(db, {
    title: 'Clock OI',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  const contestId = createContest(db, {
    name: 'Clock OI',
    mode: 'oi',
    problemIds: [problemId],
    startAt: 1000,
    endAt: 5000,
    freezeAt: 3000,
  });
  db.prepare(
    "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, 42, 'accepted')",
  ).run(contestId);
  const submissionId = createSubmission(db, {
    contestId,
    problemId,
    userId: 42,
    language: 'cpp17',
    sourcePath: 'a.cpp',
    sourceHash: 'a',
  });
  db.prepare(
    "UPDATE submissions SET status='finished', phase='contest', verdict='AC', score=100, created_at=4000 WHERE id=?",
  ).run(submissionId);
  db.prepare("UPDATE contests SET status='running' WHERE id=?").run(contestId);

  tickContests(db, 5000);
  expect(getContest(db, contestId)!.status).toBe('ended');
  expect(getOfficialScore(db, contestId, 42, problemId)?.score).toBe(100);
  db.close();
});

it('returns a stoppable clock handle without touching contests immediately', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000 });
  const clock = startContestClock(db, { intervalMs: 60_000, now: () => 1000 });
  expect(typeof clock.stop).toBe('function');
  clock.stop();
  expect(getContest(db, id)!.status).toBe('draft');
  db.close();
});
