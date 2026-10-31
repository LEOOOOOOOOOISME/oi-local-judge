# Phase 3H 交互题结果

日期：2026-11-01
分支：`main`

## native 交互执行器

新增 `native/interact/src/main.cpp` → `ojinteract.exe`：

- 协议：
  - `interactor <input> [<answer>]`
  - interactor stdin = 选手 stdout；interactor stdout = 选手 stdin
  - interactor 退出码 0 = AC，1 = WA，其他 = SE；选手非 0 = RE
- 两个进程在同一 Job Object 中（KILL_ON_JOB_CLOSE、ActiveProcessLimit=2、ProcessMemoryLimit=题目内存），wall 超时终止整个 job。
- 输出一行 JSON：`ok/interactorExit/contestantExit/timedOut/cpuMs/wallMs/peakMemKb/verdict`。
- 构建：`npm run build:interact` 或 `npm run build:native`（runner + interact）。

## 后端

- `config.interactRunnerPath`（`OIJ_INTERACT_RUNNER`，默认 `native/interact/out/ojinteract.exe`）。
- `judge/interactive.ts`：spawn `ojinteract`、解析 JSON、超时兜底。
- `pipeline.ts` 新增 `type='interactive'` 分支：
  - 编译选手程序 + interactor 资产（`-I vendor`，60s 超时）
  - 每个测试点运行一次交互，AC 得该点分值；TLE/RE/WA/SE 0 分
  - 结果写入 `test_results`，整体 AC/PC/WA
- 选手提交仍为 cpp17 代码；interactor 通过管理端 7 类资产上传。

## 前端

- 题目类型“交互题”已有；ProblemPage 增加提示：“程序通过 stdin/stdout 与交互器实时交互，请按题面协议读写并刷新输出”。
- 管理端 interactor 资产卡沿用现有 7 类资产上传/编译/源码查看。

## 验证

- 新增 `interactive.test.ts`：fixture interactor + 正确选手 → AC 100；错误选手 → WA 0。
- 手工 `ojinteract` 运行：AC（interactor 0/contestant 0）、WA（interactor 1）。
- 全量：**29 个测试文件、92 个用例全部通过**（约 47s）。
- `npm run build` / `tsc` 通过；交互执行器构建通过。

## 遗留

1. interactor 协议是自定义 argv/stdin/stdout 约定，不兼容 testlib interactor 的 `quitf`/token 协议（需后续适配）。
2. 超时统一按 wall 计时；CPU 时间未单独限制。
3. 交互发生在本地进程管道，未做 Windows 作业对象下的额外句柄隔离审计。
4. 未做交互题大数据下的吞吐基准。
5. Electron 目标机验证仍待做。
