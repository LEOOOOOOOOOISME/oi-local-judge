import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { gradeObjective } from '../src/judge/objective.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import { getProblemDetail, stripObjectiveAnswers } from '../src/services/problems.js';
import { submitSource } from '../src/services/submissions.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { getTestResults, getSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'objective-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
ensureDataDirs(root);
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const userId = createUser(db, { username: 'alice', passwordHash: 'x' });

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const objective = {
  questions: [
    {
      id: 1,
      kind: 'single' as const,
      stem: '1+1=?',
      options: [
        { key: 'A', text: '1' },
        { key: 'B', text: '2' },
      ],
      answers: ['B'],
      points: 20,
    },
    {
      id: 2,
      kind: 'multiple' as const,
      stem: '哪些是偶数？',
      options: [
        { key: 'A', text: '2' },
        { key: 'B', text: '3' },
        { key: 'C', text: '4' },
      ],
      answers: ['A', 'C'],
      points: 30,
      partial: true,
    },
    {
      id: 3,
      kind: 'fill' as const,
      stem: '输入 3.14',
      answers: ['3.14'],
      points: 50,
      ignoreCase: true,
      ignoreWhitespace: true,
    },
  ],
};

describe('objective grading', () => {
  it('grades single, multiple partial and fill', () => {
    const graded = gradeObjective(objective, [
      { questionId: 1, value: ['B'] },
      { questionId: 2, value: ['A'] },
      { questionId: 3, value: ' 3.14 ' },
    ]);
    expect(graded.results.map((row) => row.verdict)).toEqual(['AC', 'PC', 'AC']);
    expect(graded.score).toBe(20 + 15 + 50);
  });

  it('penalizes wrong multiple selections and handles missing answers', () => {
    const graded = gradeObjective(objective, [
      { questionId: 1, value: ['A'] },
      { questionId: 2, value: ['A', 'B'] },
    ]);
    expect(graded.results[0].verdict).toBe('WA');
    expect(graded.results[1].verdict).toBe('WA');
    expect(graded.results[2].verdict).toBe('WA');
  });

  it('judges an objective submission end-to-end and hides answers publicly', async () => {
    const problemId = createProblem(db, {
      title: 'Objective',
      type: 'objective',
      timeMs: 1000,
      memoryMb: 64,
      objective,
      testcases: [],
    });
    const detail = getProblemDetail(db, problemId)!;
    expect(detail.objective?.questions[0].answers).toEqual(['B']);
    expect(stripObjectiveAnswers(detail).objective?.questions[0].answers).toBeUndefined();

    const { id } = submitSource(
      { db, config },
      {
        userId,
        problemId,
        language: 'objective',
        code: JSON.stringify({
          answers: [
            { questionId: 1, value: ['B'] },
            { questionId: 2, value: ['A'] },
            { questionId: 3, value: '3.14' },
          ],
        }),
        contestId: null,
      },
    );
    await judgeSubmission({ db, config, submissionId: id });
    const submission = getSubmission(db, id)!;
    expect(submission.status).toBe('finished');
    expect(submission.verdict).toBe('PC');
    expect(submission.score).toBe(85);
    expect(getTestResults(db, id)).toHaveLength(3);
  }, 30_000);
});
