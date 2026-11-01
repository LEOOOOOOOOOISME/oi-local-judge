# OiJudge

> 版本：**v1.0.0-alpha.1（Alpha 1.0）**

Windows 局域网 OI 评测系统：Electron 桌面程序内置 HTTP/WS 服务，选手通过浏览器参赛；覆盖题目、评测、比赛、正式榜、批量导入、赛后订正、CF 风格 Hack、社区与审计的完整闭环。

---

## 界面预览

> 以下为本地演示数据截图。

| 正式榜 | 赛后订正榜 |
|---|---|
| <img src="docs/assets/screenshots/03-official-ranking.png" width="100%" alt="正式榜" /> | <img src="docs/assets/screenshots/04-correction.png" width="100%" alt="订正榜" /> |

| 批量导入预览 | Hack 审计 |
|---|---|
| <img src="docs/assets/screenshots/05-batch-preview.png" width="100%" alt="批量导入预览" /> | <img src="docs/assets/screenshots/06-hack-audit.png" width="100%" alt="Hack 审计" /> |

| 注册 | Markdown / LaTeX 题面 |
|---|---|
| <img src="docs/assets/screenshots/01-register.png" width="100%" alt="注册" /> | <img src="docs/assets/screenshots/02-rich-text.png" width="100%" alt="Markdown 与 LaTeX 题面" /> |

---

## 1. 核心亮点

### 1.1 一场比赛从建题到成绩的完整闭环

- 建题、题面、测试数据、SPJ、子任务、交互题、客观题、提交答案题
- 组卷建赛、参赛名单、公告/答疑、封榜/解封、归档
- 正式榜、班级统计、大屏、CSV 导出
- 赛后独立订正榜
- 完整 Hack 流程与审计

### 1.2 正式分与批量导入统一口径

- 赛中在线提交自动进入 OI 正式分
- 教师收集的代码可通过 zip 批量导入
- 批量导入先落草稿，评测完成后预览，再发布
- 三种发布模式：覆盖 / 合并 / 仅补缺
- 发布事务内完成：写正式分、补报名、草稿提交转正
- 支持代码题和 `answers.json` 客观题/提交答案题
- 正式榜和批量成绩使用同一数据源

### 1.3 完整 CF 风格 Hack

- 锁题后才能查看同题他人源码
- 锁题后本人不能再提交该题
- validator 校验输入
- std 生成期望输出
- 目标程序 + checker 判定
- 成功 Hack 标记目标 `HACKED`，从正式分剔除并重算
- 支持成功/失败 Hack 计分、Hack 窗口、Hack 后官方冻结
- 管理员可强制晋升、撤销 HACKED、审计全部 Hack 记录

### 1.4 可配置排名，不停留在单一 OI 榜

- 预设：OI / IOI / ACM / CF-like
- 并列规则可配置
- CF-like 支持衰减、成功 Hack 加分、失败 Hack 罚分
- 正式榜和订正榜分离
- 管理员可上传编译后的排名插件
- 插件缺失/禁用自动回退 OI，并返回 `pluginError`

### 1.5 Windows 原生工程级沙箱

- `ojrunner.exe` 基于 Windows Job Object
- CPU/墙钟/内存/进程数限制，超时终止进程树
- `ojinteract.exe` 双进程管道，支持交互题
- 独立临时目录、编译缓存、checker 缓存
- 状态覆盖 AC/WA/TLE/MLE/RE/CE/OLE/PE/PC/SK/SE

### 1.6 本地优先、离线可用

- SQLite WAL，数据全部保存在本机
- 默认数据目录为仓库下 `runtime/`，可用 `OIJ_DATA_DIR` 覆盖
- 不依赖公网服务；局域网内浏览器直接访问
- 登录、比赛、评测、榜单、社区均可离线运行

### 1.7 富文本题面与公告

- Markdown 题面/公告
- 行内公式 `$...$`、独立公式 `$$...$$`
- 兼容 `\(...\)`、`\[...\]`
- 安全 HTML 表格/排版
- 服务端统一渲染 + XSS 白名单清洗
- 旧 HTML 题面兼容

### 1.8 性能工程

当前仓库自带基准：

- 50 提交评测：约 **3.08s**，**16.2 提交/秒**
- 50 个不同源码编译：约 **5.70s**，**9 个/秒**
- 300 并发 × 30 轮共 9000 次正式榜请求：**0 错误**，约 **2200 请求/秒**，P95 约 **126ms**

> 以上为开发机短时基准，不等同于真实 4 核 8G 目标机的最终验收。

---

## 2. 功能总览

### 2.1 账号与认证

