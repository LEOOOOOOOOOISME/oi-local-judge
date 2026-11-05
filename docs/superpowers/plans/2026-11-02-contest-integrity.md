# Contest Integrity v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让“未报名/未开赛/非本赛题/已归档”的提交在服务端被拒绝，并让比赛按服务器时间自动开始、封榜、结束。

**Architecture:** 新增独立的 `contest-access` 与 `contest-clock` 服务；`submitSource` 只负责调用访问策略，不把规则散落在 HTTP 层。定时器只调用幂等的 `tickContests`，测试直接传 `now`，不依赖真实时间。

**Tech Stack:** TypeScript 5.7、Node 24、Fastify 5、`node:sqlite`、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md`

## Global Constraints

- 不新增运行时依赖。
- 保持现有 API 响应包络：`{ ok: true, data }` / `{ ok: false, error: { code, message } }`。
- 所有时间戳为毫秒整数；测试不得依赖真实系统时间。
- 不改变 `batch_draft` 内部提交行为。
- 不修改前端；本计划只做服务端与测试。
- 提交：一个任务一个 commit，commit message 使用 `feat:` / `fix:` / `test:`。

---

### Task 1: Contest submission access gate

**Files:**
- Create: `apps/server/src/services/contest-access.ts`
- Modify: `apps/server/src/storage/repos/contests.ts`
- Modify: `apps/server/src/services/submissions.ts`
- Modify: `apps/server/src/http/submissions.ts`
- Create: `apps/server/tests/contest-access.test.ts`

**Interfaces:**
- Consumes: `getContest`, `getContestProblemIds`, `isContestParticipant`, `getContestParticipantStatus` (new).
- Produces:
  - `class ContestAccessError extends Error { code: string; status: number }`
  - `resolveContestSubmission(input: { db; contestId; problemId; userId; now?: number }): { phase: 'contest' | 'correction'; contest: ContestRow }`
  - `getContestParticipantStatus(db, contestId, userId): 'accepted' | 'pending' | 'rejected' | null`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/contest-access.test.ts`:

```ts
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

function submit(ctx: ReturnType<typeof setup>, userId: number, problemId: number, contestId: number | null, now?: number) {
  return submitSource({ db: ctx.db, config: ctx.config }, {
    userId, problemId, contestId, language: 'cpp17', code: 'int main(){return 0;}',
    ...(now === undefined ? {} : { now }),
  } as never);
}
```

Add tests:

```ts
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
  ctx.db.prepare("UPDATE contests SET status = 'running' WHERE id = ?").run(contestId);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/tests/contest-access.test.ts`
Expected: FAIL because `now` is not accepted and no access guard exists.

- [ ] **Step 3: Add participant status lookup**

In `apps/server/src/storage/repos/contests.ts`, append:

```ts
export function getContestParticipantStatus(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): 'accepted' | 'pending' | 'rejected' | null {
  const row = db
    .prepare('SELECT status FROM contest_participants WHERE contest_id = ? AND user_id = ?')
    .get(contestId, userId) as { status: string } | undefined;
  if (!row) return null;
  if (row.status === 'accepted' || row.status === 'pending' || row.status === 'rejected') {
    return row.status;
  }
  return null;
}
```

- [ ] **Step 4: Implement the access policy**

Create `apps/server/src/services/contest-access.ts`:

```ts
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

  const ended =
    contest.status === 'ended' ||
    (contest.end_at !== null && now >= contest.end_at);
  if (ended) {
    return { phase: 'correction', contest };
  }

  if (contest.status === 'draft') {
    throw new ContestAccessError('CONTEST_NOT_STARTED', 403, 'contest has not started');
  }
  if (contest.start_at !== null && now < contest.start_at) {
    throw new ContestAccessError('CONTEST_NOT_STARTED', 403, 'contest has not started');
  }
  if (contest.status !== 'running' && contest.status !== 'frozen') {
    throw new ContestAccessError('CONTEST_NOT_RUNNING', 403, 'contest is not running');
  }
  return { phase: 'contest', contest };
}
```

- [ ] **Step 5: Wire the policy into `submitSource`**

In `apps/server/src/services/submissions.ts`:

1. Extend `SubmitInput` with `now?: number`.
2. Replace the existing `let phase...` block with:

