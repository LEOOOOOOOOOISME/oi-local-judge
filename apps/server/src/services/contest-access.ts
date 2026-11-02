import type { DatabaseSync } from 'node:sqlite';
import {
  getContest,
  getContestParticipantStatus,
  getContestProblemIds,
  type ContestRow,
} from '../storage/repos/contests.js';

export class ContestAccessError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'ContestAccessError';
    this.code = code;
    this.status = status;
  }
}

export function resolveContestSubmission(input: {
  db: DatabaseSync;
  contestId: number;
  problemId: number;
  userId: number;
  now?: number;
}): { phase: 'contest' | 'correction'; contest: ContestRow } {
  const now = input.now ?? Date.now();
  const contest = getContest(input.db, input.contestId);
  if (!contest) {
    throw new ContestAccessError('CONTEST_NOT_FOUND', 404, 'contest not found');
  }
  if (contest.archived_at !== null || contest.status === 'archived') {
    throw new ContestAccessError('CONTEST_ARCHIVED', 403, 'contest is archived');
  }
  if (!getContestProblemIds(input.db, contest.id).includes(input.problemId)) {
    throw new ContestAccessError('PROBLEM_NOT_IN_CONTEST', 403, 'problem is not in this contest');
  }
  const participant = getContestParticipantStatus(input.db, contest.id, input.userId);
  if (participant === null) {
    throw new ContestAccessError('NOT_PARTICIPANT', 403, 'not a participant of this contest');
  }
  if (participant !== 'accepted') {
    throw new ContestAccessError('NOT_ACCEPTED', 403, 'participant is not accepted');
  }

  if (contest.status === 'draft') {
    throw new ContestAccessError('CONTEST_NOT_STARTED', 403, 'contest has not started');
  }

  const ended =
    contest.status === 'ended' ||
    (contest.end_at !== null && now >= contest.end_at);
  if (ended) {
    return { phase: 'correction', contest };
  }

  if (contest.start_at !== null && now < contest.start_at) {
    throw new ContestAccessError('CONTEST_NOT_STARTED', 403, 'contest has not started');
  }
  if (contest.status !== 'running' && contest.status !== 'frozen') {
    throw new ContestAccessError('CONTEST_NOT_RUNNING', 403, 'contest is not running');
  }
  return { phase: 'contest', contest };
}
