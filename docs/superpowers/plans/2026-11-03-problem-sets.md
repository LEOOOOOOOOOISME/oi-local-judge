# Problem Sets + Sharing Plan

**Goal:** 用户可以创建个人题单或团队题单；支持私有/公开；可授权给用户/团队（只读/可编辑）；为“个人/团队/公共/分享”题单提供 ACL。

**Decisions：**
- 题单 owner 是个人或团队；团队题单由队长管理，成员可读。
- 公开题单所有人可读；私有题单仅 owner/成员/被授权者。
- 授权权限：`read` / `edit`；`edit` 可改题单内容和顺序，但不能删除题单/管理授权（owner/队长专属）。
- 题单项只允许引用当前可见题目；隐藏题只有管理员/题单 owner 可加入（先做基础校验）。

## Global Constraints

- 不新增依赖。
- 旧题库不受影响；题单是新增表。
- 不修改题目本身的 visibility/所有权（下一轮）。
- 所有 ACL 在服务层；HTTP 只传 actor。
- 团队权限用现有 `team_members`（captain/member）。

---

### Task A: Schema + repo + service/ACL

**Files:**
- Modify: `apps/server/src/storage/migrate.ts`
- Create: `apps/server/src/storage/repos/problem-sets.ts`
- Create: `apps/server/src/services/problem-sets.ts`
- Create: `apps/server/tests/problem-sets.test.ts`

Schema:
```sql
CREATE TABLE problem_sets(
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_type TEXT NOT NULL,      -- user | team
  owner_id INTEGER NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'private', -- private | public
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE problem_set_items(
  set_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY(set_id, problem_id)
);
CREATE TABLE problem_set_shares(
  set_id INTEGER NOT NULL,
  grantee_type TEXT NOT NULL,    -- user | team
  grantee_id INTEGER NOT NULL,
  permission TEXT NOT NULL,      -- read | edit
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(set_id, grantee_type, grantee_id)
);
```

Service:
```ts
createProblemSet(db,{title,description,ownerType,ownerId,visibility,actorId,now?}): number
listProblemSets(db,{userId,includePublic?}): ProblemSetSummary[]
getProblemSet(db,setId,userId,isAdmin): ProblemSetDetail | null
updateProblemSet(db,{setId,actorId,isAdmin,patch}): void
deleteProblemSet(db,{setId,actorId,isAdmin}): void
addProblemSetItem(db,{setId,problemId,actorId,isAdmin,now?}): void
removeProblemSetItem(db,{setId,problemId,actorId,isAdmin}): void
reorderProblemSetItems(db,{setId,problemIds,actorId,isAdmin}): void
addProblemSetShare(db,{setId,granteeType,granteeId,permission,actorId,isAdmin}): void
removeProblemSetShare(db,{setId,granteeType,granteeId,actorId,isAdmin}): void
```
ACL:
- owner user -> owner can edit/delete/share.
- owner team -> captain can edit/delete/share; member read.
- public -> read.
- share user/team -> read/edit.
- admin -> all.
- `edit` share cannot share/delete.

Errors: SET_NOT_FOUND 404, SET_FORBIDDEN 403, SET_TITLE_INVALID 400, SET_ITEM_EXISTS 409, SET_ITEM_NOT_FOUND 404, SET_OWNER_INVALID 400, SET_SHARE_INVALID 400.

Tests: personal CRUD/public read/private denied/share read/edit/team captain/member/public/delete/share removal/admin/duplicate item.

### Task B: HTTP API

- `GET /api/problem-sets` (auth; own+team+public+shared)
- `GET /api/problem-sets/:id`
- `POST /api/problem-sets`
- `PUT /api/problem-sets/:id`
- `DELETE /api/problem-sets/:id`
- `POST /api/problem-sets/:id/items` {problemId}
- `DELETE /api/problem-sets/:id/items/:problemId`
- `PUT /api/problem-sets/:id/items` {problemIds}
- `POST /api/problem-sets/:id/shares` {granteeType,granteeId,permission}
- `DELETE /api/problem-sets/:id/shares/:granteeType/:granteeId`
- Tests HTTP.

### Task C: Frontend

- `/problem-sets` 列表/创建；`/problem-sets/:id` 详情/编辑/题目管理/分享。
- 团队详情增加“题单”Tab（团队题单）。
- 导航“题单”。
- 只读/编辑/分享权限按 API 返回 `canEdit/canManage`。
- `web:typecheck` + `web:build`.

## Acceptance

- 私有题单只有 owner/成员/被授权者可见。
- 公开题单所有登录用户可读。
- 团队题单队长可编辑，成员可读。
- 分享 read/edit 生效；edit 不能删除/再分享。
- 题单顺序可调整。
