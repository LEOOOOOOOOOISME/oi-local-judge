# OI 局域网评测系统 技术设计文档（v0.1）

- 日期：2026-10-31
- 状态：待评审
- 对应需求：`requirement.txt`（v0.3，878 行）
- 配套调研：`docs/research/prior-art.md`
- 产品代号：OiJudge
- 目标平台：Windows 10/11/Server 2019+ x64

---

## 1. 目标与约束

### 1.1 目标

在一台 **4 核 / 8GB / SSD** 的 Windows 主机上，交付一个桌面程序：
老师出题、配数据、办比赛；学生在局域网用浏览器登录、看题、提交、看评测与榜单；
500 注册、300 同时在线、峰值 50 并发提交下页面不卡、评测不堵、崩溃可恢复。

### 1.2 硬约束

| 约束 | 结论 |
|---|---|
| 主机 | 4 核 / 8GB / SSD / 1000M LAN |
| 部署 | 单个桌面程序（Electron），不做 Windows 服务 |
| 访问 | 桌面窗口与选手浏览器共用同一 HTTP/WS 服务 |
| 沙箱 | 工程级：Job Object + 独立目录 + 可选受限令牌，不做内核隔离 |
| 离线 | 除 npm 安装/编译器外，运行期不依赖公网 |
| 性能 | 需求 5.1 的 16 条指标为验收线；性能回归 >10% 不通过 |
| 复用 | testlib.h(MIT)；GPL/AGPL 只参考设计，不复制代码 |

### 1.3 已确定的依赖策略（尽量使用本机已有）

| 依赖 | 来源 | 说明 |
|---|---|---|
| MinGW-W64 GCC 16.1.0 | 本机已有（WinLibs UCRT POSIX） | 自动探测；不打包 1GB 工具链；找不到再引导安装 |
| Node.js 24 | 本机已有 | CLI / 压测 / 构建脚本；Electron 自带 Node 跑服务 |
| CMake 4.4 | 本机已有 | 构建 `ojrunner.exe` |
| Git | 本机已有 | 版本管理 |
| Electron + React + Fastify + AntD | npm（npmmirror） | 必须下载；锁版本；配置 Electron 镜像 |
| SQLite | Node 24 内置 `node:sqlite` | 无需原生编译；Electron 45 内置 Node 24；目标机启动自检 `sqlite_version()` |
| Python 3 | 用户自装（一期可选） | 本机未安装；启用 Python 评测时检测，缺失则禁用该语言 |
| testlib.h | vendored（MIT） | 随仓库分发，保留 LICENSE |
| 不使用 | MSVC、Docker、WSL、Python（一期） | 本机没有；避免引入构建链 |

---

## 2. 架构总览

### 2.1 进程拓扑

```
┌──────────────────────────────────────────────────────────────┐
│ Electron main（窗口 / 托盘 / 单实例 / 服务守护 / 自动更新）      │
│   └─ utilityProcess: ojserver                                 │
│        ├─ Fastify 5：/api、/ws、静态资源（web/dist）           │
│        ├─ 会话/权限/审计（HMAC 无状态会话 + 内存权限缓存）      │
│        ├─ SQLite（node:sqlite, WAL）+ 文件存储                  │
│        ├─ 榜单内存快照 + 增量广播（2Hz 合并）                  │
│        ├─ 评测调度（默认 2 槽，最多 3）                        │
│        │    ├─ g++ 编译（哈希缓存，BELOW_NORMAL）              │
│        │    ├─ worker_threads 池：比较/哈希/导入/统计          │
│        │    └─ ojrunner.exe ×N（Job Object 沙箱）              │
│        └─ 事件循环/慢查询/队列指标 → /admin/metrics            │
│                                                              │
│ BrowserWindow 加载 http://127.0.0.1:<port>                    │
│ 局域网浏览器 → http://<host-ip>:<port>（同一套 SPA）           │
└──────────────────────────────────────────────────────────────┘
```

- 默认端口 8787；被占用时自动顺延 8788~8799，并在界面提示实际地址。
- 监听地址默认 `0.0.0.0`，可改为 `127.0.0.1` 或指定网卡。
- 数据目录默认 `%LOCALAPPDATA%\OiJudge`，安装时可改；支持迁移。
- 主进程只做壳与守护；服务崩溃按 1s/2s/5s 指数退避重启，任务从 SQLite 恢复。
- CLI：`ojserver --cli --port 8787` 与桌面模式共用服务代码，用于 E2E、压测、无 GUI 运行。

