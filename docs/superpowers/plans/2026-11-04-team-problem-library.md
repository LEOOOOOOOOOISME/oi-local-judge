# Team Problem Library Plan

**Goal:** 团队详情页展示团队拥有的题目；队员可进入题目，权限沿用题目 ACL；不改变题目编辑权限（仍走管理端/owner）。

## Design

- `ProblemSummaryDto` 增加 `ownerType: 'system'|'user'|'team'`、`ownerId: number|null`。
- `problemToSummary` 填充 owner。
- 前端 `ProblemSummary` 类型增加可选 ownerType/ownerId。
- TeamDetailPage 新增“题目”Tab：
  - 查询 `/api/problems`（已按 ACL 过滤）。
  - 过滤 `ownerType==='team' && ownerId===teamId`。
  - 列表：标题/类型/难度/时间/内存；点击进入 `/problems/:id`。
  - 空状态。
- 不新增 API；不改变 ACL；不改变题目创建/编辑入口。
- 测试：problemToSummary owner 字段；前端 teamProblems 纯函数过滤。

## Verify

- 目标 vitest、server tsc、web typecheck/build、全量 npm test
- commit `feat: add team problem library tab`
