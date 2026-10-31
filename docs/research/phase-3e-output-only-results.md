# Phase 3E 提交答案题（output-only）结果

日期：2026-11-01
分支：`main`

## 后端

- `problems.type='output-only'`，测试数据仍为 `.in/.out` 测试点（无需 std/checker）。
- `GET /api/problems/:id/answer-files` → `[{id,ordinal,points,inputUrl}]`（仅 output-only 公开题）。
- `GET /api/problems/:id/answer-files/:testcaseId` → 下载输入文件（text/plain，防路径穿越）。
- 提交：`POST /api/submissions {problemId, language:'answer', code:JSON.stringify({answers:[{testcaseId,value}]})}`。
- 评分：逐测试点把答案写入临时文件，按 `compare_mode` 与 `.out` 比较；无误编译/沙箱进程；每条 `test_results` 对应 testcaseId，总分为各点之和，整体 AC/PC/WA。
- 未填测试点视为空答案（WA）。

## 前端

- ProblemPage output-only：题面下显示说明、每个测试点序号/分值/输入下载、TextArea；提交 JSON（language='answer'），未填完禁用；隐藏代码编辑器/语言选择。
- SubmissionDetail：language='answer' 显示“提交答案”、只读答案 JSON、逐测试点 verdict/得分，无源代码。
- 管理端：新建“提交答案”类型；提示无需 std/checker，数据仍用 .in/.out；保留数据 Tab。
- languageLabel 增加 answer → “提交答案”。

## 验证

- 后端：`output-only.test.ts`（2 测试点，一对一错 → 50 分 PC，结果 AC/WA）。
- 全量：**27 个测试文件、88 个用例全部通过**（第二次运行确认；首次运行 1 例并发抖动，复跑通过）。
- Edge headless（8790 直出 dist）17 项检查 PASS：
  - 新建 output-only 题、导入 2 组数据、每点 50 分；
  - 选手端 2 个下载链接/2 个 TextArea、无代码提交；
  - 下载输入得到 `1\n`；
  - 一正一误提交 → 50 分/PC，结果 50/0，语言“提交答案”，只读答案 JSON；
  - 0 pageerror/console.error，1366×768 无横向溢出。
- 截图：`.devdata/tmp/screens-3e/01…04*.png`。

## 遗留

1. 必须所有测试点都填写才能提交；无草稿/自动保存。
2. 结果表序号由当前 answer-files 映射，测试点删除/重排可能影响历史展示。
3. 未测空答案、多行/特殊字符输出的比较边界（按 compareMode 默认 ignore-trailing）。
4. 管理端仍显示程序资产 Tab（仅提示无需）；未在比赛中单独验证 output-only 计分。
5. 交互题仍未实现（需要 runner 双向管道）。
