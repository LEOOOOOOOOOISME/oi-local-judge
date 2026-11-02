import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { submitSource } from '../src/services/submissions.js';
import { getCorrectionRanking } from '../src/services/correction-ranking.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { upsertOfficialScore } from '../src/storage/repos/official-scores.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'correction-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
ensureDataDirs(root);
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const problemId = createProblem(db, {
  title: 'Correction Problem',
  type: 'standard',
  timeMs: 1000,
  memoryMb: 64,
  testcases: [],
});
const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
const carol = createUser(db, { username: 'carol', passwordHash: 'x' });

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('correction ranking', () => {
  it('takes the best of official and post-contest correction per problem', () => {
    const contestId = createContest(db, {
      name: 'Correction',
      mode: 'oi',
      problemIds: [problemId],
      startAt: Date.now() - 100_000,
      endAt: Date.now() - 1_000,
    });
    for (const userId of [alice, bob]) {
      db.prepare(
        "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
      ).run(contestId, userId);
    }
    db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);
    upsertOfficialScore(db, {
      contestId,
      userId: alice,
      problemId,
      score: 40,
      verdict: 'PC',
      source: 'online',
    });
    upsertOfficialScore(db, {
      contestId,
      userId: bob,
      problemId,
      score: 100,
      verdict: 'AC',
      source: 'online',
    });
    const correction = createSubmission(db, {
      contestId,
      problemId,
      userId: alice,
      language: 'cpp17',
      sourcePath: 'a.cpp',
      sourceHash: 'a',
      phase: 'correction',
    });
    db.prepare("UPDATE submissions SET status='finished', verdict='AC', score=100 WHERE id=?").run(
      correction,
    );
    const lowerCorrection = createSubmission(db, {
      contestId,
      problemId,
      userId: bob,
      language: 'cpp17',
      sourcePath: 'b.cpp',
      sourceHash: 'b',
      phase: 'correction',
    });
    db.prepare("UPDATE submissions SET status='finished', verdict='WA', score=20 WHERE id=?").run(
      lowerCorrection,
    );

    const data = getCorrectionRanking(db, contestId)!;
    expect(data.correctionsOpen).toBe(true);
    expect(data.rows[0]).toMatchObject({
      userId: alice,
      officialTotal: 40,
      correctedTotal: 100,
      rank: 1,
    });
    expect(data.rows[1]).toMatchObject({
      userId: bob,
      officialTotal: 100,
      correctedTotal: 100,
      rank: 1,
    });
  });

  it('does not open corrections for a draft contest whose end_at has passed', () => {
    const contestId = createContest(db, {
      name: 'Draft Past',
      mode: 'oi',
      problemIds: [problemId],
      startAt: Date.now() - 100_000,
      endAt: Date.now() - 1_000,
    });
    const data = getCorrectionRanking(db, contestId)!;
    expect(data.correctionsOpen).toBe(false);
  });

  it('marks post-end submissions as correction and rejects non-participants', () => {
    const contestId = createContest(db, {
      name: 'Ended',
      mode: 'oi',
      problemIds: [problemId],
      startAt: Date.now() - 100_000,
      endAt: Date.now() - 1_000,
    });
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, alice);
    db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);

    const submitted = submitSource(
      { db, config },
      {
        userId: alice,
        problemId,
        language: 'cpp17',
        code: 'int main(){}',
        contestId,
      },
    );
    const row = db.prepare('SELECT phase FROM submissions WHERE id = ?').get(submitted.id) as {
      phase: string;
    };
    expect(row.phase).toBe('correction');

    expect(() =>
      submitSource(
        { db, config },
        {
          userId: carol,
          problemId,
          language: 'cpp17',
          code: 'int main(){}',
          contestId,
        },
      ),
    ).toThrow(/not a participant/i);
  });
});
