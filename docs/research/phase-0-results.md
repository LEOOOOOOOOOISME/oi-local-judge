# Phase 0 技术验证结果

> 状态：进行中。本文件先记录 Task 6 的 SPJ 协议实测结论，Task 7/8 继续追加性能与决策记录。

## SPJ（testlib / Lemon）协议实测

### 环境与来源

- 操作系统：Windows（本机），编译器：MinGW-w64 GCC 16.1.0（WinLibs UCRT POSIX SEH）。
- `vendor/testlib.h`：来自 `MikeMirzayanov/testlib` master，commit `3bf5ba5aca6007bf8dcde6d00949ec3116ee3cc7`（通过 `gh api` 获取，未使用 curl）。
  - 大小 209,796 字节，UTF-8 无 BOM，SHA-256 `9a291937129e77f093ec712c1f663a0eb28bfa9673fb43a53fec525c8f14a6c6`。
  - 头部保留 MIT 版权声明（`Copyright (c) 2005-2026`，含 “modified is included with the above copyright notice”）。
- `vendor/testlib.LICENSE`：MIT，大小 1,082 字节，SHA-256 `edf4e4b144f24cc4d8070b7a18d700f9429e850f3353736dd628a0a3cacff6c9`。
- 编译命令：`g++ -O2 -std=c++17 -I vendor -o <checker>.exe <checker>.cpp`，三者均编译成功。
- 运行方式：`spawn(checker, [input, output, answer], { stdio: ['ignore','pipe','pipe'] })`，即 stdout/stderr 均为管道、无控制台；因此 testlib 的 ANSI 颜色分支不会触发，实测输出中无转义序列。

### testlib 实测原文（本机 GCC 16.1）

输入 `1 2`、答案 `3`；contestant 输出 `3`（AC）或 `4`（WA / 部分分）。

| 场景 | 调用 | 退出码 | stdout | stderr（原文，保留 `\r\n`） |
|---|---|---|---|---|
| `quitf(_ok, ...)` | `checker in.txt out3.txt ans.txt` | **0** | 空 | `ok answer is correct\r\n` |
| `quitf(_wa, ...)` | `checker in.txt out4.txt ans.txt` | **1** | 空 | `wrong answer expected 3, got 4\r\n` |
| `quitp(0.5, ...)` | `checker in.txt out4.txt ans.txt` | **7** | 空 | `points 0.5 half credit: expected 3, got 4\r\n` |

`quitp(0.5, ...)` 的 stderr 原始字节（base64）：
`cG9pbnRzIDAuNSBoYWxmIGNyZWRpdDogZXhwZWN0ZWQgMywgZ290IDQNCg==`

结论（与 testlib 源码一致，已实测确认）：

- testlib 把结果写到 **stderr**，stdout 为空；消息前缀为 `ok ` / `wrong answer ` / `points ` 等。
- **部分分 `quitp` 的退出码是 7（`POINTS_EXIT_CODE`），不是 0**；部分分数值以 `points <value> <message>` 文本形式出现在 stderr 首部。
- 退出码约定（默认编译宏、未定义 `TESTSYS`/`EJUDGE` 等）：`0 = _ok`、`1 = _wa`、`2 = _pe`、`3 = _fail`、`4 = _dirt`（testlib 内部会改写成 `_pe`/2）、`7 = _points`、`8 = _unexpected_eof`（默认改写成 `_pe`/2）。
- 退出码 3 存在歧义：默认 `PC_BASE_EXIT_CODE = 0` 时，`_pc(N)` 的退出码也是 `N`，可能与 `_fail(3)` 冲突；Phase 0 只支持 `quitp` 路线，`_pc/result file` 未验证。

### checker.ts 的解析规则（已通过测试）

testlib：

- 退出码 `0` → `AC`，`score = fullScore ?? 1`，`message` 取 stderr。
- 退出码 `1` → `WA`，`score = 0`。
- 退出码 `2`、`4` → `PE`，`score = 0`。
- 退出码 `7` → 正则 `/(?:^|\n)\s*points\s+([+-]?数字)/` 从 stderr（必要时回退 stdout）提取分数：
  - 未传 `fullScore`：相对分制，`0 < points < 1` → `PC`（`quitp(0.5)` 得 `PC/0.5`）；`points >= 1` → `AC`；`points = 0` → `WA`。
  - 传 `fullScore`：按 `[0, fullScore]` 截断并判断 `PC/AC/WA`。
  - 退出码 7 但解析不出数字 → `SE`（协议异常）。
- 其他退出码（含 `_fail`=3）、信号终止、启动失败、超时 → `SE`。
- 每路输出捕获上限 64 KiB，`message` 超过 64 KiB 时截断并追加 `...[truncated]`。

Lemon 六参数：

