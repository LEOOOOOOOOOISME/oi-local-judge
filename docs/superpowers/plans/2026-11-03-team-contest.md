# Team Contest Integration Plan

**Goal:** 比赛支持 `individual / team / both` 三种报名模式；团队可报名；团队模式下提交自动归属团队；为团队榜提供数据。

**Decisions：**
- 一个用户可加入多个常驻团队；同一比赛只能代表一队。
- 队长可为本队报名；管理员可代报名/移除。
- 默认 `individual`，不改变现有比赛。
- 团队分默认：每题取团队成员最高分后求和（OI/IOI）；ACM 后续按团队过题并集+罚时。
- 个人单独参赛视为 1 人团队（团队榜也显示）。

## Global Constraints

- 不新增依赖。
- 旧比赛/旧提交兼容：`team_mode` 默认 individual，`submissions.team_id` 默认 NULL。
- 团队报名必须校验：比赛存在、团队存在、用户是队长或管理员、团队成员未代表其他队报名同一比赛。
- 团队模式为 `team` 时，未报名团队的用户提交 403 `TEAM_REQUIRED`。
- `both` 模式：已报名团队的用户自动归属团队；未报名则按个人提交（team_id NULL）。
- 只允许 `individual` 模式之外报名团队。

---

### Task A: Schema + registration + submission attribution

**Files:**
- Modify: `apps/server/src/storage/migrate.ts`
- Modify: `apps/server/src/storage/repos/contests.ts`
- Create: `apps/server/src/storage/repos/contest-teams.ts`
- Create: `apps/server/src/services/contest-teams.ts`
- Modify: `apps/server/src/services/submissions.ts`
- Modify: `apps/server/src/http/contests.ts` (team registration routes)
- Modify: `apps/server/src/http/admin-contest-batch.ts` or new admin team routes
- Create: `apps/server/tests/contest-teams.test.ts`

Schema:
```sql
ALTER contests ADD team_mode TEXT NOT NULL DEFAULT 'individual';
CREATE TABLE contest_teams(
  contest_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  registered_by INTEGER,
  registered_at INTEGER NOT NULL,
  PRIMARY KEY(contest_id, team_id)
);
ALTER submissions ADD team_id INTEGER;
```

Service:
```ts
registerTeamForContest(db,{contestId,teamId,actorId,isAdmin,now?}): void
removeTeamFromContest(db,{contestId,teamId,actorId,isAdmin}): void
listContestTeams(db, contestId): TeamRegistrationDto[]
resolveSubmissionTeam(db,{contestId,userId,requestedTeamId?}): number | null
```
Rules:
- register: contest.team_mode !== individual; team exists; actor captain or admin; team members not already in another registered team for contest; insert.
- remove: admin/contestmanager; delete registration; existing submissions keep team_id.
- resolve: individual -> null; team -> find registered team containing user, else throw `TEAM_REQUIRED`; both -> same but null if none; if requestedTeamId provided, validate membership/registration.
- `submitSource` uses resolved teamId, stores `submissions.team_id`; batch/answer internal submissions team_id null unless contest team? Batch can use explicit teamId later; default null.

API:
- `POST /api/contests/:id/teams` {teamId} (auth, captain)
- `GET /api/contests/:id/teams` (auth; members/admin)
- `DELETE /api/admin/contests/:id/teams/:teamId` (admin/contestmanager)
- `POST /api/admin/contests/:id/teams` {teamId} (admin/contestmanager)
- Contest create/update accepts `teamMode`.

Tests:
- contest mode defaults individual; update team/both.
- captain registers; admin registers; non-captain 403; duplicate 409; member conflict 409.
- team mode submission auto team_id; unregistered 403; both unregistered null; individual null.
- remove registration.

### Task B: Team ranking + API

- `apps/server/src/services/team-ranking.ts`
- `GET /api/contests/:id/team-ranking`
- aggregate best per member per problem -> team best; sum; rank; cells.
- tests: two teams; max across members; hacked excluded; freeze respected; individual as team of one (not registered? maybe not in team ranking).

### Task C: UI

- Admin contest console: teamMode select; team registration card (add by team ID/name, remove).
- Contest page: show team registration button for captain; team ranking link/tab.
- Ranking page: individual/team toggle if team_mode.
- Types + build.

## Acceptance

- Existing individual contests unchanged.
- Team contest: captain registers; member submits with team_id; team ranking aggregates best scores.
- Unregistered team-only submission rejected.
- Admin can register/remove teams.