### 2.2 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 桌面 | Electron（安装时锁定稳定版） | 单窗口；可选关硬件加速 |
| 前端 | React 18 + TypeScript + Vite + Ant Design 5 | compact 主题 + 设计令牌；路由分包 |
| 前端数据 | TanStack Query v5 + TanStack Virtual + React Router | 缓存、虚拟列表、路由 |
| 编辑器/渲染 | Monaco（仅提交页懒加载）、highlight.js（查看代码）、markdown-it + KaTeX（服务端渲染） | 控制首包 |
| 服务 | Fastify 5 + @fastify/websocket/static/cookie/multipart/rate-limit | TypeBox/AJV 校验 |
| 存储 | node:sqlite（WAL）+ 文件系统 | 迁移脚本版本化 |
| 原生 | C++17 + Win32 + CMake + MinGW GCC 16 | `ojrunner.exe` |
| 测试 | Vitest + Playwright + autocannon + ws | 单测/集成/E2E/压测 |
| 打包 | electron-builder（NSIS + 绿色版） | 原生 runner 随包 |

### 2.3 关键架构决策

1. **服务放 utilityProcess**：渲染进程（窗口）崩溃不影响评测与局域网服务；主进程保持极简。
2. **评测重活全部出主线程**：编译/运行/SPJ 是子进程；比较/哈希/导入/统计进 worker 池；主线程目标单次阻塞 ≤50ms。
3. **原生 runner 独立 exe**：避免 Electron ABI 依赖；沙箱逻辑用 Win32 实现；Node 侧只传参数、读 JSON。
4. **不使用 ORM**：手写 SQL + 预编译语句，保证查询计划可控。
5. **赛制/榜单是纯函数 + 声明式规则 JSON**：不执行用户代码；服务端与测试共用。
6. **题面服务端渲染并缓存**：按题目版本失效；客户端不加载 markdown-it/KaTeX JS。

---

## 3. 代码结构与模块边界

```
oi-judge/
  apps/desktop/            Electron main / preload
    src/main.ts            窗口、托盘、单实例、服务守护、自动更新
    src/preload.ts         最小暴露（打开数据目录、退出、版本）
  apps/server/
    src/index.ts           启动、配置、优雅退出
    src/cli.ts             --cli 入口
    src/http/              路由层：参数校验、鉴权、调用 service
      auth.ts problems.ts contests.ts submissions.ts admin.ts community.ts ws.ts
    src/services/          业务编排
      problems.ts contests.ts submissions.ts users.ts ranking.ts community.ts
    src/judge/
      scheduler.ts         队列、优先级、公平轮转、恢复
      compiler.ts          编译、缓存、CE 日志
      runner.ts            调 ojrunner.exe、JSON 协议、看门狗
      compare.ts           内置比较器、流式
      checker.ts           testlib / Lemon 六参数 / SPJ 编译缓存
      interactor.ts        双向管道中继
      subtask.ts           聚合
    src/storage/
      db.ts                连接、PRAGMA、事务、迁移
      repos/*.ts           表级读写
      files.ts             题包/代码/日志/临时目录
      cache.ts             编译缓存、题面 HTML 缓存、LRU
    src/realtime/
      hub.ts               房间、增量、慢消费者
    src/security/
      session.ts csrf.ts permissions.ts rate-limit.ts audit.ts
    src/metrics.ts         事件循环延迟、慢查询、队列、内存
  apps/web/
    src/app/               路由、AppShell、WsProvider
    src/pages/             选手端/管理端页面
    src/components/        DataTable、VerdictBadge、MarkdownView、CodeViewer、RankTable
    src/api/               fetch client、query keys
    src/styles/            设计令牌、主题
  packages/shared/
    src/types.ts           API/DTO 类型
    src/schemas.ts         TypeBox schema
    src/ranking/           赛制纯函数（OI/IOI/ACM/自定义）
    src/protocol.ts        状态码、事件名、WS 消息
  native/runner/
    src/main.cpp           Win32 沙箱执行器
    CMakeLists.txt
  tools/
    build-runner.mjs       MinGW 构建脚本
    bench/                 HTTP/WS/提交压测
    seed/                  样例题库与账号
  tests/
    unit/ integration/ e2e/ fixtures/problems/
```

**边界规则**
- `http/` 不写 SQL、不写业务分支；只做鉴权、校验、DTO 转换。
- `services/` 不接触 `req/reply`；依赖 `storage`、`judge`、`shared`。
- `judge/` 只依赖 `storage` 接口与 `shared/protocol`；可在测试中替换 runner 为 mock。
- `web/` 不复制业务规则；赛制展示字段由服务端返回。
- 所有跨层类型来自 `packages/shared`，禁止重复定义。

