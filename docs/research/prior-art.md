# OI 本地 Judge 系统可复用前人实现调研

> 调研时间：2026-10-31。许可证取自各仓库元数据；标注「待核实」处未逐行读源码验证。

**摘要**：评测内核优先复用 testlib.h（MIT），题目/比赛模型参考 Hydro 与 Lemon，查重采用 Dolos（MIT）。Windows 沙箱无现成 MIT 组件，需参考 Lemon 自研 Job Object 封装；go-judge 仅适用于 Linux 评测后端。Lemon 系（GPL）与 Hydro（AGPL）只借鉴设计，不复制代码。

## 一、评测系统与引擎

| 项目 | 仓库 / 许可证 | 语言 | 核心特点与契合点 |
|---|---|---|---|
| Lemon | https://github.com/Sojiv/Project_lemon ；未标注（原 Google Code 镜像，待核实） | C++/Qt | OI 事实标准：`.cdf` 保存试题与选手、`data/`+`source/` 目录、文件 IO 比对、SPJ 双模式、Win32 Job Object 限内存并杀进程树。数据模型与判题流程可借鉴；许可证不明，不可复制代码。 |
| LemonLime | https://github.com/Project-LemonLime/Project_LemonLime ；GPL-3.0 | C++/Qt | Lemon 跨平台重制，支持传统/提交答案/交互（NOI 风格 C++）/通信题，测试点依赖表达子任务，界面成熟。GPL 有传染性，仅借鉴。 |
| Cena | https://github.com/oi-archive/cena ；GPL-2.0 | Pascal | 老一代 NOIP 本地评测，题目目录与 SPJ 约定清晰；技术栈过时，仅参考。 |
| Hydro | https://github.com/hydro-dev/Hydro ；AGPL-3.0 | TypeScript/Node | 题目、比赛、榜单、子任务、SPJ、交互题齐全；judge 为独立进程，`config.yaml` 配置服务地址、并行度、临时目录与 sandbox runner，经 WebSocket 领任务（字段名待核实）。最值得对标的整体架构。 |
| UOJ | https://github.com/UniversalOJ/UOJ-System ；MIT | PHP/JS + C++ judge | 老牌 OJ，Web 层与题目/比赛模型可复用；judge 依赖 Linux 沙箱，Windows 不可直接用。 |
| LibreOJ | https://loj.ac ；未完整开源（待核实） | — | 基于 UOJ 定制，仅参考交互与题面。 |
| Vijos vj4 | https://github.com/vijos/vj4 ；AGPL-3.0 | Python | Web 与评测分层清晰，维护放缓；参考 REST 与题目结构。 |
| go-judge | https://github.com/criyle/go-judge ；MIT | Go | HTTP/gRPC 沙箱服务，隔离基于 Linux namespace/cgroup/seccomp，另有 FFI 嵌入模式；Windows 无对等隔离实现，只能参考其 API 与结果模型。 |
| go-sandbox | https://github.com/criyle/go-sandbox ；MIT | Go | Linux 沙箱库（ptrace/unshare/namespace/cgroup/seccomp），仅 Linux；接口设计可参考。 |
| DMOJ judge | https://github.com/DMOJ/judge-server ；AGPL-3.0 | Python | 执行器抽象、交互题与 checker 协议设计优秀；以 Linux pty 沙箱为主。 |
| CMS | https://github.com/cms-dev/cms ；AGPL-3.0 | Python | IOI 式赛制、子任务、ranking；只参考评分模型。 |
| DOMjudge | https://github.com/DOMjudge/domjudge ；GPL-2.0 | PHP | `runguard` 沙箱与封榜实现值得读；Linux 专用。 |
| testlib.h | https://github.com/MikeMirzayanov/testlib ；MIT | C++ | checker/validator/interactor 事实标准：`registerTestlibCmd` + `readAns/readOut` + `quitf(_ok/_wa/_pe)`；`registerValidation` + `inf`；`registerInteraction` + `tout/ouf`。可直接 vendored。 |

关键说明：

- **题目格式**：Lemon 用 `.cdf` 组织比赛与题目（字段细节待核实）；Hydro 的题目目录 + `problem.yaml` + Evaluator 更适合作为新系统内部格式的迁移目标。
- **Windows 判题**：Job Object 设置 `JOB_OBJECT_LIMIT_PROCESS_MEMORY`、`KILL_ON_JOB_CLOSE`、进程数上限；`GetProcessTimes` 取内核+用户态时间，内存取 PeakWorkingSetSize 或 Job 统计（Lemon 具体口径待核实）。
- **SPJ 双模式**：Lemon 兼容 testlib 校验器，另有「lemon 模式」——校验器收到 6 个参数（标准输入、选手输出、标准答案、满分、分数输出文件、额外信息文件），得分写入文件，任意语言可实现。该协议简单可靠，建议作为自研 SPJ 基线并保留 testlib 兼容。
- **子任务**：LemonLime 用测试点依赖（被依赖编号必须小于当前测试点）表达子任务；Hydro 用可编程 Evaluator，更灵活。建议统一为「测试点结果 + 子任务聚合」。