- 调用：`checker <input> <output> <answer> <full_score> <score_file> <info_file>`，`fullScore` 默认 100。
- 本机实测（full_score=100、答案 3、输出 4）：退出码 0，stdout/stderr 均为空，score 文件内容为 `50\r\n`（十六进制 `35 30 0d 0a`），info 文件为 `close enough for half credit\r\n`。
- 解析：读 score 文件并 `Number(...)`；超出 `[0, fullScore]` 时截断并写入告警；`0` → `WA`、`fullScore` → `AC`、中间值 → `PC`；退出码非 0、score 文件缺失/为空/非数字、超时、启动失败 → `SE`。`message` 优先取 info 文件，缺失时回退进程 stderr/stdout。
- 临时 score/info 文件以随机名写入 `workdir`，运行后清理。

### 验证记录

- `node node_modules/vitest/vitest.mjs run apps/server/tests/checker.test.ts`：**8 tests passed**（vitest 3.2.7）。
  - 覆盖：testlib AC、testlib WA、testlib `quitp(0.5)` → `PC/0.5`、testlib 超时 → SE、checker 不存在 → SE、Lemon AC（100）、Lemon 部分分（50）、Lemon 0 分 → WA。
- `node node_modules/typescript/bin/tsc -p apps/server/tsconfig.json --noEmit`：通过。
- 运行测试需设置 `OIJ_GXX` 为本机 GCC 路径（否则回退 `g++`）；测试会在系统临时目录编译 fixtures，不污染仓库。

### 遗留风险 / Phase 1 注意

1. testlib `_pc(N)` / result file 部分分协议未验证（退出码与 `_fail` 冲突）；如 Phase 1 需要 Polygon 式 result 文件，需单独验证并扩展解析。
2. 当前用 `child.kill()` 结束超时 checker；Windows 下不会像 Job Object 那样连带清理 checker 自己派生的子进程。SPJ 正常不派生子进程，Phase 1 可复用 runner 的作业对象强化。
3. 64 KiB 截断会丢失超长诊断信息；若 checker 打印大量 diff，只保留前 64 KiB。
4. Lemon 的 info 文件视为可选；缺失时回退进程输出，可能为空。
5. 编译缓存未实现（Phase 1 范围：每题 checker 编译一次并缓存）。
6. 若未来以控制台方式直接运行 testlib checker，stderr 可能带 ANSI 颜色码，需要剥离；当前管道方式无此问题。

---

## SQLite 选型（2026-10-31 实测，已修订）

- 原计划 `better-sqlite3`：npm 安装时其 `prebuild-install` 需要 spawn 子进程，在本机 DSH 沙箱下报 `EPERM`（`spawn`），无法完成安装；`npm install --ignore-scripts` 也拿不到 `.node` 二进制。这不是 ABI 结论，而是构建环境限制。
- 改用 **Node 24 内置 `node:sqlite`（`DatabaseSync`）**：本机 Node v24.18/24.22 直接可用，已通过 WAL、事务、回滚测试（`apps/server/tests/db.test.ts` 2/2）。
- `apps/server/src/storage/db.ts` 已改为 `node:sqlite`，并补了 `transaction()`（BEGIN IMMEDIATE/COMMIT/ROLLBACK）。
- 影响：无需原生编译/预编译下载；Electron 45 内置 Node 24.22 同样带 `node:sqlite`（待目标机验证）。设计文档依赖表需从 `better-sqlite3` 更新为 `node:sqlite`。
- 风险：`node:sqlite` 在 Node 22 早期版本需 `--experimental-sqlite`；本项目用 Electron 45+（Node 24），建议锁定 Electron 版本并做启动自检（`SELECT sqlite_version()`）。

## 原生 Runner 实测（Task 5）

- 构建：GCC 16.1，`-O2 -std=c++17 -Wall -Wextra`，无警告；产物 `native/runner/out/ojrunner.exe`（git-ignored）。
- 正常程序：`{"exitCode":0,"cpuMs":0,"wallMs":16,"peakMemKb":1236,"timedOut":false,"oom":false,"signal":0,"stdoutBytes":3,"stderrBytes":0}`；stdin/stdout/stderr 三个重定向均验证。
- TLE（死循环，time=200ms、wall=1000ms）：`wallMs:1000,timedOut:true,cpuMs:968`，无残留进程。
- MLE（128MB 分配，限额 32MB）：`peakMemKb:31816`（触顶 32768KB）、`oom:true`、`exitCode:3221226505 (0xC0000409)`、`signal:6`；Job 内存限额真实生效。
- 单点开销：runner 内部 wallMs 中位 **16ms**（n=20，12–22ms）；端到端 `runSandboxed` ≈ **42ms**（含 Node spawn）。满足设计 5.1 的“单测试点框架开销 ≤40ms”边缘（需在 Phase 1 用常驻 runner 或降低 spawn 开销）。
- 判定注意：墙钟/内存杀都会给出 `exitCode=1`，判分不能把 1 当程序退出码；MLE 需同时接受 `oom`、`peak ≥ 90% 限额`、`STATUS_NO_MEMORY`、stderr `bad_alloc` 四类证据。
- 残余风险：未做文件系统/网络隔离；未构造 fork-bomb 用例；UI 限制为 best-effort；`PerProcessUserTimeLimit` 的 job violation 路径未单独验证。
- 环境坑：DSH workspace-write 下原生子进程写 `%TEMP%` 会被拒绝（ERROR_ACCESS_DENIED）；测试临时目录放在 `native/runner/out/`。当前会话已切换 danger-full-access，但目标机不受此限制。