---

## 4. 数据模型与存储

### 4.1 SQLite 配置

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
PRAGMA cache_size=-65536;      -- 64MB
PRAGMA mmap_size=134217728;    -- 128MB
PRAGMA temp_store=MEMORY;
PRAGMA wal_autocheckpoint=1000;
```

- 单写连接（服务进程）+ 只读连接（worker/导出），WAL 允许并发读。
- 迁移：`migrations/0001_init.sql ...`，`schema_migrations(version, applied_at)`；升级前自动备份。
- 禁止比赛期间 `VACUUM`；空闲执行 `PRAGMA optimize` 与增量清理。

### 4.2 核心表

| 表 | 关键字段 | 索引/说明 |
|---|---|---|
| users | id, username, real_name, class, grade, school, password_hash, role, status, session_version, created_at | `UNIQUE(username)` |
| roles/permissions/role_permissions/user_permission_overrides | 权限点 | 权限点见需求附录 C |
| sessions | id, user_id, token_hash, ip, ua, expires_at, last_seen | 可选审计；常规鉴权不查 |
| problems | id, title, type, difficulty, tags_json, io_mode, time_ms, memory_mb, languages, visibility, version, created_by | `(visibility)`、`(difficulty)` |
| problem_versions | id, problem_id, snapshot_json, created_by, created_at | 回滚 |
| problem_testcases | id, problem_id, ordinal, input_path, output_path, points, subtask_id, depends_on, enabled | `(problem_id, ordinal)` |
| problem_subtasks | id, problem_id, name, points, aggregation, depends_on | |
| problem_assets | id, problem_id, kind, path, sha256, size | kind=std/checker/validator/generator/interactor |
| contests | id, name, mode, start_at, end_at, freeze_at, unfreeze_at, status, rules_json, created_by | `(status, start_at)` |
| contest_problems | contest_id, problem_id, ordinal, points, visible_from | 复合主键 |
| contest_participants | contest_id, user_id, status, extra_time, signed_in_at | 复合主键 |
| submissions | id, contest_id, problem_id, user_id, language, source_path, source_hash, status, score, time_ms, memory_kb, created_at, judged_at | `(contest_id,user_id,created_at)`、`(problem_id,status)`、`(user_id,created_at)` |
| test_results | submission_id, testcase_id, status, time_ms, memory_kb, score, message | `(submission_id)` |
| judge_tasks | id, submission_id, priority, status, worker, attempts, heartbeat_at | `(status,priority,id)` |
| posts/comments | 社区 | FTS5 索引 |
| clarifications | contest_id, user_id, question, answer, is_public, created_at | `(contest_id)` |
| conversations/messages | 私信 | `(conversation_id, created_at)` |
| attachments | owner, path, mime, size, sha256 | 下载鉴权 |
| audit_logs | id, user_id, action, target, detail_json, ip, created_at | `(created_at)`、`(user_id)` |
| awards | contest_id, name, user_id, rule_snapshot | |
| stats_daily | 聚合统计 | 异步写 |
| settings | key, value_json | |
| backups | id, path, size, sha256, created_at | |

### 4.3 文件布局

```
OiJudgeData/
  config.json
  db/oijudge.db (+ -wal/-shm)
  problems/<pid>/problem.json|statement.md|data/|src/|attachments/
  contests/<cid>/contest.json|exports/|reports/
  submissions/<yyyy>/<mm>/<sid>/code/|result.json|compile.log|judge.log
  uploads/<yyyy>/<mm>/<uuid>
  backups/<timestamp>/
  logs/app-YYYYMMDD.log|judge/|access/|audit/
  cache/compile/<hash>/、statement/<pid>-<version>.html
  tmp/run-<slot>-<uuid>/（评测临时目录，短路径，结束清理）
