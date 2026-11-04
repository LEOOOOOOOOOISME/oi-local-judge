# 在线并发压测（维护者）

`tools/bench/online.mjs` 用来复现“300 人在线 + 50 并发提交”的 HTTP 负载，输出一份
可对比的 JSON 基线。它**不是**单元测试，也不会改动产品代码：每次运行都会创建一个
一次性数据目录，结束后删除。

- 预计耗时：60 秒在线阶段 + 判定阶段（默认参数约 1~2 分钟）。
- 适用：发版前回归、4C/8G 目标机验收、性能问题定位。
- 不适用：作为 SLA 承诺。结果只代表当次机器、当次数据规模下的实测值。

> 2026-11 的基线在 16 核 i5-13500H 开发机采集；4C/8G 目标机需要按下方步骤
> 自行跑正式验收，本文不预设其数值。

---

## 1. 它做了什么

1. 在临时目录里启动**真实**的 `buildApp`（Fastify + 文件 SQLite）和
   `startScheduler`（真实编译、真实 native runner 判题），监听 `127.0.0.1:0`。
2. 导入 `tools/seed/sample-problem`；创建 1 场 running 的 OI 比赛，加入这道题，
   并把全部压测用户加成 `accepted` 参与者。
3. 用户登录态通过直接签发的会话 cookie 提供（复用同一个密码哈希，不做 N 次
   scrypt），所以 300 个用户不会拖慢准备阶段。
4. **在线阶段**：`OIJ_BENCH_USERS` 个虚拟用户持续轮询三个接口：
   - `GET /api/contests/:id`
   - `GET /api/contests/:id/official-ranking`
   - `GET /api/contests/:id/team-ranking`

   全局在途请求数由 `OIJ_BENCH_CONCURRENCY` 限制（信号量），因此是“300 个在线
   用户、最多 50 个请求同时在飞”，而不是 300 个瞬间并发。
5. **提交阶段**：`OIJ_BENCH_SUBMISSIONS` 个**不同**用户同时
   `POST /api/submissions`，提交 sample problem 的 C++17 AC 源码，统计 2xx / 429 /
   5xx，然后等待判题队列排空（有超时上限），计算判定吞吐。

数据目录默认建在仓库的 `runtime/bench-online-*`（已被 `.gitignore` 忽略）。
放在仓库内而不是系统 `%TEMP%`，是因为部分 Windows 沙箱环境会拒绝 native runner
在 `%TEMP%` 下创建输出文件；若目标机允许，也无需改动。

---

## 2. 用法

```bash
# 默认：300 用户 / 50 并发 / 60 秒在线 / 50 次提交
npm run bench:online

# 等价的直接调用（需要 tsx）
npx tsx tools/bench/online.mjs

# 小规模冒烟（先确认环境可用，约 5 秒）
OIJ_BENCH_USERS=30 OIJ_BENCH_CONCURRENCY=10 OIJ_BENCH_DURATION=5 \
  OIJ_BENCH_SUBMISSIONS=5 npx tsx tools/bench/online.mjs

# 4C/8G 长时间验收（2 小时在线）
OIJ_BENCH_USERS=300 OIJ_BENCH_CONCURRENCY=50 OIJ_BENCH_DURATION=7200 \
  npm run bench:online
```

PowerShell 写法：

```powershell
$env:OIJ_BENCH_USERS='300'
$env:OIJ_BENCH_CONCURRENCY='50'
$env:OIJ_BENCH_DURATION='60'
$env:OIJ_BENCH_SUBMISSIONS='50'
npm run bench:online
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OIJ_BENCH_USERS` | `300` | 参赛用户数（也是虚拟用户数） |
| `OIJ_BENCH_CONCURRENCY` | `50` | 在线阶段全局在途请求上限，自动不超过用户数 |
| `OIJ_BENCH_DURATION` | `60` | 在线阶段秒数 |
| `OIJ_BENCH_SUBMISSIONS` | `50` | 提交阶段的不同用户数，自动不超过用户数 |
| `OIJ_BENCH_JUDGE_TIMEOUT_MS` | `180000` | 等待判题队列排空的上限 |
| `OIJ_BENCH_REQUEST_TIMEOUT_MS` | `30000` | 单请求超时 |
| `OIJ_BENCH_POLL_MS` | `20` | 判题调度轮询间隔 |
| `OIJ_JUDGE_CONCURRENCY` | `min(4, CPU 核数)` | 真实判题并发度 |
| `OIJ_RUNNER` / `OIJ_GXX` | 自动探测 | native runner / 编译器路径 |

### 前置条件

- Node.js 24+、已 `npm install`（`tsx` 在 devDependencies 里）。
- 已构建 native runner：`npm run build:runner`，产物
  `native/runner/out/ojrunner.exe` 存在。
- `g++` 可用（`OIJ_GXX` 可显式指定）。
- 运行目录可写（默认写仓库 `runtime/`）。
- **不要**在压测期间同时跑 `vitest`、`npm run build` 或另一个压测。

---

## 3. 输出与指标

stdout 是一份 JSON。主要字段：

