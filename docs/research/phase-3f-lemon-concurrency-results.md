# Phase 3F Lemon 题包与 50 并发基准

日期：2026-11-01
分支：`main`

## Lemon `.cdf` 适配

- `parseCdf`：读取 `<name>/<title>`、`<time_limit>`（秒→ms，>100 视为已是 ms）、`<memory_limit>`、`<input_file>/<output_file>`、`<test_points>`。
- `importLemonProblem`：定位根/单层 `.cdf`，配对 `data/*.in|out`（含 `.ans`），读取 std/checker/maker，生成临时 `problem.json` 后复用标准导入。
- `buildCdf` + `GET /api/admin/problems/:id/export-lemon`：导出 `problem.cdf + data/* + std.cpp/checker.cpp/maker.cpp`。
- `POST /api/admin/problems/import-zip` 自动识别链：`problem.json` → Cena → Lemon；返回 `format`。
- 前端题目页新增“导出 Lemon 题包”（`lemon-<id>.zip`）。

## 并发基准

新增 `npm run bench:concurrency`（`tools/bench/concurrency.mjs`）：

- 50 个提交、judgeConcurrency=2、同一 A+B std（编译缓存命中）、sample problem。
- 结果：**50/50 AC，总耗时 3624ms，平均 72.48ms/提交，吞吐 13.8 提交/s**。
- 评测瓶颈仍为进程启动 + 测试点轮次；2 槽配置下 50 并发在数秒内完成。
- 可通过 `OIJ_BENCH_SUBMISSIONS` / `OIJ_BENCH_CONCURRENCY` 调整。

## 验证

- 新增 `lemon.test.ts`（CDF 解析、秒→ms、test_points、导入、CDF 转义/导出）。
- 全量：**28 个测试文件、89 个用例全部通过**（约 48s）。
- `npm run build` 通过；`npm run bench:concurrency` 通过。
- 前端 tsc/vite build 通过；Lemon 导出按钮未单独 Edge 下载 E2E（Cena/OI 已实测，共用下载逻辑）。

## 遗留

1. Lemon CDF 仅解析常用顶层标签；不支持 checker 参数/comparison_mode 的完整语义、子任务、交互题。
2. 导入的 checker 作为资产保存，但默认仍 builtin 比较，需手动切换 checkerMode。
3. 并发 bench 复用缓存编译与同一源码；50 个不同源码的编译竞争未压测。
4. 交互题仍未实现（需 runner 双向管道）。
5. Electron 目标机未验证。
