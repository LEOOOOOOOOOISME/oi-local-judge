# OI Local Judge

Windows 局域网 OI 评测系统：桌面程序（Electron）+ 浏览器选手端，支持比赛模式、Special Judge、交互题、子任务、客观题组卷、榜单与数据分析。

> 状态：Phase 0 技术验证完成；Phase 1A 后端闭环与 Phase 1B Web 前端 MVP 已完成（Electron 壳在开发沙箱中无法启动，待目标机复验）。

## 文档

- [需求规格 requirement.txt](requirement.txt)：功能需求（180+ 条）、性能指标、红队推演、三期路线图
- [技术设计](docs/superpowers/specs/2026-10-31-oi-judge-design.md)：进程拓扑、模块边界、评测/沙箱、数据模型、性能与安全设计
- [Phase 0 结果](docs/research/phase-0-results.md)：runner / SPJ / SQLite / 微基准
- [Phase 1A 结果](docs/research/phase-1a-results.md)：认证、题库、评测、榜单、E2E
- [Phase 1B 结果](docs/research/phase-1b-web-results.md)：Web 页面、构建与 Playwright 验证
- [前人实现调研](docs/research/prior-art.md)：Lemon/Hydro/UOJ/testlib 的可复用性与许可证结论

## 快速开始（Windows）

```powershell
npm install --ignore-scripts --cache .npm-cache
node tools/build-runner.mjs
npm run build
npm run seed          # 默认数据目录 %LOCALAPPDATA%\OiJudge，可设 OIJ_DATA_DIR
npm start             # http://127.0.0.1:8787
```

默认管理员 `admin / admin123`（首次启动自动创建，生产环境请用 `OIJ_ADMIN_PASSWORD` 覆盖并改密）。
当前可用：登录、题库、题目页、C++17 提交、评测（TLE/MLE/RE/CE/WA/AC）、提交详情、比赛列表/主页/榜单、我的记录。
评测依赖本机 `ojrunner.exe`（`tools/build-runner.mjs`）与 GCC 16；未配置编译器时评测会报 SE。

## 目标能力

- 单机 / 机房 / 局域网托管三种形态，选手用浏览器访问
- 传统题、文件 IO、交互题、提交答案题、客观题（单选/多选/判断/填空）
- testlib 与 Lemon 六参数双模式 SPJ、子任务聚合
- OI / IOI / ACM / 自定义赛制，封榜、补时、动态改题、班级统计
- 洛谷式信息架构：题库、题目页、评测记录、个人中心、讨论/题解/答疑/私信
- Windows Job Object 工程级沙箱；性能按 4 核 8G、300 在线、50 并发提交设计

## 技术栈

Electron + React + TypeScript + Vite + Ant Design；Fastify + SQLite(WAL)；C++17 原生 `ojrunner.exe`（MinGW GCC 16 构建）；testlib.h（MIT）。

## 开发环境

- Node.js 24+
- MinGW-W64 GCC 16（自动探测，或设置 `OIJ_GXX`）
- CMake 3.20+
- Windows 10/11 x64

## Roadmap

- Phase 0：技术验证（Electron+SQLite、Job Object runner、testlib SPJ、Fastify+WS、微基准）
- Phase 1：账号、题库、评测内核、比赛、榜单、班级统计、交互题、性能门禁
- Phase 2：榜单大屏/导出/奖项、社区、批量评测、出题工具链、客观题
- Phase 3：交互进阶、强沙箱后端、虚拟赛/团队赛、通知、PDF、深色/多语言

## 许可证

待定。第三方组件（testlib.h 等）的许可证与声明在引入时保留。
