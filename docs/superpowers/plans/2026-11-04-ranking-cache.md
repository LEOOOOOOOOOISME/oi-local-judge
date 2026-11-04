# Official Ranking Cache Plan

**Goal:** 正式榜在 1 秒内最终一致的前提下缓存，避免每次请求重算 300 人；提交完成/官方分变更/比赛状态变更时精确失效。

## Design

- `official-ranking.ts`:
  - 原实现改名 `computeOfficialRanking`（保留导出，便于测试）。
  - 新增 `getOfficialRanking` 包装：
    - `WeakMap<DatabaseSync, Map<contestId, {dataDir, expiresAt, promise}>>`
    - TTL 1000ms（`OIJ_RANKING_CACHE_MS` 可覆盖，测试可传 now）。
    - 并发同 key 复用 promise，避免击穿。
  - `invalidateOfficialRanking(db, contestId?)` 清缓存。
- 失效点：
  - judge finish/fail（`pipeline.persistJudged`/`markSubmissionFailed`）后。
  - 官方分 seed/update、hack 生效、freeze/unfreeze/end、participant 变更。
  - 简单做法：pipeline 调 invalidate；比赛服务变更也调。
- TTL 保底；显式失效立即生效。
- 测试：
  - 同 contest 两次调用复用；不同 contest 隔离；
  - invalidate 后重新计算；
  - TTL 过期重算；
  - 并发调用只计算一次；
  - 原有 official-ranking 测试全过。

## Files

- `apps/server/src/services/official-ranking.ts`
- `apps/server/src/judge/pipeline.ts`
- `apps/server/src/services/contests.ts`
- `apps/server/src/services/official-scores.ts`（如有）
- `apps/server/tests/official-ranking-cache.test.ts`

## Verify

- `npx vitest run apps/server/tests/official-ranking-cache.test.ts apps/server/tests/official-ranking.test.ts`
- `npx tsc -p apps/server/tsconfig.json --noEmit`
- full `npm test`
- commit `perf: cache official ranking with precise invalidation`
