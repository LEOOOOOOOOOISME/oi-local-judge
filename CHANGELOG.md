# Changelog

## 1.0.0-alpha.1 — 2026-11-01

OiJudge Alpha 1.0：首个可运行的局域网 OI 比赛闭环版本。

### 核心功能

- Electron + Fastify + React 架构，Windows 本地部署
- 登录/退出/开放注册、角色权限、登录与注册限流、审计日志
- 传统题、文件 IO、交互题、客观题、提交答案题
- testlib / Lemon SPJ、子任务与依赖、编译/checker 缓存
- Windows Job Object 沙箱与 `ojinteract.exe` 交互执行器
- 比赛创建、组卷、公告、答疑、封榜/解封、归档
- OI / IOI / ACM / CF-like 正式榜
- 正式分表与在线提交同步，解封回填，冻结期回填
- 比赛批量正式导入：代码与 `answers.json`、三种发布模式
- 参赛名单 CSV、隐藏/恢复、锁题记录与管理员解锁
- 赛后独立订正榜：每题 `max(官方分, 赛后最高分)`
- Hack：锁题/源码/Hack 目标、validator/std/checker、HACKED 重算
- Hack 窗口、官方冻结、CF Hack 加减分、审计、强制晋升、撤销
- Markdown + LaTeX + 安全 HTML 题面/公告渲染
- 排名规则配置与编译后排名插件
- 管理端题目/资产/数据/用户/比赛/社区/审计
- Markdown + LaTeX 题面，XSS 白名单清洗

### 性能基准（开发机）

- 50 提交评测：约 3.08s，16.2 提交/秒
- 50 个不同源码编译：约 5.70s，约 9 个/秒
- 300 并发 × 30 轮正式榜请求：0 错误，约 2200 请求/秒，P95 约 126ms

### 验证

- 全量测试：131/131 通过
- `npm run build` 通过

### 已知限制

- Electron GUI 尚未在普通桌面/目标机完成验证；当前开发会话中 Electron 无法启动
- 真实 4 核 8G、300 在线长时间稳定性尚未最终验收
- 备份/恢复、HTTPS、完整诊断中心、回收站等仍待后续版本
- 交互题为自定义 argv/stdin/stdout 协议，testlib `registerInteraction` 兼容待完善
- Python3 评测尚未接入

### 安装

```powershell
npm install --ignore-scripts --cache .npm-cache
npm run build:native
npm run build
npm run seed
npm start
```
