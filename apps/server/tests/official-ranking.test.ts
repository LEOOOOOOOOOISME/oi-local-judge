import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getOfficialRanking } from '../src/services/official-ranking.js';
import { createContest } from '../src/storage/repos/contests.js';
import { upsertOfficialScore } from '../src/storage/repos/official-scores.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'official-ranking-'));
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const problemId = createProblem(db, {
  title: 'Ranking Problem',
  type: 'standard',
  timeMs: 1000,
  memoryMb: 64,
  testcases: [],
});
const u1 = createUser(db, { username: 'alice', passwordHash: 'x', realName: 'Alice', className: '1班' });
const u2 = createUser(db, { username: 'bob', passwordHash: 'x', realName: 'Bob', className: '2班' });
const u3 = createUser(db, { username: 'carol', passwordHash: 'x', realName: 'Carol' });

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addSubmission(input: {
  contestId: number;
  userId: number;
  score: number;
  verdict: string;
  createdAt: number;
}) {
  const id = createSubmission(db, {
    contestId: input.contestId,
    problemId,
    userId: input.userId,
    language: 'cpp17',
    sourcePath: 'x.cpp',
    sourceHash: 'h',
  });
  db.prepare(
    'UPDATE submissions SET status = ?, verdict = ?, score = ?, created_at = ? WHERE id = ?',
  ).run('finished', input.verdict, input.score, input.createdAt, id);
}

describe('official ranking service', () => {
  it('merges official batch cells and hides hidden participants', () => {
    const contestId = createContest(db, {
      name: 'Official',
      mode: 'oi',
      problemIds: [problemId],
      startAt: 1000,
      endAt: 2000,
    });
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, u1);
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, u2);
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status, hidden_at) VALUES (?, ?, 'accepted', ?)",
    ).run(contestId, u3, Date.now());
    addSubmission({ contestId, userId: u2, score: 40, verdict: 'WA', createdAt: 1200 });
    upsertOfficialScore(db, {
      contestId,
      userId: u2,
      problemId,
      score: 100,
      verdict: 'AC',
      source: 'batch',
      batchId: 1,
    });

    const data = getOfficialRanking(db, contestId)!;
    expect(data.preset).toBe('oi');
    expect(data.rows.map((row) => row.userId)).toEqual([u2, u1]);
    expect(data.rows[0]).toMatchObject({ totalScore: 100, username: 'bob', className: '2班' });
    expect(data.rows[1]).toMatchObject({ totalScore: 0, username: 'alice' });
    expect(data.rows.some((row) => row.userId === u3)).toBe(false);
    expect(data.archived).toBe(false);
  });

  it('computes ACM ordering and archived status', () => {
    const contestId = createContest(db, {
      name: 'ACM',
      mode: 'acm',
      problemIds: [problemId],
      startAt: 0,
      endAt: 100 * 60_000,
    });
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, u1);
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, u2);
    addSubmission({ contestId, userId: u1, score: 100, verdict: 'AC', createdAt: 20 * 60_000 });
    addSubmission({ contestId, userId: u2, score: 100, verdict: 'AC', createdAt: 5 * 60_000 });
    addSubmission({ contestId, userId: u2, score: 0, verdict: 'WA', createdAt: 3 * 60_000 });
    db.prepare('UPDATE contests SET archived_at = ? WHERE id = ?').run(Date.now(), contestId);

    const data = getOfficialRanking(db, contestId)!;
    expect(data.preset).toBe('acm');
    expect(data.rows.map((row) => row.userId)).toEqual([u1, u2]);
    expect(data.rows[0].penalty).toBe(20);
    expect(data.rows[1].penalty).toBe(25);
    expect(data.archived).toBe(true);
  });
});
