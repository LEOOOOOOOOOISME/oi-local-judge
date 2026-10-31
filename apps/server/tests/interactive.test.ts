import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import { submitSource } from '../src/services/submissions.js';
import { upsertAsset } from '../src/storage/repos/assets.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { getSubmission, getTestResults } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'interactive-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
ensureDataDirs(root);
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const userId = createUser(db, { username: 'alice', passwordHash: 'x' });

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function createInteractiveProblem() {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', '1.in'), '7\n');
  writeFileSync(join(root, 'data', '1.out'), '8\n');
  const problemId = createProblem(db, {
    title: 'Interactive',
    type: 'interactive',
    timeMs: 2000,
    memoryMb: 128,
    testcases: [{ inputPath: 'data/1.in', outputPath: 'data/1.out', points: 100 }],
  });
  const srcDir = join(root, 'problems', String(problemId), 'src');
  mkdirSync(srcDir, { recursive: true });
  const interactorSource = join(srcDir, 'interactor.cpp');
  writeFileSync(
    interactorSource,
    readFileSync(join(process.cwd(), 'tests/fixtures/interactive/interactor.cpp')),
  );
  upsertAsset(db, {
    problemId,
    kind: 'interactor',
    name: 'interactor.cpp',
    path: `problems/${problemId}/src/interactor.cpp`,
    language: 'cpp17',
    sha256: 'x',
    size: 1,
  });
  return problemId;
}

describe('interactive judging', () => {
  it('accepts a correct interactor exchange', async () => {
    const problemId = createInteractiveProblem();
    const code = readFileSync(
      join(process.cwd(), 'tests/fixtures/interactive/contestant-ok.cpp'),
      'utf8',
    );
    const { id } = submitSource({ db, config }, { userId, problemId, language: 'cpp17', code });
    await judgeSubmission({ db, config, submissionId: id });
    const submission = getSubmission(db, id)!;
    expect(submission.status, submission.message).toBe('finished');
    expect(submission.verdict).toBe('AC');
    expect(submission.score).toBe(100);
    expect(getTestResults(db, id)[0].verdict).toBe('AC');
  }, 40_000);

  it('marks a wrong interactor exchange as WA', async () => {
    const problemId = createInteractiveProblem();
    const code = readFileSync(
      join(process.cwd(), 'tests/fixtures/interactive/contestant-bad.cpp'),
      'utf8',
    );
    const { id } = submitSource({ db, config }, { userId, problemId, language: 'cpp17', code });
    await judgeSubmission({ db, config, submissionId: id });
    const submission = getSubmission(db, id)!;
    expect(submission.verdict).toBe('WA');
    expect(submission.score).toBe(0);
  }, 40_000);
});
