# Phase 2B 客观题与混合作答结果

日期：2026-11-01
分支：`main`
范围：客观题（单选/多选/判断/填空）、管理端可视化编辑器、选手作答、自动评分、混合组卷

## 数据与评分

- `problems.type='objective'`；`objective_json` 保存：
  `{questions:[{id,kind,stem,options?,answers?,points,partial?,ignoreCase?,ignoreWhitespace?}]}`
- 公开 `GET /api/problems/:id` 移除每题 `answers`；管理 `GET /api/admin/problems/:id` 返回完整答案。
- 提交：`POST /api/submissions {problemId, language:'objective', code:'{"answers":[...] }'}`
- 评分规则：
  - 单选/判断：完全匹配得满分，否则 0；
  - 多选：错选 0；全对满分；漏选且开启 `partial` 按比例得分（PC）；
  - 填空：答案命中可接受集合（默认忽略大小写/空白），否则 0；
  - 每题生成一条 `test_results`（testcaseId = questionId），总分为各题之和；整体 AC/PC/WA 由 `decideOverallVerdict` 得出。
- 客观题无需测试数据/资产；普通题与客观题共用提交、榜单、比赛引擎。

## 管理端

- 新建题目类型增加“客观题”；编辑器新增“客观题”Tab：
  - 增删题目；单选/多选/判断/填空；题干；选项 key/text 增删；
  - 正确答案（Radio/Checkbox/判断/填空多行）；分值；多选部分给分；填空忽略大小写/空白；
  - 保存前校验；保存 `PUT objective`；显示题数与总分；
  - 客观题隐藏程序资产/测试数据/生成对拍/校验自测 Tab。

## 选手端

- 题目页 type=objective 时：题面 + 逐题作答 UI（Radio/Checkbox/判断/填空）、每题分值与总分、已作答计数；无代码编辑器。
- 提交 JSON（language=objective）→ 提交详情；详情显示题号/题目/verdict/得分/信息 + 只读答案 JSON，不显示源代码。
- 普通题代码提交路径保持原样。

## 验证

- 后端：`objective.test.ts` 3 例（单选/多选部分分/填空、错选与未作答、端到端评分与公开答案隐藏）。
- 全量：**22 个测试文件、79 个用例全部通过**（约 47s）。
- Edge headless（8790 直出 dist）22 项检查 PASS：
  - 新建客观题 3 题（单选 B 40、多选 A/C 30 部分给分、填空 北京 30），保存/重载配置一致，总分 100；
  - 公开 API 不含 answers，管理 API 完整；
  - 选手作答 3/3 提交，详情 100 分、三题分别 40/30/30 AC，只读答案 JSON；
  - 0 pageerror、0 console.error，1366×768 无横向溢出。
- 截图：`.devdata/tmp/screens-2b/01…05*.png`。

## 兼容修复

- 公开详情对无 `objective.questions` 的普通题不再报错（`{}` 视为无客观题）。
- 比赛内允许提交 `visibility=hidden` 的题目（普通题库仍拒绝）。
- 客观题问题在比赛中的分值由比赛控制台按题编辑；榜单使用提交得分。

## 遗留

1. 判断题型、部分给分提交链路未单独 E2E（编辑器/评分已实现并单测）。
2. 填空是“命中任一可接受答案”，不支持多空/多答案匹配。
3. 客观题从普通题改类型后，旧资产/测试数据仍留库（UI 隐藏）。
4. 客观题暂不支持题目内随机题序/选项乱序、答案解析展示。
5. 比赛内客观题分值需要手工与 objective 总分一致，未自动校验。
6. 未做客观题批量导入（CSV/题库包）。
