# Team ACM Ranking Fix

**Goal:** 团队榜按比赛赛制计算：OI/IOI 保持每题最高分求和；ACM 使用团队过题并集 + 罚时；CF-like 使用共享 CF 计分。

## Design

- `getTeamRanking`：
  - 将 `contest.mode` 映射为 `RankingPreset`。
  - 传入 `contestStartAt`/`contestEndAt`、`config.cfLike`（从 `ranking_rule_json`）。
  - `submissions` 仍以 team_id 作为 userId，computeRanking 在 ACM 下天然计算团队并集/罚时。
  - 保留 freeze_at 过滤。
- `TeamRankingRow` 增加 `penalty`（和需要时的 `hackScore`），API 返回。
- 前端团队榜列：
  - ACM/CF-like 显示 solved/penalty；
  - OI/IOI 显示 totalScore。
- 测试：
  - 两个成员各过不同题 -> solved=2；
  - 同一题多次错误后另一成员 AC -> 罚时按团队 attempts；
  - 重复 AC 不重复计；
  - OI 团队仍按最高分求和；
  - 未报名团队不出现。
- 不改个人榜。

## Files

- `apps/server/src/services/team-ranking.ts`
- `apps/server/tests/team-ranking.test.ts`
- `apps/web/src/api/types.ts`
- `apps/web/src/pages/ContestRankingPage.tsx`
- `apps/web/src/utils/teamContest.ts`（如需要）

## Verify

- 目标 vitest、server tsc、web typecheck/build、全量 npm test
- commit `fix: score ACM team rankings by solve union and penalty`