## Electron 启动验证（Task 4，当前阻塞）

- Electron 45.2.1 与 33.4.11 均在 DSH 会话内启动即崩溃：`0xC0000005 (ACCESS_VIOLATION)`，`app.whenReady()` 不触发；`--no-sandbox --disable-gpu --single-process` 均无效；Windows 事件日志显示 `electron.exe` 自身 crash（偏移 0x7ef845b/45.2.1）。
- 判断：这是**当前 DSH 宿主/作业对象对嵌套 Electron GUI 的限制**，不是应用代码错误；`electron.exe --no-sandbox --version` 可正常返回版本，Electron API 可加载。
- 处置：桌面壳代码、`utilityProcess` 启动服务器、Playwright 冒烟测试已实现，但**无法在本会话验证**；需在目标 Windows 机器上跑 `npx playwright test` 复验。Phase 0 退出条件中 Electron 一项标记为“延期验证”，不阻塞服务器/评测/前端开发。
- 待目标机验证：`node tools/check-sqlite-electron.cjs`（node:sqlite 在 Electron 中可用）、窗口加载、utilityProcess IPC、关 GPU 内存基线。

## Phase 0 总结（截至 2026-10-31）

| 验证项 | 结果 |
|---|---|
| Monorepo / Vitest / 共享协议 | 通过（18/18 tests） |
| Fastify HTTP + WS + 静态壳 | 通过 |
| SQLite（node:sqlite + WAL + 事务） | 通过（选型修订） |
| 原生 Job Object runner（正常/TLE/MLE） | 通过（单点 16ms，端到端 43ms） |
| testlib / Lemon 六参数 SPJ | 通过（testlib quitp=exit 7 + stderr points；Lemon score 文件） |
| Electron 桌面壳 | 阻塞于 DSH 宿主，延期到目标机 |
| 微基准 | 通过（见下） |

## 微基准结果（Task 7，开发机 16C/16G）

> 目标机是 4C/8G，以下仅作数量级参考；Phase 1 需绑 4 核复测。

```json
{
  "sqlite-bench": {
    "insert20Ms": 0.018,
    "insert20MinMs": 0.017,
    "insert20MaxMs": 0.446,
    "rows": 4000,
    "readMs": 0.032,
    "dbBytes": 4096
  },
  "ranking-bench": {
    "computeMs": 0.473,
    "serializeKb": 35.1,
    "rows": 500
  },
  "runner-bench": {
    "endToEndMedianMs": 43.2,
    "runnerWallMedianMs": 15,
    "endToEndMinMs": 37.74,
    "endToEndMaxMs": 184.24
  }
}
```

- SQLite 20 行事务中位 0.018ms（WAL, synchronous=NORMAL；`dbBytes` 仅主库文件，WAL 另计），远低于 10ms 目标；真实评测落库需以完整表结构复测。
- 500×8 榜单计算+序列化 0.473ms / 35.1KB，低于 5ms 目标。
- runner 端到端中位 **43.2ms**（Node spawn + Job + 进程 + IO），略高于设计 5.1 的“单测试点框架开销 ≤40ms”；常驻 runner 或减少 spawn 是 Phase 1 的优化项。runner 内部 wallMs 中位 15ms。
- 评测冷启动最坏 184ms 属于首轮抖动，需在 Phase 1 做预热与多轮统计。

## 决策记录（Task 8）

1. SQLite：采用 `node:sqlite`（Node 24 内置），不引入 better-sqlite3 原生依赖；Electron 版本锁定 45.x（内置 Node 24）。目标机需跑 `tools/check-sqlite-electron.cjs` 自检。
2. Runner：独立 `ojrunner.exe` 方案可行；TLE/MLE 判定按实测证据组合；Phase 1 评估常驻 runner 以压低 43ms 端到端开销。
3. testlib：按 exit 7 + stderr `points <num>` 解析 `quitp`；`_pc(N)`/result file 暂不支持，Phase 1 按需扩展。
4. Electron：本会话无法启动（宿主限制），桌面壳代码保留，目标机复验后再决定是否需要替换壳方案。
5. 计划偏差：Task 4 的 Playwright 冒烟测试由 `npm test` 之外单独执行；在目标机验证前，Phase 1 不依赖桌面壳，可先用 CLI/浏览器开发。