- 账号密码登录/退出
- **开放自助注册**，默认角色 `contestant`
- HttpOnly + SameSite=Lax Session Cookie
- scrypt 密码哈希
- 登录失败按 IP + 用户名限流
- 注册按 IP 限流
- 角色：`admin` / `setter` / `contestmanager` / `contestant`
- 管理员创建/编辑/停用用户、重置密码
- CSV 用户导入
- 登录与敏感管理操作审计

### 2.2 题库与题目

支持题型：

- 传统题（stdio）
- 文件 IO 题
- 交互题
- 提交答案题（Output-only）
- 客观题：单选/多选/判断/填空

题目能力：

- 难度、标签、时限、内存
- Markdown + LaTeX + 安全 HTML 题面
- 样例、解释
- 测试点、分值、子任务、依赖关系
- 内置比较器、testlib SPJ、Lemon 六参数 SPJ
- 程序资产：std / checker / validator / generator / interactor / judger / brute
- 资产上传、源码查看、编译
- 测试数据 zip 导入
- validator 校验、std 自测、generator 造数据、std/brute 对拍
- OI / Cena / Lemon 题包导入导出

### 2.3 评测内核

- SQLite 持久化评测队列
- 赛中提交优先
- 可配置并发
- 编译缓存、checker 缓存
- 测试点级结果、耗时、内存、得分、SPJ 信息
- 提交详情、编译输出、测试点表
- 子任务聚合与依赖
- 客观题部分给分
- 提交答案题逐点比较
- 评测事件通过 WebSocket 推送

### 2.4 比赛引擎

- 创建/编辑比赛
- 题目顺序与分值
- 参赛者添加/移除
- 名单 CSV 导入
- 参赛者隐藏/恢复
- 开始、封榜、解封、结束、归档
- 参赛者额外时间
- 公告、答疑
- 比赛大屏
- 班级统计
- 比赛删除保护（有提交时拒绝）

### 2.5 正式榜与排名

- `GET /api/contests/:id/official-ranking`
- OI 正式分表 `contest_official_scores`
- 在线提交自动同步正式分
- 封榜期间不更新，解封回填
- 归档冻结
- 管理员可配置排名规则
- 管理员可解除 Hack 后官方冻结
- 正式榜、大屏、CSV 使用同一口径
- 被 Hack 提交从正式榜排除

### 2.6 比赛批量正式导入

支持：

```text
学生/题目/main.cpp
学生/题目/answers.json
```

流程：

1. 上传 zip
2. 选择学生层级/题目层级
3. 自动匹配题目：ID → 标题 → A/B/C/D
4. 生成草稿提交并评测
5. 预览每个格子的「当前正式分 → 发布后分数」
6. 选择覆盖/合并/仅补缺，发布或丢弃

发布结果：

- 写正式分
- 自动补比赛报名
- 草稿提交转为正式提交
- 未注册用户跳过并报告
- 未匹配题目报告
- 发布前不影响正式榜

### 2.7 赛后订正

- 比赛结束后自动开放
- 只有参赛者可提交
- 提交阶段自动标记 `correction`
- 独立订正榜
- 每题取 `max(官方分, 赛后最高分)`
- 正式榜与订正榜分开展示
- 不修改正式分
- 支持 CSV 导出

### 2.8 Hack

- 锁题/源码可见性
- Hack 目标列表
- Hack 输入提交
- validator → std → checker 判定
- HACKED 标记与正式分重算
- Hack 窗口
- Hack 后官方冻结
- 管理员强制晋升
- 管理员撤销 HACKED
- 比赛级 Hack 审计
- 提交列表/详情显示 HACKED
- Hack 次数限流

### 2.9 社区

- 讨论区/题解/公告
- Markdown + LaTeX + 安全 HTML
- 评论
- 题解审核状态
- 比赛答疑
- 私信
- 通知铃铛
- 置顶/锁定/隐藏
- 举报与审核入口

### 2.10 管理端

- 题目/资产/数据管理
- 批量评测
- 比赛控制台
- 参赛者/名单/锁题记录
- 排名规则/插件
- Hack 审计
- 用户管理
- 社区审核
- 审计日志
- 正式分冻结与解除
- 系统健康检查

---

## 3. 技术架构

```text
Electron 桌面壳
  │
  ├── Fastify HTTP/WS 服务
  │     ├── auth / users / contests / problems / submissions
  │     ├── official ranking / correction ranking
  │     ├── contest batch import / roster
  │     ├── hack / audit / freeze
  │     └── community / notifications
  │
  ├── React + Vite + Ant Design Web
  │     ├── 选手端
  │     ├── 管理端
  │     ├── 大屏
  │     └── /help
  │
  ├── SQLite WAL
  │     └── runtime/db/oijudge.db
  │
  └── Native
        ├── ojrunner.exe   Job Object 沙箱
        └── ojinteract.exe 双向管道交互
```

技术栈：

