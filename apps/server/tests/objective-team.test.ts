import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { judgeSubmission } from '../src/judge/pipeline.js';
import {
  ContestTeamError,
  getRegisteredTeamForUser,
  registerTeamForContest,
} from '../src/services/contest-teams.js';
import { canViewProblem } from '../src/services/problem-acl.js';
import { getProblemDetail, stripObjectiveAnswers } from '../src/services/problems.js';
import { submitSource } from '../src/services/submissions.js';
import { addTeamMember, createTeam } from '../src/services/teams.js';
import { getTeamRanking } from '../src/services/team-ranking.js';
import { addParticipant, createContest } from '../src/storage/repos/contests.js';
import { createProblem, getProblem } from '../src/storage/repos/problems.js';
import { createSubmission, getSubmission } from '../src/storage/repos/submissions.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
const dbs: DatabaseSync[] = [];

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  dbs.length = 0;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
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
  ],
};

const correctAnswers = JSON.stringify({
  answers: [
    { questionId: 1, value: ['B'] },
    { questionId: 2, value: ['A', 'C'] },
  ],
});

interface Ctx {
  db: DatabaseSync;
  config: Config;
  alice: number;
  bob: number;
  carol: number;
  admin: number;
  teamId: number;
  objectiveProblem: number;
  programmingProblem: number;
}

function setup(): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'oij-objective-team-'));
  dirs.push(dir);
  ensureDataDirs(dir);
  const db = openDatabase(join(dir, 'test.db'));
  dbs.push(db);
  migrate(db);
  const config: Config = {
    ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }),
    dataDir: dir,
  };
  const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
  const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
  const carol = createUser(db, { username: 'carol', passwordHash: 'x' });
  const admin = createUser(db, {
    username: 'admin',
    passwordHash: 'x',
    role: 'admin',
  });
  const teamId = createTeam(db, { name: 'Objective team', ownerId: alice });
  addTeamMember(db, { teamId, actorId: alice, username: 'bob' });
  const objectiveProblem = createProblem(db, {
    title: 'Team objective',
    type: 'objective',
    timeMs: 1000,
    memoryMb: 64,
    visibility: 'hidden',
    ownerType: 'team',
    ownerId: teamId,
    objective,
    testcases: [],
  });
  const programmingProblem = createProblem(db, {
    title: 'Team programming',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 64,
    testcases: [],
  });
  return {
    db,
    config,
    alice,
    bob,
    carol,
    admin,
    teamId,
    objectiveProblem,
    programmingProblem,
  };
}

describe('team-owned objective ACL', () => {
  it('is readable by team members only and hides answers from them too', () => {
    const ctx = setup();
    const problem = getProblem(ctx.db, ctx.objectiveProblem)!;

    expect(canViewProblem(ctx.db, problem, { userId: ctx.alice })).toBe(true);
    expect(canViewProblem(ctx.db, problem, { userId: ctx.bob })).toBe(true);
    expect(canViewProblem(ctx.db, problem, { userId: ctx.carol })).toBe(false);
    expect(canViewProblem(ctx.db, problem, {})).toBe(false);
    expect(canViewProblem(ctx.db, problem, { userId: ctx.admin, isAdmin: true })).toBe(true);

    const authoring = getProblemDetail(ctx.db, ctx.objectiveProblem)!;
    expect(authoring.objective?.questions[0].answers).toEqual(['B']);
    const shared = stripObjectiveAnswers(authoring);
    expect(shared.objective?.questions[0].answers).toBeUndefined();
    expect(shared.objective?.questions[1].answers).toBeUndefined();
    expect(shared.objective?.questions).toHaveLength(2);
    expect(shared.statementHtml).toBe(authoring.statementHtml);
  });
});

