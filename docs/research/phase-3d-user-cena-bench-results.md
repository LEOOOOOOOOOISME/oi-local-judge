# Phase 3D 用户管理、Cena 题包与性能基准

日期：2026-11-01
分支：`main`

## 用户管理

- 后端：
  - `PUT /api/admin/users/:id`（姓名/班级；admin 额外角色/状态；禁止自我锁死；改角色/状态递增 session_version）
  - `POST /api/admin/users/:id/reset-password`（≥4 位，重置后递增 session_version）
  - `POST /api/admin/users/import`（CSV：username,password,realName,className,role；跳过重复、逐行错误）
- 前端 `/admin/users`：
  - 行操作编辑/重置密码/停用启用；admin 可改角色/状态，contestmanager 仅姓名/班级
  - 批量导入 Modal（CSV + 默认密码 + 新建/跳过/错误摘要）

## Cena 题包

- `importCenaProblem`：识别 `data/` 或根目录的 `.in/.out`（含 `.ans`）配对，读取 `std.cpp/checker.cpp/maker.cpp`、`problem.md/txt`；生成临时 `problem.json` 后复用标准导入，自动落库资产与测试点。
- `POST /api/admin/problems/import-zip`：无 `problem.json` 时自动尝试 Cena 格式，返回 `format: 'cena'|'oij'`。
- `GET /api/admin/problems/:id/export-cena`：导出 `data/*.in|out`、`std.cpp`、`checker.cpp`、`maker.cpp`。
- 前端题目页提供“导出 OI 题包”“导出 Cena 题包”两个按钮。

## 验证

- 后端新增 `cena.test.ts`（2 组 .in/.out + std.cpp + problem.md 导入）。
- 全量：**26 个测试文件、87 个用例全部通过**（约 49s）。
- Edge headless（8790 直出 dist）17 项检查 PASS：
  - CSV 导入 1 新建/1 跳过/1 错误；编辑姓名/班级；重置密码后登录；停用/启用；
  - contestmanager 只能改姓名/班级；
  - OI zip 含 problem.json/assets/data；Cena zip 含 data/std.cpp/maker.cpp；
  - 0 pageerror/console.error，1366×768 无横向溢出。
- 截图：`.devdata/tmp/screens-3d/01…05*.png`。

## 性能基准（`npm run bench`）

| 基准 | 结果 |
|---|---|
| SQLite 插入 | 20 行 0.018ms（min 0.017 / max 0.371） |
| SQLite 读取 | 4000 行 0.031ms |
| 榜单计算 | 500 行 0.387ms，序列化 35.1KB |
| runner 端到端 | 中位 43.18ms（runner 15ms；min 38.71 / max 259.06） |

结论：数据库/榜单远低于 50 并发提交的瓶颈；评测主要成本为编译（缓存后消失）与进程启动（~15ms/点）。首屏 JS gzip 约 268KB，管理端/大屏/审计均懒加载。

## 遗留

1. CSV 为简单逗号分割，不支持引号字段；role 仅识别 admin/setter，其余按 contestant。
2. 停用用户后既有会话由 session_version 失效（未单独 E2E 停用登录）。
3. Cena 导入不解析 checker 协议（checker 作为资产保留，默认仍 builtin 比较）；不导入 Cena 子任务/测试点分值配置。
4. Cena 导出仅含已有资产；无 checker 时不生成 checker.cpp；客观题/空数据未验证。
5. 未做 Lemon `.cdf` 原生格式解析。
6. 未做 50 并发提交的端到端压测；当前 bench 为单点基准。
