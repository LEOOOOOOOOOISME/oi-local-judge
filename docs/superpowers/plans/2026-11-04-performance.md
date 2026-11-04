# 4C/8G Acceptance Harness Plan

**Goal:** 提供可复用的 300 在线 + 50 并发 HTTP 压测工具，输出 p50/p95、错误率、内存、判定吞吐；先在开发机跑基线，4C/8G 目标机跑正式验收。

**Decisions：**
- 不新增依赖；用 Node fetch + tsx。
- 压测进程内启动真实 `buildApp` + SQLite + scheduler；不 mock。
- 300 用户登录态用 cookie；50 并发提交真实走 `/api/submissions`。
- 默认 60s 在线阶段 + 提交阶段；4C/8G 正式验收可 `OIJ_BENCH_DURATION=7200`（2h）。
- 不把 4C/8G 目标写死为已验证；报告必须写明机器 CPU/RAM。

## Task A: Harness

**Files:**
- Create `tools/bench/online.mjs`
- Modify `package.json`: `"bench:online": "tsx tools/bench/online.mjs"`
- Create `docs/help/maintenance/performance.md`

Requirements:
1. Parse env:
   - `OIJ_BENCH_USERS` default 300
   - `OIJ_BENCH_CONCURRENCY` default 50
   - `OIJ_BENCH_DURATION` seconds default 60
   - `OIJ_BENCH_SUBMISSIONS` default 50
2. Temp data dir + file DB; seed:
   - 1 admin + N users (same password hash reused; create sessions/cookies directly if possible)
   - import `tools/seed/sample-problem`
   - create running contest with start/end/freeze; add problem; add all users as accepted participants
3. Start app on port 0; get address.
4. Online phase: 300 users concurrently GET:
   - `/api/contests/:id/official-ranking`
   - `/api/contests/:id`
   - `/api/contests/:id/team-ranking` (maybe)
   round-robin; measure latency/errors.
5. Submission phase: 50 concurrent POST `/api/submissions` with valid source; use separate users; measure accepted/429/5xx; wait for queue drain or max.
6. Output JSON:
   ```json
   { users, concurrency, durationSec, requests, errors, p50Ms, p95Ms, p99Ms, rps, memoryRssMb, queue, submissions:{accepted,rateLimited,failed}, judgingThroughputPerSec }
   ```
7. Exit nonzero on error > threshold (e.g. 1% 5xx) or missing health.
8. Clean temp dir, close app/db/scheduler.
9. Handle 429 gracefully (cooldown; use different users).
10. `docs/help/maintenance/performance.md`: how to run, 4C/8G procedure, interpretation, not a guarantee.

## Verify

```bash
npx tsx tools/bench/online.mjs
```

- On dev machine, run with default 300/50/60; report actual.
- `npm test` still passes (no product changes).
- Commit `feat: add online concurrency benchmark`.