```

- 题包写入前计算 SHA-256；导入先预检（缺文件/编码/命名/大小）。
- 提交源码不进 DB；`result.json` 与 DB 双写，DB 损坏时可用于恢复。
- 临时目录使用同卷短路径（如 `C:\OIJtmp\r1-xxxx`），避免 MAX_PATH 与中文路径问题。

### 4.4 写入策略与恢复

- 每个测试点结果先在内存累积；整份提交结束后**单事务**写入 `test_results` + `submissions`。
- 统计/审计/通知批量合并（1s 或每 50 条）。
- `judge_tasks` 用 `BEGIN IMMEDIATE` claim；心跳 10s；超时 60s 判定 worker 死亡并重排。
- 启动恢复：`running` 重置为 `queued`（attempts+1）；`compiling` 同理；超过 3 次记 SE。
- 榜单不落库：启动时从 `submissions` 重建；进行中比赛只在内存维护。

---

## 5. HTTP / WebSocket 接口（节选）

### 5.1 认证与通用

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 用户名+密码，限流；返回签名 Cookie |
| POST | `/api/auth/logout` | 版本号+1，吊销所有会话 |
| GET | `/api/me` | 当前用户、权限集、比赛上下文 |
| POST | `/api/auth/change-password` | 首次登录强制改密 |

- Cookie：`oij.sid`，HMAC-SHA256 签名载荷 `{uid, ver, exp}`；HttpOnly、SameSite=Lax；HTTPS 时 Secure。
- CSRF：双提交 Token（`X-CSRF-Token` 与 Cookie），写操作校验。
- 响应统一 `{ ok, data, error }`；错误码稳定，前端按码提示。

### 5.2 选手端

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contests` | 可见比赛列表（状态、倒计时） |
| GET | `/api/contests/:id` | 比赛详情、题目列表、公告 |
| GET | `/api/contests/:id/ranking` | 榜单（封榜规则服务端应用） |
| GET | `/api/problems/:id` | 题面 HTML（服务端渲染缓存）、样例、限制 |
| POST | `/api/submissions` | 提交代码；限流/冷却；返回 id |
| GET | `/api/submissions/:id` | 详情（代码、测试点、SPJ 信息按策略） |
| GET | `/api/submissions` | 我的记录（keyset 分页） |
| GET | `/api/contests/:id/clarifications` | 答疑列表 |
| POST | `/api/contests/:id/clarifications` | 提问 |
| GET/POST | `/api/posts`、`/api/messages` | 社区/私信（权限点） |

### 5.3 管理端

| 方法 | 路径 | 说明 |
|---|---|---|
| POST/PUT/DELETE | `/api/admin/problems` | 题目 CRUD、发布、克隆、版本 |
| POST | `/api/admin/problems/:id/data` | 分片上传、校验、预览 |
| POST | `/api/admin/problems/:id/checker` | 编译/自测 SPJ、validator、generator |
| POST | `/api/admin/contests/:id/start\|extend\|freeze\|end` | 比赛控制 |
| POST | `/api/admin/submissions/:id/rejudge` | 重测单个/批量/按状态 |
| GET | `/api/admin/queue` | 队列、worker、ETA |
| GET | `/api/admin/metrics` | CPU/内存/事件循环/WS/队列 |
| POST | `/api/admin/backup`、`/restore` | 备份/恢复 |
| GET | `/api/admin/audit` | 审计查询/导出 |

### 5.4 WebSocket

- 端点 `/ws`；登录后建立；按房间订阅：`contest:<id>`、`user:<id>`、`admin`。
- 事件：`submission.queued/updated`、`ranking.delta`、`announcement`、`clarification`、`contest.tick`。
- 消息格式 `{v:1,type,seq,data}`；服务端保留每房间最近 100 条，断线用 `seq` 补拉。
- 榜单 2Hz 合并；慢消费者丢弃中间帧，只发最新快照。

---

## 6. 评测引擎

### 6.1 流水线

```
提交 → 权限/限流/大小校验 → 落库 queued → WS queued
  → 调度 claim（优先级：赛中 > 练习 > 重测；同优先级按用户轮转）
  → 编译（缓存命中则跳过；15s 超时；CE 日志截断 64KB）
  → 逐测试点：准备目录 → ojrunner.exe → 结果 JSON
  → 比较（内置/SPJ）→ 子任务聚合
  → 单事务落库 → 统计异步更新 → 榜单增量 → WS 推送
```

状态机：`queued → compiling → running → finished | failed | canceled`。
取消：标记 canceled，杀进程树，释放临时目录。

### 6.2 编译

- 路径来自系统设置；自动探测顺序：设置值 → 本机 WinLibs → Dev-Cpp MinGW → PATH；版本 <13 告警。
- 默认命令模板（可改）：
  ```
  g++ -O2 -std=c++17 -static -o prog.exe main.cpp
  ```
- C++14/17/20 通过 `-std=` 配置；C 用 `gcc`；Python 解释执行（时限倍率默认 2x）。
- 编译缓存键：`sha256(source + language + flags + compilerVersion)`；产物存 `cache/compile/<hash>/`，LRU 上限 2GB。
- 编译进程设置 `BELOW_NORMAL`，超时杀树；stderr/stdout 合并截断。

### 6.3 原生 Runner 协议