- Electron
- TypeScript
- React 18 + Vite
- Ant Design 5
- TanStack Query
- Fastify 5
- Node.js 24
- `node:sqlite` WAL
- C++17 原生 runner
- testlib.h（MIT）

---

## 4. 快速开始

环境要求：

- Windows 10/11 x64
- Node.js 24+
- MinGW-W64 GCC（支持 C++17）
- CMake 3.20+（构建原生 runner）

```powershell
npm install --ignore-scripts --cache .npm-cache
npm run build:native
npm run build
npm run seed
npm start
```

访问：

```text
http://127.0.0.1:8787
```

默认管理员：

```text
admin / admin123
```

> 生产环境请通过 `OIJ_ADMIN_PASSWORD` 覆盖默认密码，并首次登录后修改。

默认数据目录为仓库下 `runtime/`；所有数据库、题面、提交、缓存都在本机。

---

## 5. 配置

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `OIJ_DATA_DIR` | 数据目录 | 仓库下 `runtime/` |
| `OIJ_PORT` | HTTP 端口 | `8787` |
| `OIJ_HOST` | 监听地址 | `0.0.0.0` |
| `OIJ_ADMIN_PASSWORD` | 初始管理员密码 | `admin123` |
| `OIJ_GXX` | g++ 路径 | 自动探测 |
| `OIJ_JUDGE_CONCURRENCY` | 评测并发 | `min(4, CPU 核数)` |
| `OIJ_RUNNER` | ojrunner 路径 | `native/runner/out/ojrunner.exe` |

---

## 6. 常用命令

```powershell
npm run build          # shared + server + desktop + web
npm start              # 启动服务
npm test               # 全量测试
npm run typecheck      # TypeScript 检查
npm run bench          # 微基准
npm run bench:concurrency  # 50 提交并发基准
npm run bench:compile      # 50 个不同源码编译基准
npm run build:native       # 构建 runner + interact
npm run electron:smoke     # Electron GUI 烟雾测试（需桌面环境）
```

浏览器验收常用尺寸：1366×768、1280×720。

---

## 7. 主要数据与目录

```text
runtime/
  db/oijudge.db          # SQLite
  problems/              # 题面、数据、资产
  submissions/           # 提交源码与结果
  cache/                 # 编译/checker 缓存
  tmp/                   # 评测临时目录
  plugins/               # 排名插件
  hacks/                 # Hack 输入
```

---

## 8. 当前限制

- Electron GUI 尚未在普通桌面/目标机完成验证；当前开发会话无法启动 Electron。
- 真实 4 核 8G、300 在线长时间稳定性尚未完成最终验收；现有为短时压测。
- 备份/恢复、HTTPS、完整系统诊断中心、回收站等 P1/P2 需求仍在路线图中。
- 交互题当前是自定义 argv/stdin/stdout 协议，testlib `registerInteraction` 完整兼容尚未完成。
- Python3 评测尚未接入。
- 代码查重按需求明确不做；仅预留源码导出方向。

---

## 9. 文档

- [需求规格](requirement.txt)
- [技术设计](docs/superpowers/specs/2026-10-31-oi-judge-design.md)
- [排名与赛制](docs/ranking.md)
- [比赛批量导入](docs/batch-import.md)
- [Phase 0 结果](docs/research/phase-0-results.md)
- [Phase 1A 结果](docs/research/phase-1a-results.md)
- [Phase 1B 结果](docs/research/phase-1b-web-results.md)
- [Phase 1C 结果](docs/research/phase-1c-results.md)
- [Phase 1D–1F 结果](docs/research/phase-1d-admin-visual-results.md)
- [Phase 1G–1H 结果](docs/research/phase-1g-batch-results.md)
- [Phase 2A 结果](docs/research/phase-2a-contest-user-results.md)
- [Phase 2B 结果](docs/research/phase-2b-objective-results.md)
- [Phase 3A 结果](docs/research/phase-3a-community-results.md)
- [Phase 3B 结果](docs/research/phase-3b-problem-package-results.md)
- [Phase 3C 结果](docs/research/phase-3c-security-screen-results.md)
- [Phase 3D 结果](docs/research/phase-3d-user-cena-bench-results.md)
- [Phase 3E 结果](docs/research/phase-3e-output-only-results.md)
- [Phase 3F 结果](docs/research/phase-3f-lemon-concurrency-results.md)
- [Phase 3G 结果](docs/research/phase-3g-contest-announce-results.md)
- [Phase 3H 结果](docs/research/phase-3h-interactive-results.md)
- [Phase 3I 结果](docs/research/phase-3i-multi-batch-results.md)
- [前人实现调研](docs/research/prior-art.md)

---

## 10. 许可证

待定。第三方组件（testlib.h 等）的许可证与声明在引入时保留。
