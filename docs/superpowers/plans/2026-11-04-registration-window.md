# Registration Window + Self-Cancel Plan

**Goal:** 比赛可设置报名开始/截止；开放/审核报名只在窗口内可用；已通过（accepted）的选手在比赛开始前可自助取消。

## Design

- `contests.registration_open_at` / `registration_close_at`（可空）。
- `registerForContest`：
  - 当前时间 < open_at -> 403 `REGISTRATION_NOT_OPEN`
  - 当前时间 > close_at -> 403 `REGISTRATION_CLOSED`
  - 空值不限制。
- `cancelRegistration`：
  - pending 可取消（原有）。
  - accepted 可取消，仅当比赛尚未开始（`start_at` 为空或 now < start_at）且未结束。
  - accepted 在 running/ended -> 409 `CANNOT_CANCEL`。
- 管理员导入/审核不受窗口限制；审核仍可批准 pending。
- Contest create/update 接受 `registrationOpenAt` / `registrationCloseAt`（epoch ms 或 null）；校验 open < close。
- 前端：
  - 新建/控制台报名设置增加开始/截止时间。
  - 比赛页展示报名窗口；未开始/已截止文案。
  - accepted 在可取消时显示“取消报名”。
- 测试：窗口外 403、窗口内可报名、accepted 开赛前可取消、开赛后 409、管理员审核不受限、非法时间 400。

## Files

- `apps/server/src/storage/migrate.ts`
- `apps/server/src/storage/repos/contests.ts`
- `apps/server/src/services/contest-registrations.ts`
- `apps/server/src/http/contests.ts`、`admin-contest-batch.ts`
- `apps/web/src/api/types.ts`
- `apps/web/src/pages/AdminContestsPage.tsx`、`AdminContestConsolePage.tsx`、`ContestOverviewPage.tsx`
- `apps/server/tests/contest-registrations.test.ts`（扩展）
- `apps/web/src/utils/registration.ts` + test

## Verify

- 目标测试
- server tsc / web typecheck / web build
- 全量 npm test
- commit `feat: add registration window and accepted self-cancel`
