# 项目进度

> 每轮结束时更新本文件，并先提交代码。提交说明写清“做了什么、为什么、边界”。

## 2026-11-06 / Round 148（rc.7 迁移热修 → rc.8）

### 人工报告

`npm start` 在旧库上失败：

```text
Error: no such column: status
    at migrate (apps/server/dist/storage/migrate.js)
```

### 根因

- rc.6 的 `batch_items` 没有 `status`
- `SCHEMA` 在 `ensureColumn` 之前执行
- `SCHEMA` 内创建 `idx_batch_items_batch_status(batch_id, status)` 失败

### 修复

- 把该索引移出 `SCHEMA`
- 在 `ensureColumn` 补齐 `status/error_code/error_message` 后创建索引
- 新增回归测试：构造 rc.6 风格 `batch_items`，`migrate()` 不抛错并补齐列/索引
- 用真实旧 `runtime/db/oijudge.db` 启动：`/api/health` 200
- 修正 update-check 测试 fixture：使用 `rc.999`，避免版本 bump 后误判

### 提交

- `ae3e867 fix: migrate legacy batch_items before status index`
- `5163fbc test: keep update-check fixture newer than rc.7`
- `f32ad8d release: prepare v1.1.0-rc.8 hotfix`

### rc.8 发布

- Tag：`v1.1.0-rc.8`
- CI run：`42235882817` — **success**
- Release：https://github.com/LEOOOOOOOOOISME/oi-local-judge/releases/tag/v1.1.0-rc.8
- 资产：
  - `OiJudge-Setup-1.1.0-rc.8.exe` 252,539,081 B
  - `oi-local-judge-1.1.0-rc.8-win-x64.zip` 360,004,526 B
- prerelease：是

### 验证

- 全量 `npx vitest run --maxWorkers=2`：**110 文件 / 1008 用例通过**
- `npm run build`：通过
- 真实旧库启动 migration + `/api/health` 200
- CI 构建/发布全部 success

### 注意

- rc.7 的升级迁移有缺陷，已被 rc.8 取代。
- 已安装 rc.7 的用户升级 rc.8 前仍应备份数据目录。

## 2026-11-06 / Round 147（v1.1.0-rc.7 发布）

### 发布

- 版本：`1.1.0-rc.7`
- Tag：`v1.1.0-rc.7`
- Release：https://github.com/LEOOOOOOOOOISME/oi-local-judge/releases/tag/v1.1.0-rc.7
- CI run：`42231473055` — **success**
- 资产：
  - `OiJudge-Setup-1.1.0-rc.7.exe` 252,538,915 B
  - `oi-local-judge-1.1.0-rc.7-win-x64.zip` 360,004,479 B
- prerelease：是

### 发布内容

- 批量 P0/P1：流式上传/预览/映射/异步/resume/失败隔离
- 批量 CSV/矩阵/Excel/HTML 导出
- 洛谷式 P1001 分类题号
- 题目附件
- 比赛统计仪表盘 + 双 PDF + 5000+ 服务端分页
- 班级/训练统计图表
- 团队成员/参赛资格同步、解散清理、纯团队赛报名
- Electron 打包启动修复、NSIS 安装包、安装态 smoke
- Windows 一键部署脚本
- auth 测试 flake 修复
- `.gitattributes` 强制 mjs LF

### 发布说明

- 已重写 `docs/releases/RELEASE_NOTES.md`
- 包含 rc.7 新增、已有功能、升级说明、已知限制、规划

### 验证

- rc.7 tag 前：
  - 110 文件 / 1007 用例通过
  - build 通过
  - 2 个浏览器 E2E 通过
  - NSIS 安装态 smoke PASS
- CI：
  - portable + ZIP
  - NSIS installer
  - 自动创建 Release 并上传资产

### 仍缺

