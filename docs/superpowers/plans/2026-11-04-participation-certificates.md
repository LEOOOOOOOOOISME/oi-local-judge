# Participation Certificates Plan

**Goal:** 奖项页可切换“包含参赛证书”，为所有正式榜选手生成 participation 证书；金/银/铜奖保持不变；团队奖同步支持。

## Design

- `AwardLevel` 增加 `'participation'`。
- `getContestAwards(..., {includeParticipation?: boolean})`：
  - 默认 false，行为不变。
  - true：未获金银铜的正式榜行设为 `award='participation'`。
  - `counts` 增加 `participation`。
- `getTeamContestAwards` 同样支持（团队参赛证书）。
- API：
  - `GET /api/contests/:id/awards?scope=team&participation=1`
  - admin 同样。
  - `participation=1/true` 解析；非法值忽略/400 选择并测试。
- 前端：
  - 奖项页“包含参赛证书”开关；query key 含 participation。
  - 表格“参赛”标签；打印证书按钮可用；证书标题“参赛证书”。
  - CSV 含所有行。
  - 团队切换同样生效。
- 测试：默认不变、include 后所有行有奖、counts、团队 scope、未获奖证书号、CSV/工具。

## Files

- `apps/server/src/services/awards.ts`
- `apps/server/src/http/contests.ts`
- `apps/server/tests/awards.test.ts`
- `apps/web/src/api/types.ts`
- `apps/web/src/pages/ContestAwardsPage.tsx`
- `apps/web/src/components/AwardCertificate.tsx`
- `apps/web/src/utils/awards.ts` + test

## Verify

- 目标 vitest、server tsc、web typecheck/build、全量 npm test
- commit `feat: add participation certificates`
