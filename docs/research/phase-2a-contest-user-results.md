# Phase 2A 比赛/用户/班级管理结果

日期：2026-11-01
分支：`main`
范围：比赛管理控制台、参赛者、班级统计、用户管理与 CSV 导入

## 后端

| 能力 | API |
|---|---|
| 比赛创建 | `POST /api/admin/contests`（名称/赛制/时间/题目/参赛者） |
| 比赛更新 | `PUT /api/admin/contests/:id`（名称/赛制/起止/封榜/题目分值） |
| 状态控制 | `POST /api/admin/contests/:id/start|freeze|unfreeze|end` |
| 参赛者 | `GET/POST /api/admin/contests/:id/participants`、`DELETE .../:userId` |
| 班级统计 | `GET /api/admin/contests/:id/class-stats`（人数/总分/均分/AC 人数/最好名次） |
| 用户列表/新建 | `GET /api/admin/users?query=&class=`、`POST /api/admin/users` |
| 用户 CSV 导入 | `POST /api/admin/users/import` {csv,defaultPassword}；跳过重复、逐行报错 |

- 封榜会写入 `freeze_at`，解封写入 `unfreeze_at`；班级统计基于 OI 榜单按 `class_name` 聚合。
- 权限：admin/contestmanager 可管理比赛/用户；admin/setter 管理题目/资产。

## 前端

- `/admin/contests`：比赛列表 + 新建 Drawer（赛制/时间/题目多选/参赛者多选）。
- `/admin/contests/:id`：基本信息编辑、逐题分值、开始/封榜/解封/结束、参赛者增删、班级统计表、公开页/榜单链接。
- `/admin/users`：搜索、班级筛选、新建用户（用户名/密码/姓名/班级/角色）；CSV 导入接口已具备（UI 可后续补按钮）。
- 新增 `ContestAdminRoute`：admin/contestmanager 才可进入；其余 403。
- 懒加载 chunk：比赛列表 2.19KB、控制台 3.62KB、用户页 2.06KB（gzip）。

## 实测

- 后端：`admin-contests.test.ts` 3 例（创建/更新/开始封榜解封结束/参赛者/班级统计/用户列表与 CSV 导入）。
- 全量：**21 个测试文件、76 个用例全部通过**（约 49s；Vitest maxWorkers=4）。
- Edge headless（8790 直出 dist）32 项检查全 PASS：
  - 用户新建 3 人、搜索/班级筛选；
  - 新建比赛 → 控制台改名/改时间/分值 120 → 开始/封榜/解封/结束；
  - 参赛者 2→3→2→3，班级统计 1→2→1→2 行；
  - 0 pageerror、0 console.error、1366×768 无横向溢出。
- 截图：`.devdata/tmp/screens-2a/01…07*.png`。

## 遗留

1. 比赛/用户列表无分页，用户上限 500；班级筛选用自由文本。
2. 用户无编辑/删除/重置密码 UI；比赛无删除；参赛者 extra_time 未编辑。
3. 时间输入为原生 `datetime-local`（分钟精度、浏览器本地时区）。
4. 客观题、交互题、社区、题解/讨论、大屏、批量账号导入 UI 尚未做。
5. 状态控制按钮做了前端流转约束，后端未强制状态机校验（可直接调用 API 跳转）。
