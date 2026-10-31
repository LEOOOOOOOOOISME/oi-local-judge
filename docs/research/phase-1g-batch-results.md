# Phase 1G–1H 出题工具与本地批量评测结果

日期：2026-10-31
分支：`main`
范围：generator 造数据、std vs brute 对拍、本地批量评测（zip + 目录层级映射）

## 后端

### 造数据 / 对拍
- 协议：`generator` 可执行文件接收 `argv[1]=seed`，向 stdout 输出测试输入；std 在沙箱运行产生答案。
- `POST /api/admin/problems/:id/generate` Body `{count,seedStart,points}`：
  - 编译 generator/std，逐 seed 生成 `generated-<seed>.in/.out`，追加为测试点（同一 seed 重跑会替换旧条目，不重复追加）。
- `POST /api/admin/problems/:id/stress` Body `{rounds,seedStart}`：
  - 每轮 generator 造输入，std 与 brute 在 Job Object 沙箱运行，逐字节/空白归一化比较；
  - 首个反例保存到 `problems/<id>/stress/seed-<seed>/{input,std.out,brute.out}`；
  - 返回 `passed/skipped/total/mismatch`；std/brute 非 0 退出计入 skipped。
- 测试：`admin-tools.test.ts`（generate 2 条 + 追加分值、stress 首个反例）。

### 本地批量评测
- `POST /api/admin/batch/upload`：zip 原始字节，落盘到 `uploads/batch/<uuid>.zip`，返回路径预览。
- `POST /api/admin/batch/run` Body `{uploadId,problemId,studentLevel,language}`：
  - 1-based 层级：`Alice/main.cpp` + level=1 → Alice；
  - 只识别 `.cpp/.cc/.cxx`，同一学生按路径字典序取首个；
  - 自动创建/复用 `batch_<姓名>` 用户，写入源码并创建评测任务；
  - 批次与条目落库（batch_jobs/batch_items）。
- `GET /api/admin/batch/:id`：返回批次状态与每条提交的 status/verdict/score/time/memory；全部终态时标记 finished。
- 测试：`admin-batch.test.ts`（Alice AC 100、Bob WA 0）。

## 前端

- 题目编辑页新增“生成与对拍”Tab：造数据表单（数量/起始 seed/分值）+ 对拍表单（轮数/起始 seed）；显示 generated seeds、测试点总数、反例 seed/输入/std 输出/brute 输出/path；缺 generator/std/brute 提示。
- 新增 `/admin/batch`“批量评测”向导（admin/setter 可见、懒加载）：
  - zip 选择/拖拽上传、文件路径列表、源文件数、最大深度；
  - 1..6 层 studentLevel 选择 + 实时解析预览（如 `Alice/main.cpp → 选手 Alice`），支持根目录包一层；
  - 选题 + C++17，运行中禁用重复提交；
  - 1s 轮询结果，AC 人数/总人数/平均分汇总，表格 + CSV 导出（含 BOM）。
- 管理端仍未进入首屏；首屏 JS gzip 约 268KB。

## 实测

- 全量测试：**20 个测试文件、73 个用例全部通过**（约 48s；Vitest `maxWorkers=4`，编译超时提高到 60s 以避免并发抖动）。
- Edge headless：
  - Phase 1G 33 项：生成 2 条测试点、发现 seed 1 反例（输入 1 2，std 3，brute 4）、2/2 无异常、错误路径。
  - Phase 1H 32 项：错误 zip、level=1 预览、level=2 层级不足、运行 Alice AC/100 + Bob WA/0、汇总、CSV、根目录包一层。
- `npm run build` 通过；生产 Fastify 直出 dist 可访问管理页/批量页。

## 截图

- `.devdata/tmp/screens-1g/`：generate-success、stress-mismatch、stress-clean、results-independent、missing-generator
- `.devdata/tmp/screens-1h/`：error-zip、upload-preview、preview-level2、run-error-no-sources、batch-finished、wrapped-level2、result-card

## 遗留

1. 批次结果仅页面状态，无批次历史/按 ID 打开/重跑入口。
2. 同一学生多源文件时，UI 预览排序与后端 zip 条目顺序已统一为字典序，但“多文件题”仍不支持。
3. 批量只支持 C++17、单题；多题/跨题目录映射未做。
4. generate 使用同一 seed 会覆盖旧生成点（按路径去重），但不会删除不再使用的旧文件。
5. stress 的 std/brute 非 0 退出计入 skipped；若希望直接判失败可后续调整。
6. 对拍/生成结果不持久化到 DB（反例文件落盘）。
