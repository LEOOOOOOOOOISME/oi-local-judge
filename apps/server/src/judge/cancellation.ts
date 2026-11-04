// Cancellation registry for in-flight judge tasks.
//
// The scheduler registers one AbortController per submission before it starts
// judging and releases it in its `finally`. The cancel service looks the
// controller up by submission id and aborts it, which terminates the sandboxed
// runner process through `execFile`'s `signal` option.
//
// The module keeps a single Map keyed by submission id. Every register must be
// paired with a release; the scheduler does that in a `finally`, so the map
// cannot grow with completed work.

/** Error code carried by an aborted judge run. */
export const JUDGE_CANCELED_CODE = 'ABORT_ERR';

/**
 * Thrown when a judge run stops because the submission was canceled.
 *
 * It deliberately presents itself as an `AbortError` (`name`/`code`) so code
 * that only understands Node's standard abort shape still recognizes the stop,
 * while `instanceof JudgeCanceledError` gives the pipeline an exact match.
 */
export class JudgeCanceledError extends Error {
  readonly code = JUDGE_CANCELED_CODE;

  constructor(message = 'judge canceled') {
    super(message);
    this.name = 'AbortError';
  }
}

/** True when `error` came from a canceled judge run (including cross-realm). */
export function isJudgeCanceledError(error: unknown): error is JudgeCanceledError {
  if (error instanceof JudgeCanceledError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'JudgeCanceledError' ||
    (candidate.name === 'AbortError' && candidate.code === JUDGE_CANCELED_CODE)
  );
}

const controllers = new Map<number, AbortController>();

/**
 * Registers (or returns) the controller for a submission.
 *
 * Idempotent: a second registration while the task is still active returns the
 * same controller, so a cancel that raced with task startup is not lost. A
 * stale controller that was already aborted is replaced with a fresh one — that
 * can only happen if a caller skipped `releaseCancellation`, and reusing the
 * aborted signal would cancel the new task immediately.
 */
export function registerCancellation(submissionId: number): AbortController {
  const existing = controllers.get(submissionId);
  if (existing && !existing.signal.aborted) {
    return existing;
  }
  const controller = new AbortController();
  controllers.set(submissionId, controller);
  return controller;
}

/**
 * Aborts the registered controller for a submission.
 *
 * Returns `true` when a controller was registered (whether this call performed
 * the abort or the task was already canceled), `false` when the submission has
 * no active judge task in this process.
 */
export function abortSubmission(submissionId: number): boolean {
  const controller = controllers.get(submissionId);
  if (!controller) return false;
  if (!controller.signal.aborted) {
    controller.abort(new JudgeCanceledError());
  }
  return true;
}

/** Drops the registration for a submission. Safe to call more than once. */
export function releaseCancellation(submissionId: number): void {
  controllers.delete(submissionId);
}

/** True when the submission's registered controller has been aborted. */
export function isCancellationAborted(submissionId: number): boolean {
  return controllers.get(submissionId)?.signal.aborted ?? false;
}