```ts
let phase = input.phase ?? 'contest';
if (input.contestId && !input.phase) {
  const resolved = resolveContestSubmission({
    db: deps.db,
    contestId: input.contestId,
    problemId: input.problemId,
    userId: input.userId,
    now: input.now,
  });
  phase = resolved.phase;
  if (phase === 'contest' && getLock(deps.db, input.contestId, input.userId, input.problemId)) {
    throw new Error('problem is locked; no further submissions are accepted');
  }
}
```

3. Add import `resolveContestSubmission` from `./contest-access.js`.
4. Keep the existing `getContest` ended/lock block removed to avoid duplicate checks.

- [ ] **Step 6: Map errors in HTTP**

In `apps/server/src/http/submissions.ts`, import `ContestAccessError` and change the catch:

```ts
} catch (err) {
  if (err instanceof ContestAccessError) {
    return reply.code(err.status).send({
      ok: false,
      error: { code: err.code, message: err.message },
    });
  }
  const message = (err as Error).message;
  const status = /too large/.test(message) ? 413 : /not found/.test(message) ? 404 : 400;
  return reply.code(status).send({ ok: false, error: { code: 'SUBMIT_FAILED', message } });
}
```

- [ ] **Step 7: Run targeted tests**

Run: `npx vitest run apps/server/tests/contest-access.test.ts apps/server/tests/submissions.test.ts apps/server/tests/contest-batch.test.ts`
Expected: PASS; no regression in batch drafts.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/services/contest-access.ts apps/server/src/storage/repos/contests.ts apps/server/src/services/submissions.ts apps/server/src/http/submissions.ts apps/server/tests/contest-access.test.ts
git commit -m "feat: enforce contest submission access"
```

---

### Task 2: Server-authoritative contest clock

**Files:**
- Create: `apps/server/src/services/contest-clock.ts`
- Modify: `apps/server/src/cli.ts`
- Create: `apps/server/tests/contest-clock.test.ts`

**Interfaces:**
- Consumes: `listContests`, `setContestStatus`, `ContestRow`.
- Produces:
  - `tickContests(db, now?: number): ContestClockTransition[]`
  - `startContestClock(db, options?: { intervalMs?: number; now?: () => number }): { stop(): void }`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/contest-clock.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tickContests } from '../src/services/contest-clock.js';
import { createContest, getContest } from '../src/storage/repos/contests.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-clock-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  return { db };
}

it('starts a draft contest at start_at', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000 });
  tickContests(db, 999);
  expect(getContest(db, id)!.status).toBe('draft');
  tickContests(db, 1000);
  expect(getContest(db, id)!.status).toBe('running');
  db.close();
});

it('freezes and ends at the configured times', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000, freezeAt: 3000 });
  tickContests(db, 1000);
  expect(getContest(db, id)!.status).toBe('running');
  tickContests(db, 3000);
  expect(getContest(db, id)!.status).toBe('frozen');
  tickContests(db, 5000);
  expect(getContest(db, id)!.status).toBe('ended');
  db.close();
});

it('unfreezes at unfreeze_at', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000, freezeAt: 3000 });
  db.prepare('UPDATE contests SET unfreeze_at = 4000 WHERE id = ?').run(id);
  tickContests(db, 1000);
  expect(getContest(db, id)!.status).toBe('running');
  tickContests(db, 3000);
  expect(getContest(db, id)!.status).toBe('frozen');
  tickContests(db, 4000);
  expect(getContest(db, id)!.status).toBe('running');
  db.close();
});

it('does not reopen an ended contest', () => {
  const { db } = setup();
  const id = createContest(db, { name: 'C', startAt: 1000, endAt: 5000 });
  db.prepare("UPDATE contests SET status = 'ended' WHERE id = ?").run(id);
  tickContests(db, 6000);
  expect(getContest(db, id)!.status).toBe('ended');
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/tests/contest-clock.test.ts`
Expected: FAIL because `contest-clock` does not exist.

- [ ] **Step 3: Implement the clock**

Create `apps/server/src/services/contest-clock.ts`:

```ts
import type { DatabaseSync } from 'node:sqlite';
import { listContests, setContestStatus } from '../storage/repos/contests.js';

export interface ContestClockTransition {
  contestId: number;
  from: string;
  to: string;
  at: number;
}

export function tickContests(db: DatabaseSync, now = Date.now()): ContestClockTransition[] {
  const transitions: ContestClockTransition[] = [];
  for (const contest of listContests(db)) {
    const from = contest.status;
    let to = from;

    if (from === 'archived' || from === 'ended') continue;

    if (contest.end_at !== null && now >= contest.end_at && from !== 'draft') {
      to = 'ended';
    } else if (from === 'frozen' && contest.unfreeze_at !== null && now >= contest.unfreeze_at) {
      to = 'running';
    } else if (
      from === 'running' &&
      contest.freeze_at !== null &&
      now >= contest.freeze_at &&
      (contest.unfreeze_at === null || now < contest.unfreeze_at)
    ) {
      to = 'frozen';
    } else if (
      from === 'draft' &&
      contest.start_at !== null &&
      now >= contest.start_at &&
      (contest.end_at === null || now < contest.end_at)
    ) {
      to = 'running';
    }

    if (to !== from) {
      setContestStatus(db, contest.id, to);
      transitions.push({ contestId: contest.id, from, to, at: now });
    }
  }
  return transitions;
}

export function startContestClock(
  db: DatabaseSync,
  options: { intervalMs?: number; now?: () => number } = {},
): { stop(): void } {
  const interval = setInterval(() => {
    try {
      tickContests(db, options.now?.() ?? Date.now());
    } catch {
      // clock failures must never crash the server
    }
  }, Math.max(1000, options.intervalMs ?? 5000));
  interval.unref?.();
  return {
    stop() {
      clearInterval(interval);
    },
  };
}
```

- [ ] **Step 4: Start/stop the clock in CLI**

In `apps/server/src/cli.ts`:

```ts
import { startContestClock } from './services/contest-clock.js';
```

After `const scheduler = startScheduler(...)` add:

```ts
const contestClock = startContestClock(db);
```

In `shutdown()` before `scheduler.stop()` add:

```ts
contestClock.stop();
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run apps/server/tests/contest-clock.test.ts apps/server/tests/contests.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/services/contest-clock.ts apps/server/src/cli.ts apps/server/tests/contest-clock.test.ts
git commit -m "feat: auto-transition contests by server clock"
```

---

### Task 3: HTTP-level access tests and docs note

**Files:**
- Modify: `apps/server/tests/contest-access.test.ts`
- Modify: `docs/help/README.md` (only if a new error code page is referenced)

- [ ] **Step 1: Add an HTTP test for 403**

Add to `apps/server/tests/contest-access.test.ts`:

```ts
import Fastify from 'fastify';
import { registerSubmissionRoutes } from '../src/http/submissions.js';
import { serializeSessionCookie } from '../src/security/auth.js';
import { signSession } from '../src/security/session.js';
```

Then:

```ts
it('returns 403 for a non-participant over HTTP', async () => {
  const ctx = setup();
  const contestId = createContest(ctx.db, {
    name: 'C', startAt: 1000, endAt: 2000, problemIds: [ctx.p1],
  });
  const app = Fastify();
  registerSubmissionRoutes(app, { db: ctx.db, config: ctx.config });
  const token = signSession(
    { userId: ctx.bob, version: 0 },
    ctx.config.sessionSecret,
    ctx.config.sessionTtlSec,
  );
  const res = await app.inject({
    method: 'POST',
    url: '/api/submissions',
    headers: { cookie: serializeSessionCookie(token, ctx.config.sessionTtlSec) },
    payload: { problemId: ctx.p1, contestId, language: 'cpp17', code: 'int main(){return 0;}' },
  });
  expect(res.statusCode).toBe(403);
  expect(res.json().error.code).toBe('NOT_PARTICIPANT');
  await app.close();
  ctx.db.close();
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run apps/server/tests/contest-access.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/tests/contest-access.test.ts docs/help/README.md
git commit -m "test: cover contest access over HTTP"
```

---

## Self-Review

- [x] 未报名、未开赛、非本赛题、pending、archived 均有测试。
- [x] 赛后订正仅参赛者可提交，phase 为 correction。
- [x] batch_draft 不受影响（`input.phase` 已提供时跳过 gate）。
- [x] 自动开始/封榜/解封/结束使用显式 `now`，不依赖 sleep。
- [x] 定时器失败不会崩溃服务。
- [x] 没有前端改动；榜单统一/WS delta 留给下一个计划。