Node 调用：

```
ojrunner.exe --json
  --input <file|pipe> --output <file|pipe>
  --time-ms 1000 --memory-mb 256 --process-limit 1
  --wall-ms 3000 --workdir <dir> --exe <prog.exe>
```

stdout 输出单行 JSON：

```json
{"exitCode":0,"cpuMs":123,"wallMs":130,"peakMemKb":10240,
 "timedOut":false,"oom":false,"signal":0,"stdoutBytes":12,"stderrBytes":0}
```

- `timedOut=true` 或 `wallMs > wall` → TLE；`oom=true`/peak 超限 → MLE；exitCode≠0 → RE。
- 结果 JSON 解析失败、runner 崩溃、超过 Node 侧看门狗（wall+2s）→ SE。
- 交互题：`--input pipe --output pipe`，Node 负责与 interactor 中继；单次读 64KB，总字节上限可配。

### 6.4 沙箱实现（`native/runner`）

1. `CreateJobObjectW`；`SetInformationJobObject`：
   - `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`：`ProcessMemoryLimit=memory_mb`、`ActiveProcessLimit=1`、`PerProcessUserTimeLimit=(time_ms+1000)*10000`（100ns 单位，CPU 兜底）、`LimitFlags` 含 `JOB_OBJECT_LIMIT_PROCESS_TIME | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`；
   - `JOBOBJECT_BASIC_UI_RESTRICTIONS`：禁止桌面/剪贴板交互。
   - CPU 最终判定仍以 `GetProcessTimes` 为准（Job 限额只作失控兜底）。
2. `CreateProcessW` 选手程序：`CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT`，`STARTUPINFO` 指定 std 句柄（文件或管道），工作目录=临时目录，环境块最小化。
3. `AssignProcessToJobObject` → `ResumeThread`。
4. `WaitForSingleObject(process, timeout)`；超时 `TerminateJobObject`。
5. `GetExitCodeProcess` + `GetProcessTimes`（CPU 用户+内核）+ `QueryInformationJobObject(JobObjectExtendedLimitInformation)` 取峰值内存；`TerminateJobObject` 清进程树。
6. 受限令牌（可选）：进程以管理员启动 → `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE|LUA_TOKEN)` + `CreateProcessAsUser`；普通权限下使用当前令牌 + Job Object，残余风险写入用户文档。
7. 临时目录：`%TEMP%\OiJudge\run-<slot>-<uuid>`；输入用硬链接（同卷）或直接重定向 stdin；结束后递归删除；失败重试一次。
8. 低优先级：`BELOW_NORMAL_PRIORITY_CLASS`，避免抢 Web 的 CPU。

### 6.5 比较与 SPJ

- 内置比较器（流式）：逐字节、忽略行尾空白、忽略全部空白、浮点（abs+rel）、忽略大小写；首个不一致即 WA，不整文件入内存。
- testlib 模式：`checker input user_out answer`；`_ok/_wa/_pe` 按退出码；部分分按 testlib `quitp` 约定解析（Phase 0 用官方样例验证，验证不了则改用 stderr 约定并记录）。
- Lemon 六参数模式：`checker input user_out answer full_score score_file info_file`；`score_file` 写 0..full；越界截断并告警。
- SPJ 编译一次缓存；运行 `BELOW_NORMAL`、10s 超时、输出截断；崩溃/超时记 SE。
- 子任务：组内 `min`/`sum`；前驱未通过则后续 SK（可配）。

### 6.6 队列与调度

- 优先级：`contest=100`、`practice=50`、`rejudge=10`；同优先级按用户最近评测时间轮转，防止单用户霸占。
- 槽位默认 `min(2, 物理核数-1)`；设置可改 1~3；超过 2 时前端提示"Web 指标降级"。
- 队列为空时每 500ms 轮询兜底；有新任务时内存通知立即唤醒。
- ETA：按最近 20 个测试点平均耗时估算，展示排队位与预计时间（粗粒度，不做承诺）。

---

## 7. 比赛、榜单与赛制

### 7.1 比赛状态机

```
draft → scheduled → running → frozen? → ended → archived
                 ↘ canceled
```

- 到时自动开始/结束（后台 1s tick）；支持提前开始、延长、缩短、补时、暂停（顺延结束时间）。
- 封榜：`freeze_at` 到期后榜单隐藏得分/状态（按规则）；`unfreeze_at` 或管理员解封。
- 赛后结算：生成成绩单快照，支持申诉与人工改分（写审计）。

### 7.2 赛制规则 JSON（声明式，不执行代码）

