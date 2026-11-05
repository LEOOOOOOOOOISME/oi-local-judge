# Judge Lifecycle v1.1 Plan

**Goal:** 补上提交冷却、崩溃恢复、管理员重测、OLE 判定，减少真实比赛中的卡死与误判。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md` 第 1/3 节；`requirement.txt` FR-JDG-005/006/007/024/037。

## Global Constraints

- 不改评分公式与沙箱强度。
- 一题一任务：`judge_tasks.submission_id` 唯一；重测必须复用/重置该任务。
- 冷却只限制普通 `POST /api/submissions`；管理员重测不受冷却。
- 恢复只处理 `running/compiling` 的遗留任务；不重跑已完成。
- 不新增依赖。

---

### Task A: Cooldown + startup recovery

**Files:**
- Modify: `apps/server/src/storage/repos/submissions.ts`
- Modify: `apps/server/src/storage/repos/judge.ts`
- Modify: `apps/server/src/services/submissions.ts`
- Modify: `apps/server/src/http/submissions.ts`
- Modify: `apps/server/src/cli.ts`
- Create: `apps/server/tests/judge-lifecycle.test.ts`

**Interfaces:**
- `class SubmissionRateLimitError extends Error { status=429; code='SUBMIT_COOLDOWN'; retryAfterSec }`
- `getLatestSubmissionAt(db, userId, problemId, contestId): number | null`
- `recoverInterruptedJudgeTasks(db, now?): number` sets `judge_tasks.status='queued', worker=NULL` where status in ('running','compiling'); sets submissions `status='queued'` for those tasks.
- `submitSource` checks 10s cooldown unless `input.skipCooldown` (internal rejudge/batch).

- [ ] Add latest submission query; check cooldown after access gate and before writing files.
- [ ] HTTP maps `SubmissionRateLimitError` to 429 + `Retry-After`.
- [ ] `recoverInterruptedJudgeTasks` called in `cli.ts` before `startScheduler`.
- [ ] Tests: two quick submits -> 429; after 10s (inject now) -> allowed; recovery moves running to queued; completed untouched.
- [ ] Commit `feat: add submission cooldown and judge recovery`.

---

### Task B: Rejudge API + OLE

**Files:**
- Modify: `apps/server/src/storage/repos/submissions.ts`
- Modify: `apps/server/src/storage/repos/judge.ts`
- Modify: `apps/server/src/judge/pipeline.ts`
- Modify: `apps/server/src/http/submissions.ts` or new `apps/server/src/http/admin-judge.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/tests/rejudge.test.ts`

**Interfaces:**
- `resetSubmissionForRejudge(db, submissionId): void` sets status='queued', verdict/score/time/memory null/0, judged_at=null; deletes test_results.
- `enqueueRejudge(db, submissionId, priority=100): void` updates existing judge_task to queued or inserts.
- `POST /api/admin/submissions/:id/rejudge` admin/setter/contestmanager.
- `POST /api/admin/contests/:id/rejudge` body `{ statuses?: string[] }` batch (optional; if time, single only).
- OLE: in `judgeTestcase`, after run if `run.stdoutBytes > problem.output_mb * 1024 * 1024` -> verdict OLE, message.

- [ ] Add reset/enqueue helpers; rejudge route.
- [ ] Add OLE check before TLE/RE decision (or after run).
- [ ] Tests: finished submission -> rejudge -> queued task; old results cleared; rejudge by non-admin 403; OLE case with tiny output limit.
- [ ] Commit `feat: add rejudge and output limit verdict`.

---

### Task C: UI (optional P1)

- Submission detail admin button “重测”; contest console batch rejudge.
- Show 429 cooldown toast with remaining seconds.
- Run web build.

## Acceptance

- 同用户同题 10s 内第二次提交 429。
- 进程强杀后重启，running/compiling 任务回 queued 并继续。
- 管理员可重测，任务不会重复。
- 输出超限判 OLE。