- 安装包签名/自定义图标
- 冷启动超时 120s
- 4C/8G / 5000×4 验收（压测暂缓）
- Windows SCM 服务化
- 统计打印 E2E

## 2026-11-06 / Round 146（统计分页 + NSIS 安装包 + 训练图表）

### 团队

- `batch-exporter`：task-5 统计 5000+ 服务端分页
- `electron-fixer`：task-6 NSIS 实际构建/安装态
- Lead：训练完成度图表、auth 测试修复、集成

### 本轮提交

- `4737e29 merge: NSIS installer build and install smoke`
- `fe6e3d7 build(release): produce NSIS installer and normalize its integrity`
- `93a7d01 test: make forged-signature check deterministic`
- `8b6ace1 merge: contest statistics server paging`
- `f5e4a15 feat: server-side paging and search for contest statistics results`
- `4f994e9 feat(web): chart training member completion`

### 已完成

1. **统计 5000+ 服务端分页**
   - `/api/contests/:id/official-ranking/page`
   - offset/limit/query
   - 默认 100，上限 500
   - 用户名/姓名/班级搜索
   - 前端成绩表服务端分页、防抖搜索、翻页
   - 分析 PDF/图表仍用聚合接口
   - 打印 results 仍用完整榜
   - 7 个新测试

2. **NSIS 安装包**
   - `OiJudge-Setup-1.1.0-rc.6.exe` 241.1 MB
   - electron-builder 26.18.0 / NSIS 3.0.4.1
   - 修复 `publish: []`
   - 新增 `tools/release/build-installer.mjs`
   - 安装包 Low IL -> Medium 规范化
   - 静默安装 244s（Defender 扫描）
   - 安装态 smoke PASS
   - 静默卸载 5.8s
   - 未签名

3. **训练统计复用**
   - 训练计划成员完成度横向条形图
   - 复用 `StatisticsChart`

4. **测试稳定性**
   - 修复 auth forged-signature 1/64 flake：
     - 翻转解码后的签名字节，而不是 base64url 最后字符
   - 连续 10 次通过

### 验证

- `npx vitest run --maxWorkers=2`：**110 文件 / 1007 用例通过**
- `npm run build`：通过
- `npm run test:e2e:browser`：2 passed
- NSIS 安装态 smoke：PASS
- 工作树：干净

### 已知限制

- 安装包未签名（NotSigned，SmartScreen 提示）
- 默认 Electron 图标
- 首次冷启动 60s 可能不够，建议 120s
- 统计搜索未覆盖排名/分数/题号
- 打印 results 仍传输完整榜
- 5000×4 压测按用户要求暂缓
- rc.7、4C/8G 未做

### 下一轮

1. rc.7 发布准备
2. 安装包签名/图标/冷启动超时
3. 统计打印 E2E
4. Windows 服务化
5. 4C/8G 验收

## 2026-11-06 / Round 145（团队：附件 + 批量 resume + 班级图表）

### 团队

- `electron-fixer`：task-4 题目附件
- `batch-exporter`：task-3 批量 resume + picker
- Lead：班级薄弱标签图表、集成

### 本轮提交

- `e7c7ee5 merge: batch resume and problem picker`
- `26af62e merge: problem attachments`
- `9b4459a feat(web): chart class weak-tag mastery`
- `8a296e0 feat: resume interrupted batch imports and add problem picker scope`
- `f249c71 feat(problems): add problem attachment upload and download`

### 已完成

1. **题目附件**
   - `problem_attachments` 表 + 索引
   - PDF/图片/ZIP，50 MiB
   - UUID 落盘，storage_path 不对外
   - visibility=problem|admin
   - POST/GET/DELETE/下载；replace
   - 管理端附件 Tab、题目页附件 Tab
   - 12 个测试