| 字段 | 含义 |
|---|---|
| `users` / `concurrency` / `durationSec` | 本次实际使用的参数（以实际为准，不伪造） |
| `machine` | CPU 型号/核数、总内存、起始空闲内存、Node 版本 |
| `requests` | 在线阶段总请求数 |
| `statusCodes` | 在线阶段 HTTP 状态码分布 |
| `errors` | 在线阶段的失败请求数（5xx + 网络错误） |
| `errorBreakdown` | `network` / `http5xx` / `otherClientErrors` / `rateLimited` |
| `p50Ms` / `p95Ms` / `p99Ms` / `maxMs` | 在线请求延迟分位数（最近秩） |
| `rps` | 在线阶段实际吞吐（请求数 / 实测在线秒数） |
| `memoryRssMb` / `peakRssMb` | 压测进程（含被测服务）RSS 当前值与采样峰值 |
| `queue.afterSubmit` / `queue.afterDrain` | 提交后与排空后的 submissions/judge_tasks 状态计数 |
| `submissions` | 提交请求状态码、2xx/429/5xx、创建数、提交延迟、verdict 分布、`failedSamples` |
| `judgingThroughputPerSec` | 判定吞吐 = 已判定提交数 / 从提交开始到队列排空的秒数 |
| `health` | 在线前后 `/api/health` 结果 |
| `pass` / `failures` | 本次是否通过以及失败原因 |

### 通过标准与退出码

满足以下全部条件时 `pass=true`、退出码 `0`：

- 在线阶段至少发出 1 个请求；
- 在线阶段 **5xx + 网络错误** 比例 ≤ 1%；
- `POST /api/submissions` 没有 5xx、没有网络错误；
- 队列在 `OIJ_BENCH_JUDGE_TIMEOUT_MS` 内排空，且至少接受 1 个提交；
- 前后两次 health 检查都返回 `ok: true`。

**429 单独统计（`submissions.rateLimited429`），不计入失败。** 压测用不同用户提交，
正常不应触发冷却；若出现 429，说明冷却键或用户隔离有问题。

---

## 4. 4C/8G 验收步骤

目标：在 4 核 8 GB 的目标机上得到一份可归档的“300 在线 + 50 并发”基线。

1. **准备干净环境**：关闭浏览器、IDE、同步盘、杀毒扫描等占用 CPU/内存的程序；
   确认任务管理器里没有残留的 `ojrunner.exe` / `node.exe` 压测进程。
2. **构建与自检**：
   ```powershell
   npm ci
   npm run build:runner
   npm run bench:online   # 先跑一次默认参数，确认 pass=true
   ```
   第一次编译并预热判题缓存，正式数据以第二次为准。
3. **正式采集**（建议 2 小时在线阶段）：
   ```powershell
   $env:OIJ_BENCH_DURATION='7200'
   npm run bench:online | Tee-Object -FilePath bench-4c8g.json
   ```
   若只需发版前快速回归，用默认 `OIJ_BENCH_DURATION=60`，并在记录里写明。
4. **记录机器信息**：JSON 里的 `machine` 字段即 CPU/内存快照；同时在报告中写明
   操作系统版本、是否虚拟机、是否与其它服务共享。
5. **判读**：
   - `errors` 必须为 0；`pass` 必须为 `true`，否则先查 `failures`。
   - `p95` / `p99` 与上次同机基线对比；突然翻倍通常意味着数据量增长、慢查询或
     外部程序争抢 CPU。
   - 2 小时长跑时观察 `memoryRssMb` 与 `peakRssMb`：应稳定在平台期，而不是持续
     线性上涨（线性上涨说明泄漏或未释放的判题缓存）。
   - `judgingThroughputPerSec` 用于估算考试场景的判题消化能力；它受
     `OIJ_JUDGE_CONCURRENCY`、编译器和题目数据量影响，不能直接外推到其它题目。
   - `submissions.verdicts` 中 AC 应占绝大多数；出现 CE/SE 说明编译器/runner
     配置不对，此时吞吐没有参考价值。
6. **归档**：把 JSON、机器信息、commit（或版本号）和运行命令写进验收记录。

---

## 5. 限制与免责

- 压测进程内同时跑 HTTP 服务、SQLite 和判题器，**会与真实部署的进程/资源隔离
  方式不同**；数值用于横向对比和回归，不代表生产容量。
- 结果依赖 CPU、内存、磁盘（WAL/编译缓存）、杀毒软件、编译器版本和题目数据；
  同一台机器换一个 commit、换一个题目都会变化。
- 默认 sample problem 只有 2 个测试点，判题很快；真实题目的编译时间与测试点数量
  会显著改变提交阶段和 `judgingThroughputPerSec`。
- 本工具**不提供任何性能保证或 SLA**；4C/8G 的验收结论必须由目标机实测数据支撑。
- 运行结束应无残留：正常退出时临时目录 `runtime/bench-online-*` 会被删除。
  若进程被强制中断（包括 Ctrl+C、任务管理器结束进程），请手动删除该目录，并
  确认没有 `ojrunner.exe` 残留。