describe('objective submissions in team contests', () => {
  it('attributes, grades and ranks an objective submission exactly like a programming one', async () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Team mixed contest',
      mode: 'oi',
      teamMode: 'team',
      startAt: 1000,
      endAt: 100_000,
      problemIds: [ctx.objectiveProblem, ctx.programmingProblem],
    });
    registerTeamForContest(ctx.db, {
      contestId,
      teamId: ctx.teamId,
      actorId: ctx.alice,
      isAdmin: false,
    });
    // Team registration still enrolls members as accepted participants.
    expect(getRegisteredTeamForUser(ctx.db, contestId, ctx.bob)).toBe(ctx.teamId);
    const participant = ctx.db
      .prepare(
        'SELECT status FROM contest_participants WHERE contest_id = ? AND user_id = ?',
      )
      .get(contestId, ctx.bob) as unknown as { status: string };
    expect(participant.status).toBe('accepted');

    ctx.db
      .prepare("UPDATE contests SET status = 'running' WHERE id = ?")
      .run(contestId);

    const { id: objectiveSubmissionId } = submitSource(
      { db: ctx.db, config: ctx.config },
      {
        userId: ctx.alice,
        problemId: ctx.objectiveProblem,
        language: 'objective',
        code: correctAnswers,
        contestId,
        now: 2000,
      },
    );
    const queued = getSubmission(ctx.db, objectiveSubmissionId)!;
    expect(queued.phase).toBe('contest');
    expect(queued.team_id).toBe(ctx.teamId);

    await judgeSubmission({
      db: ctx.db,
      config: ctx.config,
      submissionId: objectiveSubmissionId,
    });
    const judged = getSubmission(ctx.db, objectiveSubmissionId)!;
    expect(judged.status).toBe('finished');
    expect(judged.verdict).toBe('AC');
    expect(judged.score).toBe(50);
    expect(judged.team_id).toBe(ctx.teamId);

    // A programming submission is represented by its finished row; the shared
    // team board must aggregate both problem types through the same `team_id`.
    const programmingSubmissionId = createSubmission(ctx.db, {
      contestId,
      problemId: ctx.programmingProblem,
      userId: ctx.bob,
      teamId: ctx.teamId,
      language: 'cpp17',
      sourcePath: 'x.cpp',
      sourceHash: 'h',
      phase: 'contest',
      createdAt: 3000,
    });
    ctx.db
      .prepare(
        "UPDATE submissions SET status = 'finished', verdict = 'AC', score = 100 WHERE id = ?",
      )
      .run(programmingSubmissionId);

    const ranking = getTeamRanking(ctx.db, contestId)!;
    expect(ranking.problems.map((problem) => problem.id)).toEqual([
      ctx.objectiveProblem,
      ctx.programmingProblem,
    ]);
    const row = ranking.rows.find((entry) => entry.teamId === ctx.teamId)!;
    expect(row.totalScore).toBe(150);
    expect(row.solved).toBe(2);
    expect(row.cells.find((cell) => cell.problemId === ctx.objectiveProblem)).toMatchObject({
      score: 50,
      verdict: 'AC',
    });
    expect(
      row.cells.find((cell) => cell.problemId === ctx.programmingProblem),
    ).toMatchObject({ score: 100, verdict: 'AC' });
  });

  it('rejects an objective submission from a team-mode participant without a registered team', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'Team required',
      mode: 'oi',
      teamMode: 'team',
      startAt: 1000,
      endAt: 100_000,
      problemIds: [ctx.objectiveProblem],
    });
    addParticipant(ctx.db, contestId, ctx.carol);
    ctx.db
      .prepare("UPDATE contests SET status = 'running' WHERE id = ?")
      .run(contestId);

    try {
      submitSource(
        { db: ctx.db, config: ctx.config },
        {
          userId: ctx.carol,
          problemId: ctx.objectiveProblem,
          language: 'objective',
          code: correctAnswers,
          contestId,
          now: 2000,
        },
      );
      throw new Error('expected TEAM_REQUIRED');
    } catch (err) {
      expect(err).toBeInstanceOf(ContestTeamError);
      expect((err as ContestTeamError).code).toBe('TEAM_REQUIRED');
    }
  });
});