2. **批量导入 resume + picker**
   - 启动时恢复 importing 任务，不再直接 failed
   - 跳过已导入/已失败项，chunk 事务幂等
   - upload/zip 丢失 -> `BATCH_RESUME_UPLOAD_MISSING`
   - `GET /api/admin/problems/picker?scope=personal|team|public|all`
   - 标题/displayId/标签/数字 id 搜索
   - 批量映射 UI 接入
   - 12 个测试

3. **班级统计复用**
   - 教练工作台新增“薄弱标签掌握率”横向条形图
   - 复用 ECharts `StatisticsChart`

### 验证

- `npx vitest run --maxWorkers=2`：**110 文件 / 1001 用例通过**
- `npm run build`：通过
- `npm run test:e2e:browser`：2 passed
- 工作树：干净

### 已知限制

- 附件 50 MiB 仍内存缓冲
- 删除题目不清理附件文件
- picker 上限 500
- 批量 resume 不重试已记录失败项
- 统计 5000+ 服务端分页、训练图表未做
- 用户明确暂不做压测

### 下一轮

1. 班级/训练统计更多图表
2. 统计 5000+ 服务端分页
3. NSIS 实际构建
4. rc.7
5. 附件流式/清理

## 2026-11-06 / Round 144（智能体团队：Electron P0 + 批量导出）

### 团队

- 固定 teammate `electron-fixer`：task-1
- 固定 teammate `batch-exporter`：task-2
- Lead：集成、验收、合并

### 本轮提交

- `e0c18e7 chore: force LF for Node ESM and regenerate help docs`
- `ada7423 merge: fix packaged Electron startup`
- `7799fc8 merge: batch Excel/HTML export and matrix`
- `7488e97 fix(desktop): unblock packaged startup and make failures visible`
- `0b0cb09 feat: stream batch result exports with student-problem matrix`

### Electron P0 根因/修复

根因：

- release 产物继承 Low integrity 标签
- Low IL 无法写 `%APPDATA%\OiJudge`
- `requestSingleInstanceLock()` false
- 旧 main.ts 当作已有实例静默 `app.quit()`

修复：

- build-portable 规范化 Medium 完整性 + 必需文件校验
- main.ts 启动日志/userData 可写性/单实例失败日志/server stdio pipe/超时 60s
- `tools/electron-smoke.mjs`
- `npm run smoke:desktop` / `smoke:desktop:dev`

验证：

- packaged smoke PASS：window/server/health 200/LAN 200/web 200
- 打包态窗口 `OiJudge · 本地 OI 评测`、tray、server、health 200

### 批量导出

- `GET /api/admin/batch/:id/export?format=csv|xlsx|html`
- 长表 10 列
- CSV RFC4180 + BOM
- 学生×题目矩阵：CSV(matrix=1)/XLSX 第二 sheet/HTML
- HTML 自包含、可打印、自动分析摘要
- 5000 行 keyset 500/页、逐行 chunk
- 前端 4 个按钮

### 额外修复

- `.gitattributes` 强制 `.mjs/.cjs` LF，解决 Windows CRLF shebang 导致 Vite/release 测试失败
- 重新生成 help docs

### 验证

- `npm test`：**107 文件 / 977 用例通过**
- `npm run build`：通过
- `npm run test:e2e:browser`：2 passed
- packaged Electron smoke：PASS
- 工作树：干净

### 仍缺

- 5000×4 压力测试
- 导入 resume
- 题目搜索后端 scope
- 统计 5000+ 服务端分页、班级/训练复用
- 题目附件
- NSIS 实际构建、rc.7、4C/8G

## 2026-11-06 / Round 143（人工验收阻塞登记）

### 人工报告问题（未修复）

- Electron 安装包/便携包运行后：
  - 没有窗口
  - 没有托盘
  - 没有明显报错
  - 网页托管没有启动
  - 浏览器访问不到 LAN 地址
