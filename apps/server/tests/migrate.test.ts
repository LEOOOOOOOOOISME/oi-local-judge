import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import { createJudgeTask, claimNextTask, finishJudgeTask } from '../src/storage/repos/judge.js';
import { createProblem, getProblem, getTestcases } from '../src/storage/repos/problems.js';
import { createSubmission, getSubmission } from '../src/storage/repos/submissions.js';
import { createUser, getUserByUsername } from '../src/storage/repos/users.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-migrate-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return db;
}

describe('migrations and repositories', () => {
  it('is idempotent and creates core tables', () => {
    const db = freshDb();
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'users',
        'problems',
        'problem_testcases',
        'problem_subtasks',
        'submissions',
        'test_results',
        'judge_tasks',
        'contests',
        'contest_problems',
      ]),
    );
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n,
    ).toBe(1);
    db.close();
  });

  it('adds the participant source column defaulting to manual', () => {
    const db = freshDb();
    const columns = db.prepare('PRAGMA table_info(contest_participants)').all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(columns.find((column) => column.name === 'source')).toMatchObject({
      dflt_value: "'manual'",
    });

    db.prepare("INSERT INTO contests(name) VALUES ('Legacy')").run();
    const contest = db.prepare("SELECT id FROM contests WHERE name = 'Legacy'").get() as {
      id: number;
    };
    db.prepare('INSERT INTO contest_participants(contest_id, user_id) VALUES (?, ?)').run(
      contest.id,
      1,
    );
    const row = db
      .prepare('SELECT source FROM contest_participants WHERE contest_id = ? AND user_id = 1')
      .get(contest.id) as { source: string };
    expect(row.source).toBe('manual');
    db.close();
  });

  it('round-trips user, problem, submission and judge task', () => {
    const db = freshDb();
    const userId = createUser(db, {
      username: 'alice',
      passwordHash: 'hash',
      realName: 'Alice',
      className: '1班',
    });
    expect(getUserByUsername(db, 'alice')?.id).toBe(userId);

    const problemId = createProblem(db, {
      title: 'A+B',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [
        { inputPath: 'data/1.in', outputPath: 'data/1.out', points: 50 },
        { inputPath: 'data/2.in', outputPath: 'data/2.out', points: 50 },
      ],
    });
    expect(getProblem(db, problemId)?.title).toBe('A+B');
    expect(getTestcases(db, problemId)).toHaveLength(2);

    const submissionId = createSubmission(db, {
      problemId,
      userId,
      language: 'cpp17',
      sourcePath: 'submissions/1/main.cpp',
      sourceHash: 'abc',
    });
    expect(getSubmission(db, submissionId)?.status).toBe('queued');

    const taskId = createJudgeTask(db, submissionId);
    const claimed = claimNextTask(db, 'worker-1');
    expect(claimed?.id).toBe(taskId);
    expect(claimed?.status).toBe('running');
    expect(claimNextTask(db, 'worker-2')).toBeNull();
    finishJudgeTask(db, taskId, 'done');
    expect(
      (db.prepare('SELECT status FROM judge_tasks WHERE id = ?').get(taskId) as { status: string })
        .status,
    ).toBe('done');
    db.close();
  });
});
