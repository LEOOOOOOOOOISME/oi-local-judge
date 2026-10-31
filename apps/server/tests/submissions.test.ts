import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { submitSource, getSubmissionDetail } from '../src/services/submissions.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-submit-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const userId = createUser(db, { username: 'alice', passwordHash: 'x' });
  const problemId = createProblem(db, {
    title: 'A+B',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  return { dir, db, config, userId, problemId };
}

describe('submission service', () => {
  it('stores source, creates a judge task and returns detail', () => {
    const { dir, db, config, userId, problemId } = setup();
    const { id } = submitSource(
      { db, config },
      { userId, problemId, language: 'cpp17', code: 'int main(){return 0;}' },
    );
    const detail = getSubmissionDetail(db, id)!;
    expect(detail.status).toBe('queued');
    expect(detail.userId).toBe(userId);
    const task = db
      .prepare('SELECT status FROM judge_tasks WHERE submission_id = ?')
      .get(id) as unknown as { status: string };
    expect(task.status).toBe('queued');
    const source = db
      .prepare('SELECT source_path FROM submissions WHERE id = ?')
      .get(id) as unknown as { source_path: string };
    expect(existsSync(join(dir, source.source_path))).toBe(true);
    db.close();
  });

  it('rejects unsupported language and oversize source', () => {
    const { db, config, userId, problemId } = setup();
    expect(() =>
      submitSource({ db, config }, { userId, problemId, language: 'java', code: 'x' }),
    ).toThrow(/unsupported language/);
    expect(() =>
      submitSource(
        { db, config },
        { userId, problemId, language: 'cpp17', code: 'x'.repeat(256 * 1024 + 1) },
      ),
    ).toThrow(/too large/);
    db.close();
  });
});