- 影响：打包后的桌面端不可用，阻塞安装包验收、rc.7 和 4C/8G 验收。
- 已写入 `aim.md` 的 P0 阻塞章节。
- 待排查：
  - asar/资源内 `apps/server/dist/cli.js`
  - `apps/web/dist/index.html`
  - `ojrunner.exe` / `ojinteract.exe`
  - utilityProcess/cwd/appRoot
  - 端口 8787、健康检查
  - 单实例/`--hidden`/托盘
  - 静默退出
- 验收：窗口或托盘 + `/api/health` 200 + LAN 可访问。

## 2026-11-06 / Round 142（批量映射 UI + P1001 题号 + Windows 部署）

### 本轮提交

- `25b0699 merge: Windows one-click deploy`
- `9a11330 merge: category-based problem numbers`
- `ce55c6d merge: batch mapping workspace UI`
- `baac8a9 feat(web): add batch mapping workspace`
- `5017599 feat: add category-based problem numbers`
- `c75d335 feat: add Windows one-click deploy scripts`

### 已完成

1. **批量映射工作区 UI**
   - `/admin/batch` 改为异步链路：
     - XHR 流式上传 + 进度 + 5 GiB 校验
     - preview 层级/treeSample/students/problemFolders
     - invalidStudents/duplicates/validCount
   - 映射工作区：
     - 每个题目文件夹一行
     - 个人/团队/公共筛选
     - 按选中题目顺序批量绑定
     - 手动改映射
     - 未映射禁止开始
     - 学生×题目=提交数上界
   - run 202 + 1s 轮询 + 服务端分页 + 取消 + CSV
   - 单题目模式保留
   - 新增 `utils/batch.ts` 31 例测试

2. **洛谷式分类题号**
   - `problem_categories`
   - `problems.category_id/seq/display_id`
   - 旧题按 id 升序迁 P1001…
   - 不建 L；编号不复用
   - 分类独立递增
   - 管理员新增分类/手动改号
   - `/api/problems/:idOrDisplayId` 双解析
   - 前端列表/编辑/创建显示题号
   - 批量文件夹接受 P1001 或数字 id
   - 14 例测试

3. **Windows 一键部署**
   - `tools/deploy/windows/`：
     - install/uninstall/start/stop/status
     - 防火墙/快捷方式/HKCU 自启
     - 数据目录保留
     - health 等待
   - dry-run 验证通过
   - 文档 `docs/help/maintenance/windows-deploy.md`

### 验证

- 全量 `npm test`：**106 文件 / 969 用例通过**
- `npm run build`：通过
- `npm run test:e2e:browser`：**2 passed**
- PowerShell 语法解析：6 个脚本通过
- `install.ps1 -DryRun`：退出码 0，未修改机器
- 工作树：干净

### 仍缺

- 批量 Excel/HTML 导出、学生×题目矩阵
- 批量题目搜索后端 scope 接口（当前前端过滤，limit 500）
- 5000×4 压力测试
- 导入 resume
- 题目附件
- 统计 5000+ 服务端分页、班级/训练复用
- Windows SCM 服务（当前为启动项/脚本）
- rc.7、4C/8G 验收

### 下一轮

1. 题目附件
2. 批量 Excel/HTML/矩阵导出
3. 统计 S3
4. 5000×4 / 4C8G 验收
5. rc.7

## 2026-11-06 / Round 141（批量 P1 后端 + 训练列表 + E2E）

### 本轮提交

- `db84c2a merge: streaming async batch imports`
- `e43f5a2 merge: all training plans for managers`
- `d5dadfe merge: business flow e2e`

### 已完成

1. **批量 P1 后端**
   - `POST /api/admin/batch/uploads` raw zip 流式落盘，`.part` + rename，sha256。
   - Content-Length 预检（411）、5 GiB 上限（413）、磁盘预检（507）。
   - `GET /uploads/:id/preview`：流式 fflate，treeSample/students/problemFolders/invalid/duplicates/validCount。
   - `POST /uploads/:id/run` 202，后台导入：
     - 500 条事务
     - 密码每批一次
     - batch 优先级 10
     - 逐条失败隔离
   - `GET /api/admin/batch/:id` 分页/进度；`POST /:id/cancel`。
   - 启动恢复：importing 标记 failed（不 resume）。
   - 旧 P0 入口保留兼容。
