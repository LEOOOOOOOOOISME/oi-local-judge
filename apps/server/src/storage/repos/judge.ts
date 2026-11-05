import type { DatabaseSync } from 'node:sqlite';

export function createJudgeTask(db: DatabaseSync, submissionId: number, priority = 50): number {
  const result = db
    .prepare('INSERT INTO judge_tasks(submission_id, priority, created_at) VALUES (?, ?, ?)')
    .run(submissionId, priority, Date.now());
  return Number(result.lastInsertRowid);
}

/**
 * Re-queues the single judge task that belongs to a submission.
 *
 * `judge_tasks.submission_id` is unique, so a rejudge must never insert a
 * second row: the upsert resets the existing task (status/worker/heartbeat) and
 * only inserts one when the submission never had a task. `attempts` restarts at
 * 0 because the new run is a fresh grading attempt. Returns the task id.
 */
export function enqueueRejudge(db: DatabaseSync, submissionId: number, priority = 100): number {
  db.prepare(
    `INSERT INTO judge_tasks(submission_id, priority, status, worker, attempts, heartbeat_at, created_at)
     VALUES (?, ?, 'queued', NULL, 0, NULL, ?)
     ON CONFLICT(submission_id) DO UPDATE SET
       status = 'queued',
       worker = NULL,
       heartbeat_at = NULL,
       attempts = 0,
       priority = MAX(judge_tasks.priority, excluded.priority)`,
  ).run(submissionId, priority, Date.now());
  const row = db
    .prepare('SELECT id FROM judge_tasks WHERE submission_id = ?')
    .get(submissionId) as unknown as { id: number } | undefined;
  if (!row) {
    throw new Error(`judge task for submission ${submissionId} not found after enqueue`);
  }
  return row.id;
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

export function getJudgeTaskBySubmission(
  db: DatabaseSync,
  submissionId: number,
): JudgeTaskRow | null {
  return (
    (db
      .prepare('SELECT * FROM judge_tasks WHERE submission_id = ?')
      .get(submissionId) as unknown as JudgeTaskRow) ?? null
  );
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

export function finishJudgeTask(
  db: DatabaseSync,
  taskId: number,
  status: 'done' | 'failed' | 'canceled',
): void {
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
 * A task whose submission was already canceled is closed as `canceled` instead:
 * a crash between the cancel request and the scheduler bookkeeping must not
 * resurrect the run. Only interrupted tasks are touched: completed/failed
 * tasks and all result rows are left intact. Returns the number of interrupted
 * tasks that were recovered (requeued or closed as canceled).
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
    // The submission was canceled before the crash: finish the orphaned task
    // instead of granting it another run.
    db.prepare(
      `UPDATE judge_tasks SET status = 'canceled', worker = NULL, heartbeat_at = ?
       WHERE status IN ${interruptedStatuses}
         AND submission_id IN (SELECT id FROM submissions WHERE status = 'canceled')`,
    ).run(now);
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
