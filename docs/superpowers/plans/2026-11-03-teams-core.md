# Teams Core v1.2 Plan (Task A)

**Goal:** 用户可以创建多个常驻团队、邀请成员、转让队长、退出/解散；为后续比赛团队报名与团队榜提供数据模型/API。

**Decisions（来自问卷）：**
- 一个用户可加入多个常驻团队；同一比赛只能代表一队。
- 用户自建 + 队长邀请；队长可转让/踢人；管理员可解散。
- 暂不做公开加入/邀请链接；邀请由队长按用户名添加。

## Global Constraints

- 不新增依赖。
- 团队名唯一、2~40 字符；用户必须存在且 active。
- 队长自动成为成员；团队至少保留 1 名队长。
- 删除团队级联删除成员关系；不删除用户。
- 只有队长/管理员能加人/踢人/转让/解散；普通成员只能退出。
- 所有团队 API 需登录（列表/详情可登录后看）；管理员解散写审计。

---

### Task A1: DB + repo + service

**Files:**
- Modify: `apps/server/src/storage/migrate.ts`
- Create: `apps/server/src/storage/repos/teams.ts`
- Create: `apps/server/src/services/teams.ts`
- Create: `apps/server/tests/teams.test.ts`

Schema:
```sql
CREATE TABLE IF NOT EXISTS teams(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members(
  team_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(team_id, user_id),
  FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
```

Service API:
```ts
createTeam(db, {name, ownerId, now?}): number
listTeamsForUser(db, userId): TeamDto[]
getTeam(db, teamId): TeamDetail | null
addTeamMember(db, {teamId, actorId, username, now?}): void
removeTeamMember(db, {teamId, actorId, userId, now?}): void
leaveTeam(db, teamId, userId): void
transferCaptain(db, {teamId, actorId, userId}): void
dissolveTeam(db, {teamId, actorId, isAdmin}): void
```
Rules:
- create: trim name, 2..40, unique -> 409 TEAM_NAME_TAKEN; owner member role captain.
- add: actor captain/admin; target user exists active; not already member; 404/409.
- remove: actor captain/admin; cannot remove last captain; if removing self captain, require transfer first? Simpler: captain cannot remove self; use leave/transfer.
- leave: non-captain only; captain must transfer or dissolve.
- transfer: actor captain/admin; target must be member; updates roles transactionally.
- dissolve: owner or admin; delete team (cascade).
- Admin check via service param `isAdmin`.

- [ ] Tests: create/duplicate; add/remove; member leave; captain leave rejected; transfer; dissolve; admin dissolve; multi-team membership.

### Task A2: HTTP API

**Files:**
- Create: `apps/server/src/http/teams.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/tests/teams-http.test.ts`

Routes:
- `GET /api/teams` (auth) -> teams of current user
- `GET /api/teams/:id` (auth) -> detail with members
- `POST /api/teams` {name}
- `POST /api/teams/:id/members` {username}
- `DELETE /api/teams/:id/members/:userId`
- `POST /api/teams/:id/leave`
- `POST /api/teams/:id/transfer` {userId}
- `DELETE /api/teams/:id`
- Error codes: TEAM_NOT_FOUND 404, TEAM_FORBIDDEN 403, TEAM_NAME_TAKEN 409, TEAM_MEMBER_EXISTS 409, TEAM_CAPTAIN_LAST 409, USER_NOT_FOUND 404.
- Admin can dissolve any team; use `request.user.role === 'admin'`.

- [ ] HTTP tests with cookies.

### Task A3: Frontend minimal teams page

**Files:**
- Create: `apps/web/src/pages/TeamsPage.tsx`
- Create: `apps/web/src/pages/TeamDetailPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/api/types.ts`
- Styles: `apps/web/src/styles/teams.css`

- `/teams`: 我的团队列表 + 创建团队。
- `/teams/:id`: 成员、队长、添加成员（用户名）、踢人、转让、退出/解散（按权限）。
- Nav item “团队” for logged-in users.
- Empty/loading/error states.
- `web:typecheck` + `web:build`.

## Acceptance

- 一个用户可创建/加入多个团队。
- 队长可加人/踢人/转让；普通成员可退出；队长不能直接退出。
- 管理员可解散任意团队。
- 团队名重复、无权限、最后队长等错误有明确 code。
- 不影响现有比赛/提交/榜单。
