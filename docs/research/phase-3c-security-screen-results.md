# Phase 3C 安全加固、比赛大屏与审计结果

日期：2026-11-01
分支：`main`

## 安全

- 登录失败限流：同一 IP + 用户名 10 分钟内 5 次失败后返回 429（`TOO_MANY_ATTEMPTS`，Retry-After 600）；成功登录清除失败计数。
- 审计日志表 `audit_logs`：登录成功/失败、所有 `POST/PUT/PATCH/DELETE /api/admin/*` 自动记录（actor/action/status/ip）。
- `GET /api/admin/audit?limit=`（仅 admin）返回最近日志；UI `/admin/audit` 表格 + 详情 JSON 展开。
- 现有安全基线保持：HMAC 签名 HttpOnly Cookie、SameSite=Lax、scrypt 密码、session_version 失效、角色权限、社区内存限流、Markdown `html:false` 渲染。

## 比赛大屏

- `/contest/:id/screen`：独立深色全屏（不加载 AppShell），无需登录。
- 显示比赛名/状态/封榜中/倒计时或当前时间；榜单排名/选手/班级/总分/各题/罚时；Top 20/50/全部。
- 比赛详情 + 榜单 5s 轮询；比赛页“大屏”入口。
- 罚时按“最后一次 AC 相对开赛的分钟数”计算（OI 榜单无独立罚时字段），无 AC 显示 —，大屏 footer 注明。

## 榜单 CSV

- ContestRankingPage“导出 CSV”：排名/选手/班级/总分/各题/罚时，UTF-8 BOM，文件名 `contest-<id>-ranking.csv`。

## 验证

- 新增 `security.test.ts`：5 次失败登录 → 429；审计记录登录失败/成功/管理员创建题。
- 全量：**25 个测试文件、86 个用例全部通过**（约 48s）。
- Edge headless（8790 直出 dist）23 项检查 PASS：
  - 大屏深色背景、无导航、封榜中、3 行、5s 轮询、Top 切换、1366 无溢出；
  - 审计页显示 auth.login 与管理操作，详情展开；
  - CSV 下载表头与行内容正确；
  - 0 pageerror、0 console.error。
- 截图：`.devdata/tmp/screens-3c/01-screen.png`、`02-ranking.png`、`03-audit.png`。

## 遗留

1. 审计中间件只记录 action/status/ip，不解析 targetType/targetId，目标列多为 —。
2. 审计页无分页/筛选/导出；日志无保留期清理。
3. 登录限流为进程内存桶，重启清零；多实例不共享。
4. 大屏为 5s HTTP 轮询（未接 WebSocket）；Top 行数差异未用 >20 行数据实测。
5. CSRF 依赖 SameSite=Lax + JSON Content-Type，未单独发 token。
