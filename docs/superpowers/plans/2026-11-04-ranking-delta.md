# Ranking Delta Plan

**Goal:** 判题完成后通过 WebSocket 推送 `ranking.delta`：变化行 + 全部名次映射 + 移除用户；前端合并本地榜单缓存，避免整榜重取。

## Design

- `official-ranking.ts`:
  - `OfficialRankingResult` 增加 `version`（缓存条目版本）。
  - `getOfficialRanking` 缓存条目含 version；`invalidateOfficialRanking` 递增版本。
  - 新增纯函数 `diffOfficialRanking(prev, next): RankingDelta | null`：
    - `changed`: 行 JSON 变化的完整行；
    - `ranks`: 所有 `{userId, rank}`（名次可能整体移动）；
    - `removed`: 上一版有、当前没有的 userId；
    - `version: next.version`。
- `pipeline.ts`:
  - 将现有 `judgeSubmission` 主体改名 `judgeSubmissionInternal`。
  - 新 `judgeSubmission` 在开始前取 `before`（若 contestId），在 finally 中取 `after`，diff 后发布 `ranking.delta` 到 `contest:<id>` + 管理员。
  - 只有在有差异时发布。
- `realtime/hub` 已支持 room；payload 走事件。
- 前端 `useRealtime`:
  - 处理 `ranking.delta`：`setQueryData(['official-ranking', contestId])` 合并：
    - 更新 ranks、替换 changed、删除 removed、按 rank 排序。
    - 若缓存不存在 → invalidate。
  - 保留 250ms debounce 的 submission.updated 逻辑；ranking.delta 不触发整榜 invalidate。
- 测试：
  - diff：无变化 null、单行变化、名次变化、移除。
  - pipeline 发布 delta（fake events + 一个提交）。
  - 前端 merge 纯函数测试。

## Files

- `apps/server/src/services/official-ranking.ts`
- `apps/server/src/judge/pipeline.ts`
- `apps/server/tests/ranking-delta.test.ts`
- `apps/web/src/hooks/useRealtime.ts`
- `apps/web/src/utils/rankingDelta.ts` + test
- `apps/web/src/api/types.ts`

## Verify

- 目标 vitest、server tsc、web typecheck/build、全量 npm test
- commit `feat: push ranking deltas over websocket`