## 二、代码查重

| 方案 | 地址 / 许可证 | 语言 | 算法与成熟度 |
|---|---|---|---|
| Dolos | https://github.com/dodona-edu/dolos ；MIT | TypeScript | 基于 tree-sitter 的 AST/token 化 + 指纹匹配（winnowing 类），支持 C/C++，带 Web 可视化，活跃。首选。 |
| JPlag | https://github.com/jplag/JPlag ；GPL-3.0 | Java | token 化 + Greedy String Tiling，支持 Java/C/C++/Python 等，成熟；GPL 不宜并入闭源代码，可独立 CLI 调用。 |
| MOSS | https://theory.stanford.edu/~aiken/moss/ ；闭源 | — | winnowing 鼻祖，需把代码上传 Stanford，有隐私与网络风险。不采用。 |
| simhash | 无单一权威实现 | 多语言 | 64 位指纹 + 汉明距离，粗筛快；对改变量名、重排不敏感，误报高，只作预筛。 |

OI 场景须先做去注释、标识符归一化、模板/宏展开处理。Lemon、UOJ/LOJ、Hydro 的查重实现均未见可独立复用的开源模块（待核实），OI 社区常见做法是导出源码后离线跑 MOSS/Dolos；MOSS 论文的 winnowing 有多语言复现，但质量参差。

## 三、可直接复用的组件

- **编辑器**：Monaco Editor（https://github.com/microsoft/monaco-editor ，MIT），C++ 语法高亮与基础编辑，Electron 与浏览器通用。
- **题面渲染**：markdown-it（https://github.com/markdown-it/markdown-it ，MIT）、KaTeX（https://github.com/KaTeX/KaTeX ，MIT）、highlight.js（https://github.com/highlightjs/highlight.js ，BSD-3-Clause），组合成熟。
- **沙箱**：Windows 无现成 MIT 库，需自研 Job Object 封装（参考 Lemon）；若接受 Linux 评测容器（WSL2/虚拟机），可用 go-judge（MIT）作 sidecar。
- **赛制/榜单**：无成熟独立库；Hydro、DOMjudge、CMS 的榜单、封榜、子任务聚合可借鉴，建议自研（ICPC 罚时、OI 总分）。
- **testlib.h**（MIT）：随题目包分发，checker/validator/interactor 兼容 Codeforces/Polygon 生态。

## 四、复用建议

**直接 vendored（保留版权与许可声明）**

1. testlib.h：单头文件，随包分发并附 MIT 声明。
2. Monaco、markdown-it、KaTeX、highlight.js：npm 依赖并锁版本。
3. Dolos（MIT）：以独立 Node 服务集成，保留 LICENSE。
4. 仅当评测后端采用 Linux 容器（WSL2/独立评测机）时，go-judge（MIT）作 sidecar；Windows 原生路线不适用。
5. UOJ（MIT）可复用少量 Web 组件，但 PHP 栈不建议混用。

**借鉴算法重写（规避 GPL/AGPL 传染）**

1. Windows 沙箱：参考 Lemon 的 Job Object 参数（内存上限、`KILL_ON_JOB_CLOSE`、进程数上限）自写封装，时间/内存口径与 Lemon 对齐。
2. 查重：winnowing + AST 归一化自研，参考 Dolos 思路，不复制 GPL 代码。
3. 榜单、赛制、子任务聚合：参考 Hydro/CMS 数据模型自研。
4. 题目包：SPJ 同时兼容 testlib 与 Lemon 六参数模式，自定义内部格式并提供 `.cdf` 导入。

**不采用**

- MOSS：闭源 + 代码外传。
- CMS、DMOJ、DOMjudge：AGPL/GPL 且强依赖 Linux 沙箱，与 Windows 主机路线冲突。
- Cena、Vijos vj4：技术栈过时或维护停滞。
- Hydro、LemonLime 整体：AGPL/GPL，闭源分发或 SaaS 化均有合规风险，只参考设计。

**许可证要点**：MIT/BSD 允许闭源分发，保留版权声明即可；GPL-2.0/3.0 要求衍生作品同样开源（动态链接边界有争议，独立进程调用更安全）；AGPL-3.0 额外覆盖网络服务，修改后在线提供服务也须开源。闭源商业分发时，GPL/AGPL 代码只能「独立进程 + 仅参考」，不得复制进代码库。本文不构成法律意见。
