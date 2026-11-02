import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { submitSource } from '../src/services/submissions.js';
import { addParticipant, createContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-access-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const alice = createUser(db, { username: 'alice', passwordHash: 'x' });
  const bob = createUser(db, { username: 'bob', passwordHash: 'x' });
  const p1 = createProblem(db, {
    title: 'P1', type: 'standard', timeMs: 1000, memoryMb: 64,
    testcases: [{ inputPath: '1.in', outputPath: '1.out', points: 100 }],
  });
  const p2 = createProblem(db, {
    title: 'P2', type: 'standard', timeMs: 1000, memoryMb: 64,
    testcases: [{ inputPath: '2.in', outputPath: '2.out', points: 100 }],
  });
  return { dir, db, config, alice, bob, p1, p2 };
}

function submit(
  ctx: ReturnType<typeof setup>,
  userId: number,
  problemId: number,
  contestId: number | null,
  now?: number,
) {
  return submitSource({ db: ctx.db, config: ctx.config }, {
    userId, problemId, contestId, language: 'cpp17', code: 'int main(){return 0;}',
    ...(now === undefined ? {} : { now }),
  });
}

describe('contest submission access', () => {
  it('rejects a non-participant', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
    });
    expect(() => submit(ctx, ctx.bob, ctx.p1, contestId, 1500))
      .toThrowError(/not a participant/i);
    ctx.db.close();
  });

  it('rejects before the contest starts', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
    });
    addParticipant(ctx.db, contestId, ctx.alice);
    expect(() => submit(ctx, ctx.alice, ctx.p1, contestId, 500))
      .toThrowError(/not started/i);
    ctx.db.close();
  });

  it('rejects a problem that is not in the contest', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
    });
    addParticipant(ctx.db, contestId, ctx.alice);
    expect(() => submit(ctx, ctx.alice, ctx.p2, contestId, 1500))
      .toThrowError(/not in this contest/i);
    ctx.db.close();
  });

  it('accepts an accepted participant during the contest', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
    });
    addParticipant(ctx.db, contestId, ctx.alice);
    const { id } = submit(ctx, ctx.alice, ctx.p1, contestId, 1500);
    const row = ctx.db.prepare('SELECT phase FROM submissions WHERE id = ?').get(id) as { phase: string };
    expect(row.phase).toBe('contest');
    ctx.db.close();
  });

  it('marks a participant submission after the end as correction', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
    });
    addParticipant(ctx.db, contestId, ctx.alice);
    const { id } = submit(ctx, ctx.alice, ctx.p1, contestId, 2500);
    const row = ctx.db.prepare('SELECT phase FROM submissions WHERE id = ?').get(id) as { phase: string };
    expect(row.phase).toBe('correction');
    ctx.db.close();
  });

  it('rejects a pending participant', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
    });
    addParticipant(ctx.db, contestId, ctx.alice);
    ctx.db.prepare("UPDATE contest_participants SET status = 'pending' WHERE contest_id = ? AND user_id = ?")
      .run(contestId, ctx.alice);
    expect(() => submit(ctx, ctx.alice, ctx.p1, contestId, 1500))
      .toThrowError(/not accepted/i);
    ctx.db.close();
  });

  it('rejects an archived contest', () => {
    const ctx = setup();
    const contestId = createContest(ctx.db, {
      name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
    });
    addParticipant(ctx.db, contestId, ctx.alice);
    ctx.db.prepare("UPDATE contests SET status = 'archived', archived_at = 1 WHERE id = ?").run(contestId);
    expect(() => submit(ctx, ctx.alice, ctx.p1, contestId, 1500))
      .toThrowError(/archived/i);
    ctx.db.close();
  });

  it('does not gate practice submissions', () => {
    const ctx = setup();
    const { id } = submit(ctx, ctx.alice, ctx.p1, null, 500);
    const row = ctx.db.prepare('SELECT phase FROM submissions WHERE id = ?').get(id) as { phase: string };
    expect(row.phase).toBe('contest');
    ctx.db.close();
  });
});
