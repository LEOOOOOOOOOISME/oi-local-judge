# Phase 1D–1F 管理端可视化结果

日期：2026-10-31
分支：`main`
范围：题目创建/编辑、7 类程序资产、数据 zip 导入、validator、std 自测、可见性与字段清空

## 管理端功能

| 页面/能力 | 说明 |
|---|---|
| `/admin/problems` | 管理列表（含隐藏题）、可见性列、新建题目 Drawer（标题/类型/时限/内存/难度/IO/文件名/标签/题面） |
| 基本信息 Tab | 编辑标题/类型/难度（可清空）/标签/时限/内存/IO 模式/输入输出文件名/题面/可见性/checkerMode/compareMode，PUT 保存 |
| 程序资产 Tab | std、checker、validator、generator、interactor、judger、brute 七类卡片；拖拽/选择上传、源码查看、编译（成功/失败/缓存命中）、删除；checker 选 testlib/lemon 并回显当前模式；judger 作为 Lemon 六参数 SPJ 接入 |
| 测试数据 Tab | zip 导入（.in/.out 按名配对）、测试点表（序号/输入/输出/分值/子任务/依赖）、行内改分并 PUT 保存；缺输出/不安全路径错误提示 |
| 校验与自测 Tab | validator（stdin，自动 CRLF 归一化）逐点结果；std 自测（沙箱运行 std，逐点 verdict/时间/内存/得分）双面板；无 validator/std/数据/编译失败均有明确提示 |
| 权限 | admin/setter 显示“管理”；非管理员直接访问 403；隐藏题公开详情 404、公开题库不显示 |

## 后端 API（均 admin/setter）

- `GET /api/admin/problems`（含 hidden）、`GET /api/admin/problems/:id`
- `POST /api/admin/problems`、`PUT /api/admin/problems/:id`（支持 difficulty/inputFile/outputFile 置 null）
- `POST /api/admin/problems/:id/assets/:kind?name=&mode=`（原始字节、Content-Type octet-stream）
- `GET .../assets`、`GET .../assets/:kind/source`、`POST .../assets/:kind/compile`、`DELETE .../assets/:kind`
- `POST /api/admin/problems/:id/data/import?points=`（zip；Zip Slip 防护）
- `GET/PUT /api/admin/problems/:id/testcases`
- `POST /api/admin/problems/:id/validate`（testlib validator，stdin）
- `POST /api/admin/problems/:id/self-test`（std 沙箱逐点运行，接 checker）
- `problem_assets` 表（kind/name/path/language/sha256/size/updated_at），迁移含增量补列

## 实测

- `admin-problems.test.ts` 5 例：创建题/上传 std/编译/源码/zip 导入/改分/validator/self-test/Zip Slip/403。
- 全量测试：**18 个测试文件、70 个用例全部通过**（为降低沙箱并发抖动，Vitest `maxWorkers=4`；文件 IO/SPJ fixture 时限调到 5s）。
- Edge headless（后端 8790 直出 dist）：Phase 1D 16/16、扩展 11/11；Phase 1E 30/30；Phase 1F 34/34；0 pageerror、0 console.error、1366×768 无横向溢出。
- 首屏 JS gzip 约 268KB（管理端懒加载，未进首屏）；管理端 chunk：AdminProblemsPage ~7.5KB、AdminProblemPage ~8.2KB、admin 共享 ~8.1KB。
- 截图：`.devdata/tmp/screens-1d/`、`screens-1e/`、`screens-1f/`（gitignored）。

## 关键设计点

- 上传走原始字节（octet-stream/zip），不引入 multipart 依赖；zip 用 fflate 解压并做路径穿越校验。
- 资产按 `(problem_id, kind)` 唯一；checker/judger 上传后自动写 `problems.checker_path/checker_mode`。
- 校验器/生成器属于可信程序，直接 spawn；std/选手程序走 Job Object runner。
- 编译缓存复用 `cache/programs`、`cache/checkers`；validator 编译器带 `-I vendor`。
- testlib validator 在 Windows 管道下需要 CRLF，runner 读取输入时统一归一化。
- 隐藏题在公开 API 404，管理端通过 admin API 访问。

## 遗留

1. `GET /api/problems/:id` 仍不返回测试点数量/子任务详情（管理端只显示测试点表）。
2. 题目包导入适配器（Lemon/Cena/CSP）与导出未做；当前是自定义目录 + zip 数据。
3. generator 运行/造数据、std vs brute 对拍、interactor 执行未做（UI 标 Phase 1G）。
4. 编译失败信息包含服务器绝对路径（本地管理场景可接受）。
5. 自测结果不持久化；无数据时后端 200 + 0 分，由 UI 提示。
6. 前端隐藏题在前台不可见；比赛仍可引用隐藏题（比赛内可见）。