```json
{
  "mode": "oi",
  "score": "sum",
  "tieBreak": ["last_ac_time", "penalty"],
  "penaltyMinutes": 20,
  "freeze": { "hide": ["score", "status"], "show": ["submission_count"] },
  "ranking": { "includeObjective": true, "subtask": "sum" }
}
```

- `mode`：oi / ioi / acm / custom；custom 通过字段组合表达。
- 纯函数 `computeRanking(contest, submissions, rules)`；输入按时间排序；输出名次、总分、各题、罚时、首 AC。
- 并列规则可配；ACM 罚时 = 首次 AC 时间 + 20×错误次数（仅计已通过题）。

### 7.3 榜单性能

- 内存快照：`Map<userId, Row>` + 题目数组；提交事件更新单行。
- 广播前排序（500 人可忽略）；2Hz 合并；只推变化行（`ranking.delta`）。
- 封榜只改序列化层；解封不重算。
- 大屏订阅 `contest:<id>:bigscreen`，只推 Top 100 + 公告 + 倒计时。

---

## 8. 权限、会话与安全

- 角色：Admin / Setter / ContestManager / Contestant / Guest；权限点见需求附录 C；按比赛可临时授权。
- 鉴权：HMAC 签名会话（无状态）+ `users.session_version` 吊销；权限集内存缓存，角色变更版本失效。
- 密码：`crypto.scrypt`（N=16384, r=8, p=1, 64B key, 随机 32B salt），`timingSafeEqual`。
- CSRF：双提交 Token；SameSite=Lax；HTTPS 时 Secure。
- 限流：登录（5/min/IP、20/h/账号）、提交（同用户同题 10s 冷却）、私信（20/min）、发帖（5/min）。
- 上传：类型白名单、大小限制、随机存储名、路径规范化、下载鉴权；ZIP 解压防 Zip Slip。
- XSS：Markdown 服务端渲染 + 白名单清洗（DOMPurify 服务端或 sanitize-html）；CSP 头。
- 审计：登录、改密、权限变更、重测、删题/删赛、改分、恢复备份等追加写。
- 沙箱残余风险：可读同机文件、可联网、可创建线程；写入用户文档，不承诺内核级隔离。
- HTTPS（P1）：启用后 HTTP→HTTPS 跳转、WSS、证书到期提醒；自签证书生成/导入。

---

## 9. 前端设计

### 9.1 页面与路由

**选手端**
- `/login` 登录
- `/contests` 比赛列表（状态/倒计时）
- `/contest/:id` 比赛主页：公告、题目列表、我的提交、榜单、答疑、倒计时
- `/contest/:id/problem/:pid` 题目页：题面、样例、提交、记录、题解（按策略）
- `/submissions/:id` 提交详情：状态、测试点、代码（按策略）
- `/records` 我的记录（虚拟列表）
- `/user/:id` 个人主页
- `/discuss`、`/messages`、`/notifications`（P1/P2）

**管理端**
- `/admin` 仪表盘：在线、队列、CPU/内存、今日提交
- `/admin/problems`、`/admin/problems/:id`：题面/数据/SPJ/子任务/校验/导入导出
- `/admin/contests/:id/control`：开赛/延时/封榜/重测/公告/监考
- `/admin/users`、`/admin/queue`、`/admin/import`、`/admin/settings`、`/admin/audit`

### 9.2 组件与数据流

- `AppShell`（侧栏 + 顶栏 + 内容）、`DataTable`（虚拟滚动/服务端分页）、`VerdictBadge`、`MarkdownView`（服务端 HTML）、`CodeViewer`（highlight.js 懒加载）、`MonacoEditor`（仅提交页）、`RankTable`、`Countdown`、`ClarificationPanel`、`WsProvider`、`ErrorBoundary`、`Skeleton`。
- TanStack Query 管理服务端状态；WS 事件合并到 query cache；提交乐观更新；断线按 `seq` 补拉。
- 倒计时基于服务端时间 + 本地时钟偏移，每秒本地更新，不轮询。

### 9.3 视觉与交互

- 中性灰 + 单一强调色；13/14px 基准；8px 栅格；紧凑表格。
- 状态色语义固定：AC 绿、WA 红、TLE 黄、MLE 橙、RE 紫、CE 灰蓝、SK 灰。
- 不做渐变/大动效；120–200ms 过渡；骨架屏、空状态、错误重试完整。
- 1280×720 起可用；1366×768 为主；高 DPI 100–200% 正常。
- 题面/榜单/记录三处信息密度最高，优先保证可读与不抖动。

---