2. **训练计划全量列表**
   - `GET /api/training-plans?scope=mine|all`
   - all 仅 admin/contestmanager
   - 管理员默认 all；普通用户 mine
   - summary 增加 memberCount
   - 前端管理员“全部训练计划”/普通“我的训练计划”
3. **业务流 E2E**
   - 合并到当前分支
   - `test:e2e:browser` 同时跑 browser + business-flow
   - admin 建班、加学生、学生登录见班级
   - 新增统计页/批量页冒烟

### 验证

- 全量 `npm test`：**104 文件 / 924 用例通过**
- `npm run build`：通过
- `npm run test:e2e:browser`：**2 passed**
- 工作树：干净

### 仍缺

- 批量映射工作区 UI、文件结构图、题目搜索/顺序绑定
- Excel/HTML 批量导出、学生×题目矩阵
- 5000×4 压力测试
- 导入 resume
- 统计 5000+ 服务端分页、班级/训练复用
- 洛谷题号、题目附件
- Windows 服务化、rc.7、4C/8G 验收

### 下一轮

1. 批量映射工作区 UI + Excel/HTML 导出
2. 统计 S3：班级/训练复用
3. 洛谷题号 + 附件
4. 5000×4 / 4C8G 验收
5. rc.7

## 2026-11-06 / Round 140（需求总账）

### 本轮产出

- 新增根目录 `aim.md`：
  - 项目目标
  - 用户提出过的全部需求
  - 已完成项
  - 未完成/待精进项
  - 当前关键文件
  - 下一阶段建议
- 依据：本会话上下文、`git log`、两份规格、当前 912 用例测试状态。

### 当前结论

- 核心 OI Judge、比赛/团队、题单、班级、训练、错题、教练、备份、监控、升级检查、基础 E2E 已完成。
- 批量 P0 已完成；P1（流式/异步/映射）未完成。
- 统计 S1 + 双 PDF 已完成；5000+ 分页、班级/训练复用、性能实测未完成。
- 洛谷题号、题目附件只有设计，未实现。
- 5000×4、1000 人在线、4C/8G 未验收。
- Release 仍为 `v1.1.0-rc.6`。

## 2026-11-06 / Round 139（批量 P0 + 统计 S1）

### 本轮提交

- `cfb5e58 fix(web): remove duplicate batch error case`
- `eb81fc8 merge: contest statistics dashboard`
- `1bdccf9 merge: batch import failure isolation`
- `29032d8 chore(web): add echarts for statistics dashboard`

### 已完成

1. **批量导入 P0 止血**
   - 逐文件 try/catch，失败写 `batch_items.status/error_code/error_message`，不再整批 500。
   - 无效学生文件夹标记 `INVALID_STUDENT_FOLDER`。
   - 超大源码 `SOURCE_TOO_LARGE`、空源码、未映射题、用户/提交失败均逐条记录。
   - 重复学生-题目保留第一条。
   - 合成学生密码每批只 hash 一次；长用户名稳定 hash 后缀。
   - `GET /api/admin/batch/:id` 支持 offset/limit，默认 200，最大 1000。
   - 前端上传上限 5 GB；结果表服务端分页；跳过/错误列表；CSV 全量导出。
   - 测试：`admin-batch-p0.test.ts` 6 例。

