# Ranking Single Source + Realtime Plan

**Goal:** 比赛页/正式榜/班级统计使用同一份正式榜数据；提交完成后只通知对应比赛的页面刷新，而不是全站广播。

**Architecture:** 正式榜仍由 `getOfficialRanking` 计算；比赛页与班级统计改用它。WebSocket 增加 `contest:<id>` 房间，judge 完成事件带 `room`；前端按当前 URL 的 contestId 订阅并只失效该比赛相关 query。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md` 第 1/3/4 节。

## Global Constraints

- 不改比赛规则/计分公式。
- `/api/contests/:id/ranking` 保留兼容，不删除。
- WS 事件必须继续对 admin 可见。
- 不新增依赖。
- 前端只更新查询键，不整页刷新。

---

### Task A: Backend official source + contest room

**Files:**
- Modify: `apps/server/src/services/contests.ts`
- Modify: `apps/server/src/http/contests.ts`
- Modify: `apps/server/src/realtime/hub.ts` (only if room typing needs it)
- Modify: `apps/server/src/judge/pipeline.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/tests/contest-room.test.ts` (or extend existing)

**Interfaces:**
- `getClassStats(db, contestId): Promise<ClassStatRow[] | null>` uses `getOfficialRanking`.
- `hub` events already support `room?: string`.
- `publishUpdate(events, data, room?)`; `EventPublisher.publish({type,data,room?})`.
- `/ws?contestId=<id>` subscribes `contest:<id>` in addition to user/admin rooms.

- [ ] `getClassStats` async + official rows; route `await getClassStats`.
- [ ] `/ws` parse `contestId` query; invalid integer ignored; subscribe room.
- [ ] `publishUpdate` derive contestId from `getSubmission(db, submissionId)?.contest_id`; add room `contest:<id>`; keep data including `submissionId`.
- [ ] `markSubmissionFailed` same.
- [ ] Test hub room isolation: user room vs contest room vs admin.
- [ ] Run targeted + `npx tsc`.
- [ ] Commit `feat: unify class stats and add contest ws room`.

---

### Task B: Frontend official ranking + scoped realtime

**Files:**
- Modify: `apps/web/src/pages/ContestOverviewPage.tsx`
- Modify: `apps/web/src/pages/ProblemPage.tsx`
- Modify: `apps/web/src/hooks/useRealtime.ts`
- Maybe `apps/web/src/utils/officialRanking.ts`

- [ ] ContestOverview uses `fetchOfficialRanking`, rows from `data.rows`; top3 and my rank use official fields.
- [ ] ProblemPage uses official ranking for problem letter/index; replace `row.problems` with `row.cells`.
- [ ] `useRealtime` parse `contestId` from `window.location.pathname` (`/contest/:id`), connect `/ws?contestId=...`; invalidate `['official-ranking', contestId]`, `['contest-detail', contestId]`, `['class-stats', contestId]`, `['submissions']`; debounce 250ms.
- [ ] Keep reconnect/heartbeat behavior.
- [ ] Run `npm run web:typecheck && npm run web:build`.
- [ ] Commit `feat: use official ranking on contest pages`.

---

## Acceptance

- 比赛页、正式榜、班级统计同一分数。
- 提交完成后，当前比赛榜 1s 内更新；其他比赛不刷新。
- 300 在线压测另做；本轮只保证逻辑。