## 10. 性能工程

### 10.1 预算

| 项 | 目标 |
|---|---|
| 服务进程 RSS | ≤350MB（含 SQLite cache 64MB） |
| 渲染进程 RSS | ≤300MB |
| worker + runner | ≤150MB |
| 总内存 | ≤900MB |
| 事件循环延迟 p99 | ≤50ms |
| API p95 / p99 | ≤150ms / ≤400ms |
| 榜单增量广播 | ≤1s，单次 ≤50KB |
| 50 并发提交 | 零丢失，3s 内显示排队位 |
| 20×1s 题目单提交 | ≤25s（2 槽） |
| 1000 测试点积压 | ≤15 分钟 |
| 冷启动 | ≤4s |
| 首包 JS | ≤400KB gzip |
| 2 小时浸泡 | 内存增长 ≤10%，无句柄泄漏 |

### 10.2 关键技术

**事件循环保护**
- 重活出主线程：编译/运行/SPJ 子进程；比较/哈希/导入/统计进 worker 池（2）。
- `monitorEventLoopDelay` 监控，p99 >100ms 告警；慢请求/慢查询日志。

**认证与权限**
- HMAC 无状态会话，常规请求不查 sessions 表。
- 权限集内存缓存（用户版本号失效）。

**数据库**
- 预编译语句缓存；覆盖索引；keyset 分页；禁止 `SELECT *`/`COUNT(*)` 翻页。
- 结果单事务批量写；统计/审计合并写；重查询走只读连接。
- FTS5 搜索；`PRAGMA optimize` 空闲执行。

**榜单**
- 内存快照 + O(1) 更新；2Hz 合并；只推增量；封榜不重算。

**评测**
- 编译缓存；每题 checker/std 一次编译；输入硬链接/直接重定向；流式比较、首错即停。
- 资源统计不轮询：`GetProcessTimes` + Job Object 峰值。
- 交互 64KB 缓冲中继；SPJ 10s 超时、低优先级。
- Phase 0 决定 runner 每点启动还是常驻守护（目标 <15ms/点）。

**前端**
- 题面服务端渲染缓存（按题目版本）；客户端不加载 markdown-it/KaTeX JS。
- Monaco 仅提交页懒加载；查看代码用 highlight.js。
- AntD tree-shaking + 路由分包；首屏 JS ≤300KB，总首包 ≤400KB。
- 虚拟表格；分页 50；倒计时本地计算。
- 静态资源预压缩 + immutable 缓存；API ETag。

**Electron**
- 服务器模式可选关硬件加速（省 GPU 进程内存）。
- 单窗口、无多余 webContents；托盘继续服务。

### 10.3 度量与门禁

- `/admin/metrics`：事件循环延迟、RSS、CPU、队列长度、WS 连接、慢查询计数。
- `npm run bench`：autocannon（HTTP）+ ws 连接（300）+ 50 并发提交脚本；`cmd /c start /affinity 0F` 绑 4 核近似目标机。
- CPU profile（`--cpu-prof`）与 SQLite `EXPLAIN QUERY PLAN` 报告随仓库交付。
- 性能回归 >10% 失败；每期交付前 2 小时浸泡。

### 10.4 Phase 0 微基准

| 项 | 目标 |
|---|---|
| runner 启动 + Job Object | <15ms/测试点 |
| 20 条结果单事务写入 | <10ms |
| 500 行榜单序列化 + 推送 | <5ms |
| 题面渲染缓存命中 | <1ms |
| Electron 空载 / 关 GPU 内存 | 记录基线 |

---

## 11. 可靠性、备份与恢复

- 崩溃恢复：重启后 `running/compiling` 重排；最多 3 次；失败记 SE。
- 数据库：WAL + 完整性检查；启动时 `quick_check`（可配）；损坏时引导恢复备份。
- 备份：SQLite 在线备份 + 题包/配置/提交代码；每日 + 手动；保留 7 份；恢复前自动备份当前。
- 备份清单含 SHA-256；恢复后校验；恢复操作二次确认 + 审计。
- 磁盘配额：剩余 <2GB 告警并暂停新上传；评测临时目录清理失败告警。
- 断电：WAL 保证已提交事务；未完成提交重排。

---

## 12. 测试策略