2. **比赛统计仪表盘 S1 + 打印**
   - `GET /api/contests/:id/statistics`：
     - 正式榜/封榜口径。
     - OI/IOI 分数；ACM/CF 通过题数/罚时。
     - summary/distribution/cumulative/problems/groups/insights。
     - 隐藏选手默认排除；管理员 includeHidden。
     - 2s 缓存。
   - 前端 `/contest/:contestId/statistics`：
     - KPI、总分分布+累计、分数段环形、每题分布、难度/区分度、班级/团队对比。
     - ECharts 按需加载，统计页 chunk ≈536 KB，主 chunk 不含 echarts。
     - AntD 虚拟成绩表（520px）+ 搜索；≥5000 行提示 + 前 2000 预览。
     - 公开比赛页 + 管理控制台入口。
   - 打印：
     - `?print=analysis` 只输出 KPI/图表/分析。
     - `?print=results` 输出全部可见个人成绩，表头重复，管理员可含隐藏。
     - 两个“导出 PDF”按钮，浏览器打印。
   - 测试：后端 10 例 + 前端 11 例。

### 验证

- 全量 `npm test`：**103 文件 / 912 用例通过**。
- `npm run build`：通过。
- `npm run web:build`：通过；ECharts 仅在统计页 chunk。
- 浏览器烟测（子代理）：统计页图表/分析/虚拟表/搜索正常。

### 已知限制

- 批量 P1 未做：`unzipSync` 整包内存、后台异步导入、流式上传、分批事务仍未实现；5 GB 只是放开限制。
- 统计 ≥5000 行未做真正服务端分页，只做前 2000 预览。
- 公开团队聚合中，隐藏个人仍可能影响团队汇总（不泄露身份）。
- 打印等待使用 1200ms/400ms 启发式。
- 自动分析样本不足时指标置空，不显示提示。
- Release 仍为 `v1.1.0-rc.6`。

### 下一步

1. 批量 P1：流式 ZIP、后台导入、分批事务、映射工作区。
2. 统计 S3：班级/训练复用。
3. PDF 打印稳定性：ECharts render 完成栅栏。
4. 浏览器 E2E：统计页 + 打印页。
5. 4C/8G 与 5000×4 验收。

## 2026-11-06 / Round 138（统计仪表盘设计）

### 本轮产出

- 新增 `docs/superpowers/specs/2026-11-06-statistics-dashboard-design.md`。
- 实测 `statistics.html`：136 KB、9 个表格、442 行；该文件本身不是 1505 行明细。
- 确认卡顿主要来源是应用内 `ContestRankingPage` 的 `pagination={false}` 全量表格。
- 方案：服务端聚合 + ECharts 按需加载 + 1505 虚拟滚动 / 5000 服务端分页 + 浏览器打印 PDF。
- 不再把 `statistics.html` 作为最终交付；旧文件保留作参考。
- 自动分析进入 PDF；不显示样本量提示，样本不足时指标置空。

### 已确认

1. ACM/CF 做通过题数/罚时，不做分数分布。
2. 公开统计严格使用封榜口径，解封后更新。
3. PDF 拆成两个：
   - 分析报告 PDF：KPI、图表、自动分析、班级/团队汇总。
   - 个人成绩 PDF：全部可见参赛者；管理员可含隐藏。
4. 自动分析不显示样本提示；样本不足时指标置空。
5. 入口：比赛公开页 + 管理控制台。
6. 不再生成 statistics.html。

### 下一步

- 确认后先做 S1：比赛统计聚合接口 + 仪表盘 + 虚拟表格。
- S2：浏览器打印 PDF。
- S3：班级/训练复用。

## 2026-11-06 / Round 137

### 本轮提交

- `816e7c0 fix: harden large batch uploads and admin source limits`
- `f31c43c docs: add large batch and numbering design`

### 已完成

1. **确认 4000 人批量 500 的现场原因**
   - 用户数据目录 `D:\Desktop\LEO\c++\code\gen\2\3\Sdata-self\A\source`：
     - 1,505 个学生目录
     - 10,876 个文件
     - 470.19 MB
     - 5,438 个有效“学生/题目”组合
   - `A.zip` 250.9 MB，超过前端 80 MB 限制。
   - `SH-S01313/migrate.cpp` 216.8 MB，超过后端 64 MB 管理员源码限制。
   - 批量循环没有逐文件 catch，一条异常导致整批 500。
   - `unzipSync` 整包解压、逐行 INSERT、逐学生 scrypt、`getBatchJob` 一次返回全部 items 是后续风险。

