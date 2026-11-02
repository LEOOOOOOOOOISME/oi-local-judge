import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerContestRoutes } from '../src/http/contests.js';
import { getClassStats, getContestRanking } from '../src/services/contests.js';
import { createContest, addParticipant } from '../src/storage/repos/contests.js';
import { upsertOfficialScore } from '../src/storage/repos/official-scores.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-contests-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const app = Fastify();
  registerContestRoutes(app, { db });
  return { db, app, dir };
}

function addSubmission(
  db: ReturnType<typeof openDatabase>,
  contestId: number,
  problemId: number,
  userId: number,
  verdict: string,
  score: number,
  createdAt: number,
) {
  const id = createSubmission(db, {
    contestId,
    problemId,
    userId,
    language: 'cpp17',
    sourcePath: 'x.cpp',
    sourceHash: 'h',
  });
  db.prepare('UPDATE submissions SET verdict = ?, score = ?, created_at = ? WHERE id = ?').run(
    verdict,
    score,
    createdAt,
    id,
  );
  return id;
}

describe('contest ranking', () => {
  it('ranks OI contestants and freezes submissions after freeze_at', async () => {
    const { db, app } = setup();
    const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
    const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
    const p1 = createProblem(db, {
      title: 'P1',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
    });
    const p2 = createProblem(db, {
      title: 'P2',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [{ inputPath: '2.in', outputPath: '2.out', points: 100 }],
    });
    const contestId = createContest(db, {
      name: 'Test Contest',
      problemIds: [p1, p2],
      freezeAt: 1000,
    });
    addParticipant(db, contestId, alice);
    addParticipant(db, contestId, bob);

    addSubmission(db, contestId, p1, alice, 'AC', 100, 100);
    addSubmission(db, contestId, p2, alice, 'AC', 100, 200);
    addSubmission(db, contestId, p1, bob, 'AC', 100, 100);
    addSubmission(db, contestId, p2, bob, 'WA', 0, 900);
    // after freeze: bob's late AC must not count
    addSubmission(db, contestId, p2, bob, 'AC', 100, 1100);

    const ranking = getContestRanking(db, contestId)!;
    expect(ranking.rows[0].userId).toBe(alice);
    expect(ranking.rows[0].totalScore).toBe(200);
    expect(ranking.rows[1].totalScore).toBe(100);

    const res = await app.inject({ method: 'GET', url: `/api/contests/${contestId}/ranking` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ userId: number; username: string }> };
    expect(body.data[0].username).toBe('alice');
    db.close();
    await app.close();
  });

  it('computes class stats from the official ranking source', async () => {
    const { db, app, dir } = setup();
    const alice = createUser(db, {
      username: 'alice',
      passwordHash: 'x',
      className: '1班',
    });
    const bob = createUser(db, { username: 'bob', passwordHash: 'x', className: '2班' });
    const p1 = createProblem(db, {
      title: 'P1',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
    });
    const contestId = createContest(db, { name: 'Stats', mode: 'oi', problemIds: [p1] });
    addParticipant(db, contestId, alice);
    addParticipant(db, contestId, bob);
    // The online submission is worth 60, but the official (batch) score is 100.
    addSubmission(db, contestId, p1, alice, 'PC', 60, 100);
    upsertOfficialScore(db, {
      contestId,
      userId: alice,
      problemId: p1,
      score: 100,
      verdict: 'AC',
      source: 'batch',
      batchId: 1,
    });

    const rows = await getClassStats(db, contestId, dir);
    expect(rows).toEqual([
      {
        className: '1班',
        participants: 1,
        totalScore: 100,
        averageScore: 100,
        acParticipants: 1,
        bestRank: 1,
      },
      {
        className: '2班',
        participants: 1,
        totalScore: 0,
        averageScore: 0,
        acParticipants: 0,
        bestRank: 2,
      },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: `/api/admin/contests/${contestId}/class-stats`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: rows });
    db.close();
    await app.close();
  });

  it('returns contest detail with problem points', async () => {
    const { db, app } = setup();
    const p1 = createProblem(db, {
      title: 'P1',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
    });
    const contestId = createContest(db, { name: 'Detail', problemIds: [p1] });
    const res = await app.inject({ method: 'GET', url: `/api/contests/${contestId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        contest: { name: string };
        problems: Array<{ problemId: number; points: number; title: string }>;
        participantCount: number;
      };
    };
    expect(body.data.contest.name).toBe('Detail');
    expect(body.data.problems).toEqual([
      expect.objectContaining({ problemId: p1, points: 100, title: 'P1' }),
    ]);
    expect(body.data.participantCount).toBe(0);
    db.close();
    await app.close();
  });
});
