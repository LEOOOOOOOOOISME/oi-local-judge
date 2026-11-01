import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  getOfficialScore,
  listOfficialScores,
  seedOfficialScoresFromSubmissions,
  upsertOfficialScore,
} from '../src/storage/repos/official-scores.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createSubmission } from '../src/storage/repos/submissions.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'official-scores-'));
const db = openDatabase(join(root, 'test.db'));
migrate(db);

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function addSubmission(input: {
  contestId: number;
  userId: number;
  problemId: number;
  score: number;
  verdict: string;
  status?: string;
  createdAt?: number;
}) {
  const id = createSubmission(db, {
    contestId: input.contestId,
    problemId: input.problemId,
    userId: input.userId,
    language: 'cpp17',
    sourcePath: 'x.cpp',
    sourceHash: 'h',
  });
  db.prepare(
    'UPDATE submissions SET status = ?, verdict = ?, score = ?, created_at = ? WHERE id = ?',
  ).run(input.status ?? 'finished', input.verdict, input.score, input.createdAt ?? Date.now(), id);
  return id;
}

describe('official score storage', () => {
  it('seeds the best score per user/problem and prefers AC on ties', () => {
    const contestId = createContest(db, { name: 'Official' });
    const other = createContest(db, { name: 'Other' });
    addSubmission({ contestId, userId: 1, problemId: 1, score: 50, verdict: 'WA' });
    addSubmission({ contestId, userId: 1, problemId: 1, score: 100, verdict: 'AC' });
    addSubmission({ contestId, userId: 1, problemId: 1, score: 100, verdict: 'PC' });
    addSubmission({ contestId, userId: 1, problemId: 2, score: 30, verdict: 'PC' });
    addSubmission({ contestId, userId: 2, problemId: 1, score: 100, verdict: 'AC' });
    addSubmission({ contestId: other, userId: 1, problemId: 1, score: 999, verdict: 'AC' });

    expect(seedOfficialScoresFromSubmissions(db, contestId)).toBe(3);
    expect(listOfficialScores(db, contestId)).toHaveLength(3);
    expect(getOfficialScore(db, contestId, 1, 1)).toMatchObject({
      score: 100,
      verdict: 'AC',
      source: 'online',
    });
    expect(getOfficialScore(db, contestId, 1, 2)?.score).toBe(30);
    expect(getOfficialScore(db, contestId, 2, 1)?.score).toBe(100);
  });

  it('allows batch upsert and does not lower a higher official cell', () => {
    const contestId = createContest(db, { name: 'Batch' });
    addSubmission({ contestId, userId: 1, problemId: 1, score: 100, verdict: 'AC' });
    seedOfficialScoresFromSubmissions(db, contestId);
    upsertOfficialScore(db, {
      contestId,
      userId: 1,
      problemId: 1,
      score: 120,
      verdict: 'AC',
      source: 'batch',
      batchId: 7,
    });
    expect(getOfficialScore(db, contestId, 1, 1)).toMatchObject({
      score: 120,
      source: 'batch',
      batch_id: 7,
    });
    seedOfficialScoresFromSubmissions(db, contestId);
    expect(getOfficialScore(db, contestId, 1, 1)?.score).toBe(120);
  });
});
