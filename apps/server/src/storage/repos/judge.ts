import type { DatabaseSync } from 'node:sqlite';

export function createJudgeTask(db: DatabaseSync, submissionId: number, priority = 50): number {
  const result = db
    .prepare('INSERT INTO judge_tasks(submission_id, priority, created_at) VALUES (?, ?, ?)')
    .run(submissionId, priority, Date.now());
  return Number(result.lastInsertRowid);
}

export interface JudgeTaskRow {
  id: number;
  submission_id: number;
  priority: number;
  status: string;
  worker: string | null;
  attempts: number;
  heartbeat_at: number | null;
  created_at: number;
}

export function claimNextTask(db: DatabaseSync, worker: string): JudgeTaskRow | null {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(
        `SELECT * FROM judge_tasks WHERE status = 'queued'
         ORDER BY priority DESC, id LIMIT 1`,
      )
      .get() as unknown as JudgeTaskRow | undefined;
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    db.prepare(
      `UPDATE judge_tasks SET status = 'running', worker = ?, attempts = attempts + 1,
       heartbeat_at = ? WHERE id = ?`,
    ).run(worker, Date.now(), row.id);
    db.exec('COMMIT');
    return { ...row, status: 'running', worker, attempts: row.attempts + 1 };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function finishJudgeTask(db: DatabaseSync, taskId: number, status: 'done' | 'failed'): void {
  db.prepare('UPDATE judge_tasks SET status = ?, heartbeat_at = ? WHERE id = ?').run(
    status,
    Date.now(),
    taskId,
  );
}

export function requeueTask(db: DatabaseSync, taskId: number): void {
  db.prepare("UPDATE judge_tasks SET status = 'queued', worker = NULL WHERE id = ?").run(taskId);
}

/**
 * Resets judge tasks left in `running`/`compiling` by an interrupted process
 * (crash, force-kill) back to `queued` and re-queues their submissions.
 *
 * Only interrupted tasks are touched: completed/failed tasks and all result
 * rows are left intact. Returns the number of recovered tasks.
 */
export function recoverInterruptedJudgeTasks(db: DatabaseSync, now = Date.now()): number {
  const interruptedStatuses = "('running', 'compiling')";
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM judge_tasks WHERE status IN ${interruptedStatuses}`)
      .get() as unknown as { n: number };
    if (row.n === 0) {
      db.exec('COMMIT');
      return 0;
    }
    db.prepare(
      `UPDATE submissions SET status = 'queued' WHERE id IN
         (SELECT submission_id FROM judge_tasks WHERE status IN ${interruptedStatuses})`,
    ).run();
    db.prepare(
      `UPDATE judge_tasks SET status = 'queued', worker = NULL, heartbeat_at = ?
       WHERE status IN ${interruptedStatuses}`,
    ).run(now);
    db.exec('COMMIT');
    return row.n;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
