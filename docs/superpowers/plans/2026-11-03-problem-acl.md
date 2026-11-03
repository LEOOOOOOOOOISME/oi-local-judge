# Problem Ownership + ACL Plan

**Goal:** 题目支持个人/团队/系统所有权，支持私有/公开和用户/团队授权分享；读取/练习提交按 ACL 校验。

**Decisions：**
- `problems.owner_type`: `system | user | team`；旧题默认 `system`。
- `visibility`: 保留 `public | hidden`；`public` 所有人可读，`hidden` 仅 owner/团队成员/被授权者/admin 可读。
- 团队题：队长可编辑/分享，成员可读；个人题：owner 可编辑/分享。
- 分享权限 `read | edit`；`edit` 可改题面/数据/资产，但不能删除/改所有权/再分享。
- 管理员全权；setter 仍按现有 admin 路由权限，不因 ACL 降权（后续再收紧）。
- 练习提交必须 `canViewProblem`；比赛提交走比赛 ACL。

## Global Constraints

- 不新增依赖。
- 旧题/旧提交兼容：owner_type 默认 system，visibility 默认 public。
- 不改变现有题包导入导出格式；导入题 owner=system。
- 所有 ACL 在服务层；HTTP 只传 actor。
- 隐藏题在公开列表/详情必须 404，不泄露存在性。

---

### Task A: Schema + repo + ACL service

**Files:**
- Modify: `apps/server/src/storage/migrate.ts`
- Create: `apps/server/src/storage/repos/problem-shares.ts`
- Create: `apps/server/src/services/problem-acl.ts`
- Modify: `apps/server/src/storage/repos/problems.ts`
- Modify: `apps/server/src/services/problems.ts`
- Create: `apps/server/tests/problem-acl.test.ts`

Schema:
```sql
ALTER problems ADD owner_type TEXT NOT NULL DEFAULT 'system';
ALTER problems ADD owner_id INTEGER;
CREATE TABLE problem_shares(
  problem_id INTEGER NOT NULL,
  grantee_type TEXT NOT NULL, -- user | team
  grantee_id INTEGER NOT NULL,
  permission TEXT NOT NULL,   -- read | edit
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(problem_id, grantee_type, grantee_id)
);
```

Service:
```ts
export interface ProblemActor { userId?: number; isAdmin?: boolean }
export function canViewProblem(db, problem, actor): boolean
export function canEditProblem(db, problem, actor): boolean
export function canManageProblemShares(db, problem, actor): boolean
export function listVisibleProblems(db, actor): ProblemRow[]
export function addProblemShare(db,{problemId,granteeType,granteeId,permission,actorId,isAdmin}): void
export function removeProblemShare(...)
export function listProblemShares(db, problemId): ProblemShareDto[]
```
Rules:
- system + public -> view all; system + hidden -> admin only.
- user owner -> owner view/edit; public view all; share read view; share edit view+edit.
- team owner -> captain edit, member view; share.
- admin all.
- `canManageShares`: owner/captain/admin only; edit share cannot share.
- `listVisibleProblems`: public + owned + team + shares; dedupe; excludes hidden for others.
- Creating problem: add `ownerType/ownerId` to create/update input; default system? For admin-created via UI, set user creator. Imported/seed remains system.
- Existing `getProblemDetail` etc no ACL; HTTP will gate.

Tests: system public/hidden, user public/private, team captain/member, share read/edit, no-share 404, list dedupe, admin.

### Task B: HTTP read ACL + shares

**Files:**
- Modify: `apps/server/src/http/problems.ts` (optional auth, canView)
- Modify: `apps/server/src/http/admin-problems.ts` (create/update owner)
- Create: `apps/server/src/http/problem-shares.ts` (or add to admin-problems)
- Modify: `apps/server/src/services/submissions.ts` (practice canView)
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/tests/problem-acl-http.test.ts`

Routes:
- `GET /api/problems` optional auth -> visible list.
- `GET /api/problems/:id` optional auth -> 404 if cannot view.
- `GET /api/problems/:id/answer-files` same.
- `GET /api/problems/:id/shares` (manage only)
- `POST /api/problems/:id/shares`
- `DELETE /api/problems/:id/shares/:granteeType/:granteeId`
- Admin create/update accepts `ownerType`/`ownerId`; default user creator for setter/admin-created? Keep system for import/seed; UI sends user.
- Practice submission: if no contestId, canView required; contest submissions bypass practice check but contest ACL handles.

Tests: hidden 404, owner 200, share 200, public 200, practice submit 403/201, share manage permissions.

### Task C: UI

- Admin problem page: owner display, share management (user/team + read/edit).
- Problem page/list respects ACL (no hidden).
- Optional owner selector on create (个人/团队); team list.
- `web:typecheck/build`.

## Acceptance

- hidden/system problem not visible to contestant.
- user-owned public problem visible; private only owner/share/team.
- team-owned problem captain edit, member read.
- read/edit shares enforced.
- practice submission blocked without view.
- admin routes unchanged for now.
