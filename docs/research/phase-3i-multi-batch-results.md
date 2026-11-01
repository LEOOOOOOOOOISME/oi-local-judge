# Phase 3I 批量评测多题目录结果

日期：2026-11-01
分支：`main`

## 背景

最初的批量评测只支持“一个批次一个题目”，虽然能解析学生层级，但没有题目层级：同一学生目录下多题会被当成一个题目、只取第一个源文件。该场景现已补齐。

## 后端

- `POST /api/admin/batch/run` 新增：
  - `problemLevel`（1..6，0/省略=单题模式）
  - `problemMap?: Record<string, number>`（文件夹名 → 题目 ID）
- 多题模式路径：`学生层级/题目层级/main.cpp`：
  - 数字文件夹自动按题目 ID 解析；
  - 非数字文件夹需 problemMap；
  - 每学生+题目一条提交，重复源文件按字典序取第一个；
  - 未映射文件夹返回 `UNMAPPED_PROBLEMS`。
- `batch_items.problem_id` 落库；结果/列表返回 `problemId/problemTitle`；多题批次 `problem_id=0` 表示混合。
- 测试：`admin-batch.test.ts` 新增多题用例（3 条提交、problemTitle 校验）。

## 前端

- 批量页新增“题目层级”（不启用/1..6）：
  - 多题模式显示“文件夹 → 题目”映射表；数字文件夹自动映射，非数字手动选择，未映射标红并禁用开始。
  - 预览显示“5 学生 × 2 题 · 9 条”及逐条学生/题目/源文件。
  - 运行请求多题模式不传 problemId，传 problemLevel + problemMap。
- 结果表新增“题目”列；CSV 增加题目列；汇总增加学生数/题目数，区分 AC 数量/总提交与单题 AC 人数/总人数。

## 演示文件

- `runtime/test-data/batch-multi.zip`（学生层级 1、题目层级 2）
- `runtime/test-data/batch-multi-wrapped.zip`（学生层级 2、题目层级 3）
- `runtime/test-data/batch-multi/` 源码与 `expected-results.txt`

结构：

```
Alice/1/main.cpp   Alice/3/main.cpp
Bob/1/main.cpp     Bob/3/main.cpp
Carol/1/main.cpp   Carol/3/main.cpp
Dave/1/main.cpp    Dave/3/main.cpp
Eve/1/main.cpp
```

题目 1=A+B，题目 3=A-B。实测结果：

- Alice：P1 AC 100、P3 AC 100
- Bob：P1 WA 0、P3 WA 0
- Carol：P1 TLE 0、P3 AC 100
- Dave：P1 CE 0、P3 RE 0
- Eve：P1 AC 100（P3 缺失）

共 9 条提交、5 学生、2 题目，4 AC，平均 44.4。

## 验证

- Edge headless 20 项检查 PASS：自动映射、9 条结果、CSV 题目列、wrapped 层级、未映射阻止。
- 后端多题测试通过。
- 全量测试：**94/94 通过**（首次并发抖动 1 例，复跑通过）。
- `npm run build` 通过。
- 截图：`.devdata/tmp/screens-3i/01…05*.png`。

## 遗留

1. 数字文件夹自动映射不可清除；非数字需手动选择。
2. 结果表全量渲染 + 1s 轮询，未分页。
3. 同学生同题目多源文件只取字典序第一个，不支持多文件题。
4. 题目删除后结果回退显示 `#problemId`。
5. 无批次重跑按钮。
