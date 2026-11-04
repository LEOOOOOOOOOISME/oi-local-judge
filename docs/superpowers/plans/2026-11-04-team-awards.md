# Team Awards Plan

**Goal:** 团队比赛可按团队榜生成团队奖项（金/银/铜）与团队证书；个人奖继续保留。

## Design

- 奖项配置复用 `award_config_json` 百分比。
- 新增 `getTeamContestAwards(db, contestId, dataDir)`：
  - 使用 `getTeamRanking` 的 rows（已报名团队）。
  - 按团队名次计算金/银/铜阈值（同一 `computeAwardCounts`）。
  - `certificateNo = T{contestId}-{teamId}`。
  - 返回 `{contest, config, rows, counts, scope:'team'}`。
- 个人奖保持 `getContestAwards`，返回 `scope:'individual'`。
- API：
  - `GET /api/contests/:id/awards?scope=team`
  - `GET /api/admin/contests/:id/awards?scope=team`
  - 默认 scope=individual。
  - 比赛未结束 gate 保持。
- 前端：
  - ContestAwardsPage：team_mode !== individual 时显示“个人奖/团队奖”切换。
  - 团队表：名次/团队/成员数/总分/AC/奖项/证书编号。
  - 团队证书：团队名 + 成员数 + 名次 + 奖项；打印。
  - CSV 团队列。
  - Admin 奖项配置预览仍个人；可加团队预览入口。
- 测试：
  - 团队奖默认比例/并列/零团队；
  - 未报名团队不出现；
  - 团队证书编号；个人/团队 scope 隔离；
  - 未结束 403；
  - HTTP scope。
- 不新增依赖；不改个人奖语义。

## Files

- `apps/server/src/services/awards.ts`
- `apps/server/src/http/contests.ts`
- `apps/server/tests/awards.test.ts`（扩展）
- `apps/web/src/api/types.ts`
- `apps/web/src/pages/ContestAwardsPage.tsx`
- `apps/web/src/components/AwardCertificate.tsx`
- `apps/web/src/utils/awards.ts` + tests

## Verify

- 目标 vitest + server tsc + web typecheck/build
- 全量 npm test
- commit `feat: add team awards and certificates`