- 单元：赛制/榜单纯函数、比较器、子任务聚合、权限判定、Markdown 清洗。
- 集成：Fastify inject + 临时 SQLite；题包导入导出；迁移；备份恢复。
- 评测 E2E：传统/文件 IO/SPJ/交互/子任务；CE/TLE/MLE/RE/OLE/PE 各一例；样例题库随仓库。
- 故障：强杀服务、runner 卡死、SPJ 崩溃、磁盘满、数据库损坏。
- 安全：越权、XSS/CSRF、路径穿越、Zip Slip、超大上传、登录爆破。
- 压测：300 在线、50 并发提交、榜单刷新、封榜切换、登录洪峰；4 核口径。
- 性能：微基准 + 回归门禁 + 2 小时浸泡。

---

## 13. 打包与首次启动

- electron-builder：NSIS 安装包 + 绿色版；`ojrunner.exe` 随包；不打包 GCC。
- 首次启动向导：数据目录 → 编译器检测（本机 WinLibs GCC 16.1）→ 端口 → 管理员账号 → 局域网地址/二维码。
- 编译器缺失/版本 <13：醒目提示 + 引导安装；未配置时禁止开赛。
- 防火墙：检测入站规则，给出添加指引（需要管理员权限时提示）。
- 升级：先备份再迁移；失败回滚；离线不强制更新。
- 自签 HTTPS（P1）：生成/导入证书，HTTP→HTTPS 跳转，证书到期提醒。
- 托盘/开机自启/单实例/关闭确认。

---

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| node:sqlite 在 Electron 中不可用 | 无法启动 | Phase 0 已用 CLI 验证；目标机跑 `tools/check-sqlite-electron.cjs`；必要时调整 Electron 版本或改用 `@libsql/client` |
| testlib 部分分协议不明确 | SPJ 分数错误 | Phase 0 用官方样例验证；回退 Lemon 六参数 |
| Job Object 在受限权限下失败 | 沙箱弱化 | 检测能力；文档声明；管理员模式提供受限令牌 |
| Electron 下载慢/大 | 安装体验 | 配置 npmmirror Electron 镜像；安装包不打包 GCC |
| AntD 首包超预算 | 首屏慢 | 路由分包；必要时登录/题面页拆轻量布局 |
| 4 核压测在 16 核开发机失真 | 验收不可信 | `start /affinity 0F` 绑核 + 目标机复测 |
| 服务端题面渲染缓存失效错误 | 显示旧题 | 按题目版本号作为缓存键 |
| 长路径/中文路径 | 编译/评测失败 | 临时短路径；路径规范化；启动自检 |
| Defender 扫描拖慢进程创建 | 评测变慢 | 诊断页测量；文档建议排除数据目录 |
| 交互题复杂度 | 工期/稳定性 | 一期做基础交互；调试器 P1；失败可降级 |

---

## 15. 里程碑

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| Phase 0 | 技术验证：Electron+SQLite 加载、runner 原型、GCC 编译、Fastify+WS、微基准 | 5 项全通过，风险清单关闭 |
| Phase 1 | 账号、题库、评测内核、比赛、榜单、班级统计、交互题、设置/诊断、性能门禁 | 需求 8.2 的 V1–V10 + 5.1 指标 |
| Phase 2 | 榜单大屏/导出/奖项、答疑社区、批量评测、出题工具链、客观题、提交答案题 | P1 扩展验收 + 性能不回退 |
| Phase 3 | 交互进阶、强沙箱、虚拟赛/团队赛、题解审核、通知、PDF、深色/多语言 | P2 逐项验收 |

---

## 16. 与需求的对应

- 功能需求：`requirement.txt` 第 4 章 FR-ACC/PRB/JDG/CST/RNK/COM/PLG/BAT/AUT/SYS/WEB 与第 12 章 FR-EXP。
- 非功能：需求 5.1（性能）、5.2（可靠性）、5.3（安全）、5.4（兼容）、5.5（可维护）、5.6（UI）。
- 验收：需求 8.2/8.3/8.4；本文第 10.4 微基准与第 12 章测试矩阵补充实现级验收。
- 明确不做：需求第 9 章；本设计不引入查重、分布式评测机、公网多租户。

---

## 17. 待确认/后续

1. 题面服务端渲染是否接受"服务端拼 HTML"的取舍（客户端更轻，但样式需服务端拼装）。
2. 常驻 runner 是否在 Phase 1 就做，取决于 Phase 0 实测收益（<5ms 则不做）。
3. 自签 HTTPS 证书：用 npm `selfsigned`（纯 JS）生成，避免依赖 OpenSSL（本机未安装）；需要复杂证书链时再引入 OpenSSL。
4. 大屏/PDF/图表的具体视觉稿（可在实现前用低保真原型确认）。
5. 是否把 `oi-judge/` 作为独立 Git 仓库（当前工作区不是 Git 仓库）。
