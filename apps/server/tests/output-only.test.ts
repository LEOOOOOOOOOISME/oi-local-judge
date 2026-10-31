import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import { getTestResults, getSubmission } from '../src/storage/repos/submissions.js';
import { submitSource } from '../src/services/submissions.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'output-only-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
ensureDataDirs(root);
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const userId = createUser(db, { username: 'alice', passwordHash: 'x' });
mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(join(root, 'data', '1.in'), '1 2\n');
writeFileSync(join(root, 'data', '1.out'), '3\n');
writeFileSync(join(root, 'data', '2.in'), '2 2\n');
writeFileSync(join(root, 'data', '2.out'), '4\n');

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('output-only submissions', () => {
  it('grades uploaded answers against answer files', async () => {
    const problemId = createProblem(db, {
      title: 'Submit answers',
      type: 'output-only',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [
        { inputPath: 'data/1.in', outputPath: 'data/1.out', points: 50 },
        { inputPath: 'data/2.in', outputPath: 'data/2.out', points: 50 },
      ],
    });
    const { id } = submitSource(
      { db, config },
      {
        userId,
        problemId,
        language: 'answer',
        code: JSON.stringify({
          answers: [
            { testcaseId: 1, value: '3\n' },
            { testcaseId: 2, value: 'bad\n' },
          ],
        }),
      },
    );
    await judgeSubmission({ db, config, submissionId: id });
    const submission = getSubmission(db, id)!;
    expect(submission.status).toBe('finished');
    expect(submission.score).toBe(50);
    expect(submission.verdict).toBe('PC');
    expect(getTestResults(db, id).map((row) => row.verdict)).toEqual(['AC', 'WA']);
  });
});