2. **保留并修复用户未提交的批量上传修改**
   - 全局 body parser 10 GB。
   - 批量/题目上传 10 GB。
   - 管理员源码上限从 64 MB 提升到 512 MiB。
   - 批量支持 `.c` -> `c11`。
   - 空 ZIP 条目跳过。
   - 修复回退分支中未定义的 `db`（改为 `options.db`）。
   - 修复被破坏的注释字符。
   - 说明：10 GB body 仍是“整包读入 Buffer”，P1 必须改为流式。

3. **设计规格**
   - 新增 `docs/superpowers/specs/2026-11-06-batch-scale-numbering-design.md`。
   - 覆盖：异步批量、流式 ZIP、题目映射工作区、多核并发、CSV/Excel/HTML、标准/文件 IO、P1001 题号、题目附件。

### 验证

- `npx tsc -p apps/server/tsconfig.json --noEmit`：通过。
- `npx vitest run apps/server/tests/admin-batch.test.ts apps/server/tests/submissions.test.ts`：2 文件 / 4 用例通过。
- 工作树：干净（不含临时 `.bak`）。

### 已确认决策

| 项目 | 决策 |
|---|---|
| 批量规模 | 5000 学生 × 4 题 = 20,000 提交 |
| 时限 | 不设硬时限 |
| 在线 | 1000 注册、低峰值提交；只配置多核 |
| 批量方式 | 后台异步任务 |
| 管理员源码 | 512 MiB，可配置 |
| 学生源码 | 256 KiB |
| ZIP 上限 | 5 GB，流式 |
| 题号 | 分类前缀 + 独立序号；旧题迁 P，从 P1001 |
| 旧题顺序 | 内部 id 升序 |
| 文件 IO | 每题配置 stdio/file |
| 导出 | CSV 长表 + Excel + HTML，含矩阵 |
| 附件 | 题目可见即可下载；PDF/图片/ZIP；50 MB |
| 映射 | 按选中题目顺序批量绑定 + 手动改 |
| 无效学生 | 丢弃并列出，不阻塞整批 |

### 下一步

**P0 止血**

- 逐文件 catch，一条失败不影响整批。
- 超大源码标记 skipped。
- 无效学生文件夹丢弃并列出。
- 前端 80 MB 限制改掉，上传流式化。
- 具体错误码，不再统一“服务器内部错误”。
- 修复 `getBatchJob` 一次返回全部 items。

**P1 异步批量 + 映射**

- 流式上传/解压。
- 后台分批导入（500/事务）。
- 合成学生只哈希一次密码。
- batch 优先级低于在线提交。
- 分页进度/取消/重试。
- 文件结构预览。
- 个人/团队/公共题目搜索。
- 顺序绑定 + 手动映射。
- 服务端 CSV/Excel/HTML + 学生×题目矩阵。

**P2/P3/P4**

- P2：`judgeConcurrency` 配置、默认核数、上限/警告。
- P3：P1001 分类题号、管理员手动改号、题目附件。
- P4：LemonLime 对齐（全部/未测试/选中、重测失败、Subtask Skip、统计分布、HTML 成绩单）。

### 已知限制

- 10 GB body 仍是 Buffer，P1 改流式。
- 5000×4 在 4C8G 上可能数小时；已接受不设硬时限。
- 1000 人同时提交不保证；只保证 1000 注册、低峰值。
- 216.8 MB 源码即使允许，也可能编译慢/失败；必须逐条隔离。
- 当前 Release 仍为 `v1.1.0-rc.6`。
