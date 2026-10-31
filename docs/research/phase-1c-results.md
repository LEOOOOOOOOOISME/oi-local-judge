# Phase 1C 评测补全与前端优化结果

日期：2026-10-31
分支：`main`
范围：文件 IO、SPJ、子任务依赖、编译/特判缓存、比赛详情接口、前端懒加载

## 后端

| 能力 | 实现 | 验证 |
|---|---|---|
| 文件 IO 题 | `ioMode='file'` + `inputFile/outputFile`；运行时把输入放进工作目录，读取输出文件；缺文件判 WA | `judge-features.test.ts`：AC / 缺输出文件 WA |
| testlib SPJ | problem.json `checker.mode='testlib'` + checker 源码；导入时复制到 `problems/<id>/src/`；评测按点调用 checker | 部分分 `quitp(0.5)` → PC 50/100；AC 100 |
| Lemon 六参数 SPJ | `checker.mode='lemon'` 复用 Phase 0 wrapper | Phase 0 测试；pipeline 已接入 |
| 比较模式 | `exact` / `ignore-trailing`（默认）/ `ignore-all` / `float` / `case-insensitive` | `compare.test.ts` 4 例 |
| 子任务依赖 | `problem_testcases.depends_on`；前驱未 AC 则 SK | `judge-features.test.ts`：第二点 SK |
| 编译缓存 | `cache/programs/<sha256>/prog.exe`，键含源码/语言/编译器/flags | `compile-cache.test.ts`：第二次命中 |
| 特判缓存 | `cache/checkers/<sha256>/checker.exe`，testlib 非静态链接 | SPJ 第二提交复用，测试耗时从 18s 降到 ~10s |
| 比赛详情 | `GET /api/contests/:id`：contest + problems（含 points/tags/limits）+ participantCount | `contests.test.ts`；生产 curl 验证 |
| 静态缓存头 | `/assets/*` immutable 1y；HTML no-cache | 静态托管验证 |
| 数据库索引 | submissions(problem_id,id)、(user_id,id)、testcases(problem_id,ordinal) | 迁移测试 |

约束补充：testlib `quitp` 的分数是 **0..1 比例**，传入 `fullScore=测试点分值` 时换算为绝对分（已修 checker 并加测试）。

## 前端

- `ContestOverviewPage` 优先使用比赛详情接口展示题目与分值，ranking 只用于个人得分/Top3；详情 500 时自动回退旧逻辑（Playwright 验证）。
- 路由懒加载：Contests/Problems/Problem/ContestOverview/ContestRanking/SubmissionDetail/Records；AppShell 用 Suspense 包裹 Outlet，不白屏。
- manualChunks：react / router / query / antd 分包。
- **首屏 JS：264.35KB gzip**（antd 183.67 + react 46.44 + router 14.12 + query 10.41 + index 9.71），达到 ≤300KB 目标；全部 20 个 chunk 合计 370.40KB gzip；CSS gzip 4.33KB。
- Playwright Edge headless 25/25 检查通过：登录→比赛→详情（分值列/满分/参赛人数）→题目→提交→AC 详情→记录→榜单；0 pageerror/console.error；1366×768 无横向溢出。
- 生产静态托管（Fastify `@fastify/static`）下 `tools/e2e-prod-smoke.mjs` 通过。

## 测试

- 全量：**17 个测试文件、65 个用例全部通过**（约 21s）。
- E2E：A+B AC 100；文件 IO/SPJ/SK/缓存/榜单均有覆盖。
- 生产冒烟：`/`、SPA fallback、assets 200；`GET /api/contests/1` 返回 points=100、tags。

## 仍未完成

1. 前端无管理后台（题库导入/建赛/选手管理/重测），目前依赖 API/seed。
2. 文件 IO 只支持单文件；多文件题/提交答案题未做。
3. SPJ 首次编译约 7–10s（之后缓存）；可在导入题包时预编译。
4. 交互题、客观题、班级统计 UI、大屏/导出、社区未做。
5. 登录限流、CSRF、审计日志未做；Electron 壳待目标机验证。
6. 懒加载共享块命名 `PageHead-*.js`（含共享 antd），仅首次进入懒加载页时加载；可后续改名/细分。

## 关键文件

- `apps/server/src/judge/{pipeline,checker-cache,compile-cache,compiler,checker}.ts`
- `apps/server/src/services/{problems,contests}.ts`
- `apps/server/src/http/contests.ts`
- `apps/web/src/App.tsx`、`apps/web/src/pages/ContestOverviewPage.tsx`、`apps/web/vite.config.ts`
- `tests/fixtures/problems/{file-io,spj-testlib}/`
