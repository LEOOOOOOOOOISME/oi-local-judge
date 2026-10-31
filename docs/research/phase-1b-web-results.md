# Phase 1B Web 前端结果

日期：2026-10-31
分支：`phase-0-tech-validation`
范围：洛谷式浏览器端 MVP（Electron 壳暂缓）

## 页面

| 路由 | 说明 |
|---|---|
| `/login` | 登录、错误提示、next 回跳、dev 账号提示 |
| `/contests` | 比赛列表（状态/倒计时/赛制） |
| `/contest/:id` | 比赛主页：题目列表、我的得分/提交、倒计时、榜单 Top3 |
| `/contest/:id/ranking` | OI 榜单：排名/选手/总分/通过/每题得分/最后通过、封榜提示 |
| `/contest/:id/problem/:pid` | 题目页：题面、样例、C++17 提交、我的提交 |
| `/problem/:id`、`/problems` | 独立题目页与题库 |
| `/submissions/:id` | 提交详情：verdict/得分/测试点表/源码、pending 自动刷新 |
| `/records` | 我的记录（游标分页、题目筛选） |
| 404 | 兜底页 |

## 技术栈与结构

Vite 7 + React 18 + TypeScript + Ant Design 5 + React Router 7 + TanStack Query 5。
`src/api`（client/types）、`auth`、`hooks`（useRealtime/useNow）、`components`、`pages`、`styles`、`utils` 分层。

## 构建与验证

- `npx tsc --noEmit`：通过。
- `npx vite build`：通过；index 0.80kB、CSS 15.83kB(gzip 4.30)、JS 1,133kB(gzip 358.73)。
- 后端 API 实测：登录/401/提交 A+B → WS `submission.updated` → AC 100（2 点各 50）/详情 code+results/分页/logout 失效。
- Vite dev 代理 5173：`/api`、`/ws` 通过。
- Playwright（系统 Edge headless）dev 21 项、preview 8 项全 PASS；0 pageerror/console.error；1366×768 无横向溢出；截图 `.devdata/tmp/screens/*.png`。
- 生产静态托管（Lead 补充）：Fastify `@fastify/static` 服务 `apps/web/dist`，`/`、SPA fallback `/contest/1`、`/assets/*` 均 200；`tools/e2e-prod-smoke.mjs` 用 Edge headless 验证登录/比赛页/题目可见/无横向溢出。

## 已知限制

1. 后端比赛详情接口缺失：比赛页题目列表从 ranking 的 `problems` 推导；0 参赛者时无法列出题目，也拿不到每题满分。建议补 `GET /api/contests/:id`。
2. `/api/contests` 返回 snake_case 原始行；前端按 start/end 计算展示状态。
3. WS 仅终态推送；提交详情对非终态用 1.5s 轮询兜底。
4. 单 JS chunk gzip 358.7KB，在 400KB 预算内但接近上限；未做路由懒加载；编辑器为 textarea（Monaco 留待后续）。
5. 无 Electron 壳；生产由 Fastify 直接托管 dist。Electron 在本机 DSH 会话中启动崩溃（0xC0000005），需目标机复验。

## 启动

```powershell
# 根目录
npm install --ignore-scripts --cache .npm-cache
node tools/build-runner.mjs
npm run build
npm run seed
npm start                 # http://127.0.0.1:8787
```

开发模式：

```powershell
$env:OIJ_PORT='8790'; $env:OIJ_DATA_DIR='D:\Documents\ai-powered-study\oi-local-judge\.devdata'; node apps/server/dist/cli.js
npm run web:dev           # http://127.0.0.1:5173
```
