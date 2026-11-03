# Contest Registration + Check-in Plan

**Goal:** 比赛支持 `manual / open / approval` 报名模式；选手自助报名/取消；管理员审核、签到；监考视图查看签到与提交情况。

**Decisions：**
- 复用 `contest_participants`：`status accepted/pending/rejected` 已存在。
- 默认 `registration_mode='manual'`，保持旧比赛“管理员导入”行为。
- `open`：报名即 accepted；`approval`：pending，管理员审核。
- 报名在比赛结束前可操作；管理员可随时改状态/签到。
- 只有 accepted 参与者能提交/进榜；pending/rejected 不可提交。
- 签到独立于参赛状态；只有 accepted 可签到。
- 不涉及团队报名（已有 contest_teams）；团队报名后续与个人报名合并。

## Global Constraints

- 不新增依赖。
- 旧 `contest_participants` 行默认 accepted、无签到时间，兼容。
- `getParticipants`/`isContestParticipant` 必须只认 accepted。
- 管理员手动加人仍为 accepted。
- 报名/审核/签到写审计（管理员操作）。

---

### Task A: Backend

**Files:**
- Modify: `apps/server/src/storage/migrate.ts`
- Modify: `apps/server/src/storage/repos/contests.ts`
- Create: `apps/server/src/storage/repos/contest-registrations.ts`
- Create: `apps/server/src/services/contest-registrations.ts`
- Modify: `apps/server/src/services/contest-access.ts`
- Modify: `apps/server/src/http/contests.ts`
- Modify: `apps/server/src/http/admin-contests.ts` or new `admin-registrations.ts`
- Modify: `apps/server/src/http/admin-contest-batch.ts` (contest create/update mode)
- Create: `apps/server/tests/contest-registrations.test.ts`

Schema:
```sql
ALTER contests ADD registration_mode TEXT NOT NULL DEFAULT 'manual';
ALTER contest_participants ADD registered_at INTEGER;
ALTER contest_participants ADD checked_in_at INTEGER;
ALTER contest_participants ADD reviewed_at INTEGER;
ALTER contest_participants ADD reviewed_by INTEGER;
```

Service:
```ts
type RegistrationMode = 'manual'|'open'|'approval';
registerForContest(db,{contestId,userId,now?}): 'accepted'|'pending'
cancelRegistration(db,{contestId,userId}): void
reviewRegistration(db,{contestId,userId,action:'approve'|'reject',actorId,now?}): void
checkInParticipant(db,{contestId,userId,actorId,now?}): void
getMyRegistration(db,contestId,userId): RegistrationDto | null
listRegistrations(db,contestId): RegistrationDto[] // include submissions count/lastAt
```
Rules:
- contest should exist; mode manual -> 403 REGISTRATION_DISABLED.
- duplicate row: if pending -> 409 ALREADY_REGISTERED; if accepted -> 409; rejected can re-register? allow update to pending/accepted.
- open -> accepted; approval -> pending; set registered_at.
- cancel only pending; accepted cancel? allow only before contest start? Keep pending only.
- review: participant must be pending; approve -> accepted; reject -> rejected; set reviewed_*.
- check-in: participant accepted; set checked_in_at if null; idempotent.
- accepted rows count as participants; status filter in getParticipants/isContestParticipant/getVisibleParticipants.
- create contest accepts registrationMode; update too.
- Admin list includes username/realName/className/status/registeredAt/checkedInAt/reviewedAt/submissionCount/lastSubmissionAt.
- Audit admin review/check-in.

API:
- `GET /api/contests/:id/registration` auth -> {mode, registration}
- `POST /api/contests/:id/register`
- `DELETE /api/contests/:id/register`
- `GET /api/admin/contests/:id/registrations`
- `POST /api/admin/contests/:id/registrations/:userId/approve`
- `.../reject`
- `.../check-in`
- Contest create/update `registrationMode`.

Tests:
- open auto accepted; approval pending; manual 403; duplicate 409; cancel; approve/reject; check-in accepted only; pending cannot submit; rejected cannot submit; getParticipants only accepted; admin list stats.

### Task B: UI

- Contest create/console: `registrationMode` select.
- ContestOverview: my registration status; 报名/取消 button; pending hint; manual hidden.
- Admin console: 报名管理 table (user/status/registered/check-in/submissions/last), approve/reject/check-in buttons, filter pending.
- Proctor summary: accepted/checked-in counts.
- Types + build.

## Acceptance

- open 报名立即参赛；approval 需审核；manual 仅管理员导入。
- pending/rejected 不能提交/进榜。
- 管理员可审核/签到；签到只对 accepted。
- 监考表能看到签到与最后提交。
