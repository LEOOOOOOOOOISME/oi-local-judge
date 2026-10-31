# Phase 1A 后端闭环结果

日期：2026-10-31
分支：`phase-0-tech-validation`
范围：认证 → 题库 → 提交 → 编译/沙箱 → 比较 → 结果 → 榜单（无前端）

## 已完成

| 模块 | 实现 | 验证 |
|---|---|---|
| 共享层 | DTO（User/Problem/Submission/Ranking）、OI 榜单纯函数 | 3 个单测 |
| 配置 | `loadConfig`、`detectGxx`（WinLibs 16.1）、数据目录初始化 | 迁移测试 |
| 数据库 | `node:sqlite` + WAL + 迁移（users/problems/testcases/subtasks/submissions/test_results/judge_tasks/contests） | 幂等迁移 + 仓储往返 |
| 认证 | scrypt（`scrypt$...`）、HMAC 会话 Cookie（`oij.sid`）、`requireAuth`/`requireRole`、角色权限表 | 21 个单测 |
| 题库 | 目录导入（problem.json + data）、题面 Markdown→HTML、按题读取 | 2 个单测 |
| 提交 | 源码落盘、语言/大小校验、judge_tasks、记录/详情、代码返回 | 2 个单测 |
| 评测 | 编译（g++ -O2 -std=c++17 -static）、Job Object runner、内置比较、子任务聚合、CE/TLE/MLE/RE/WA/AC、状态流转 `queued→compiling→running→finished` | 3 个单测 |
| 调度 | 100ms 轮询、`judgeConcurrency` 并发、claim 事务、stop 等待 | 调度器全链路 |
| 比赛/榜单 | 建赛/参赛者/榜单、封榜截止时间、班级字段返回 | 1 个单测 |
| API | auth/problems/contests/submissions + WS 鉴权与 `hello`/`ping` | 4 个 health/WS 测试 |
| E2E | 登录→拉题→提交 AC→轮询完成→详情/榜单 | 1 个 E2E（1.4s） |

## 实测

- 全量测试：`13` 个测试文件、`55` 个用例全部通过（含 Phase 0 runner/checker）。
- E2E：A+B 提交 AC 100，2 个测试点；提交详情含源码与结果；榜单总分 100。
- 开发服务器 smoke（`tools/dev-smoke.mjs`）：login 200、problems 1、submit 201、finished/AC/100、ranking 1 行。
- AC 单次评测（编译 + 2 点）：约 0.4–0.5s；调度器 WA+TLE+CE 并发 2：约 6s（TLE 占 3s×2）。

## 变更与偏差

- SQLite 使用 Node 24 内置 `node:sqlite`（Phase 0 决策）；`@oij/shared` 改为 `dist` 导出，构建顺序：shared → server → desktop。
- 新增 `submissions.message`（CE/失败原因）、`updateStatus` 中间态；CE 编译输出已能落库（截断 512 字符）。
- 题包数据存 `problems/<id>/data/`，DB 路径为 `problems/<id>/data/xxx`（修复过一版 `data/xxx` 解析错误）。
- 评测临时目录在 `dataDir/tmp`；E2E 因原生子进程对 `%TEMP%` 的写入限制，测试数据目录放在仓库 `native/runner/out/e2e-*`。

## 未完成 / Phase 1B+

1. 静态前端与 SPA fallback 尚未接入（等 `apps/web/dist`）。
2. 文件 IO 题、SPJ 接入、子任务 `depends_on/SK`、OLE/PE 未接（Phase 1B/2）。
3. 登录限流、CSRF、审计日志、HTTPS 未做。
4. 评测中间态与事件已写，但前端 WS 刷新未验证。
5. 常驻 runner / 编译缓存未做；当前每点 spawn，端到端约 43ms。

## 运行方式

```bash
npm run build          # shared + server + desktop
npm run seed           # 默认 %LOCALAPPDATA%\OiJudge；或设 OIJ_DATA_DIR
npm start              # 8787
node tools/dev-smoke.mjs  # 需 OIJ_PORT=8790 且服务已启动
```
