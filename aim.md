# OI Local Judge — 目标、已完成与未完成

最后更新：2026-11-11  
当前分支：`main`  
当前 HEAD：`d53ca06 release: prepare v1.1.0-rc.10`  
发布 tag：`v1.1.0-rc.10`  
当前 Release：`v1.1.0-rc.10`（第二轮安全审查修复）

---

## 1. 项目目标

构建一个 Windows 局域网 OI 评测系统：

- Electron 桌面端 + 浏览器选手/管理端
- 比赛模式：OI / IOI / ACM / CF-like
- 自定义题目、SPJ、交互题、客观题、输出题
- 可视化赛务管理
- 4C/8G 目标机器
- 原目标：300 人在线、50 并发
- 后续加急目标：5000 人批量、1000 人在线、多核评测
- 教学侧：题单、训练计划、班级管理、错题分析、进度统计、教练工具
- 运维侧：一键部署、自动备份、升级、监控

---

## 2. 用户明确提出过的需求

### 2.1 初始核心需求

- Windows 局域网 OI Judge
- Electron 桌面 + 浏览器 UI
- 比赛模式、自定义题目、SPJ、交互/客观/输出题
- 可视化管理员
- OI/IOI/ACM 规则
- 4C/8G 目标机
- 300 在线、50 并发
- 全部由子代理并行开发
- 专注实质功能，汇报完成情况
- 不要使用 wait

### 2.2 教学功能需求

- 题单
- 训练计划
- 班级管理
- 错题分析
- 进度统计
- 教练工具
- 一键部署
- 自动备份
- 升级
- 监控

### 2.3 加急性能需求

- 5000 人批量评测
- 1000 人在线评测
- 多线程/多核评测
- 参照 LemonLime 的功能
- 4000 人上传时报“服务器内部错误”
- C++17 编译支持
- 批量评测成绩导出
- 仿洛谷题号：分类独立递增，不全局递增
- 题目附件

### 2.4 UI / 统计需求

- 优化 UI
- 减少大批量数据打开卡顿（`statistics.html`）
- 自带数据可视化分析
- 应用内统计仪表盘
- PDF 报告：
  - 分析报告
  - 完整个人成绩
- 不再生成 `statistics.html`

### 2.5 工作流要求

- 每一轮结束前：
  1. 用 Git 提交代码
  2. 提交说明写清楚
  3. 更新进度文件
- 当前进度文件：`docs/PROGRESS.md`

---

## 3. 已完成

## 3.1 核心评测与平台

- Electron + Fastify + React + AntD 基础架构
- 登录、角色：
  - admin
  - setter
  - contestmanager
  - contestant
- 题目：
  - 标准题
  - SPJ/testlib
  - 交互题
  - 客观题
  - 输出题
  - 文件 IO / 标准 IO
  - 子任务/依赖跳过
- 评测：
  - 原生 `ojrunner.exe` Job Object 沙箱
  - `ojinteract.exe`
  - 编译缓存
  - 取消排队/运行中评测
  - 重测
  - 队列位置
  - 超时/内存/输出限制
- 比赛：
  - OI/IOI 排名
  - ACM 排名
  - CF-like 排名
  - 封榜/解封
  - 正式榜缓存
  - WebSocket `ranking.delta`
- 注册：
  - 开放/审核/手动
  - 报名窗口
  - 签到
  - 团队报名
  - 纯团队赛禁止个人报名
- 团队：
  - 创建/邀请/成员
  - 团队赛
  - 团队榜
  - CF-like 团队 Hack 分
  - 团队题单
  - 团队奖项/证书
  - 团队成员与参赛资格同步
  - 解散团队撤销 team 来源资格
- 比赛报告：
  - JSON/CSV
  - 参与者/提交/题目/个人/团队统计
- 奖项/证书：
  - 个人奖
  - 团队奖
  - 参赛证书
  - 打印

## 3.2 题库与 ACL

- 题单：
  - 个人
  - 团队
  - 公开
  - 题目排序
  - 用户/团队 read/edit 分享
- 题目 ACL：
  - 所有者
  - 分享
  - 可见性
  - 练习提交限制
- 隐藏题提交记录过滤
- 题目统计/摘要

## 3.3 班级 / 训练 / 教练

- 班级 = 团队的一种：
  - `teams.kind = team | class`
  - `allow_contest`
  - 多教练
  - coach/assistant/member
  - 学生可属于多个班/队
- 班级管理 UI：
  - 列表
  - 详情
  - 成员/教练管理
  - 创建班级
  - 改名
  - 删除
  - 参赛开关
- 班级参赛名单只算学生，教练/助教不计入
- 训练计划：
  - 后端 + 前端
  - 题目、目标分、截止时间
  - 成员进度
  - 逾期
  - 教练/owner/admin 管理
  - 比赛管理员可管理任意组
  - `scope=mine|all`：平台管理员默认查看全部计划
  - summary 含 `memberCount`
  - 管理员/普通用户列表标题与空态区分
- 错题/进度：
  - `student_problem_stats`
  - `student_tag_stats`
  - `student_daily_stats`
  - 从未 AC / 最新非 AC
  - 标签掌握度
  - 班级学习统计
  - 14 天未活跃
  - 薄弱标签
  - 定时重建
  - 管理员手动重建
- 教练工具：
  - 班级工作台
  - 学习统计
  - 错题本
  - 训练计划入口
  - 学生提交列表
  - 查看源码 + 审计
- 学习统计已知限制：
  - `active_seconds` 无采集来源，当前 0
  - 每日按 UTC 分桶
  - 班级统计 N+1
  - 快照定时重建

## 3.4 批量评测

### 已完成 P0

- 逐文件 `try/catch` 隔离
- 单条失败写 `batch_items`：
  - `status`
  - `error_code`
  - `error_message`
- 错误码：
  - `SOURCE_TOO_LARGE`
  - `EMPTY_SOURCE`
  - `UNSUPPORTED_SOURCE`
  - `UNMAPPED_PROBLEM`
  - `USER_CREATE_FAILED`
  - `SUBMIT_FAILED`
  - `INVALID_STUDENT_FOLDER`
  - `UNSAFE_PATH`
- 无效学生文件夹丢弃并列出
- 重复“学生-题目”保留第一条
- 合成学生密码每批只 hash 一次
- 长用户名稳定 hash 后缀
- `GET /api/admin/batch/:id` 分页：
  - 默认 200
  - 最大 1000
- 前端：
  - 上传上限 5 GB
  - 结果表服务端分页
  - 跳过/失败计数
  - 错误码列
  - CSV 全量导出
- 管理员单文件源码上限：512 MiB
- 全局/批量 body 上限：10 GB
- `.c` -> `c11`
- 空 ZIP 条目跳过

### 现场问题定位

用户数据：

```text
D:\Desktop\LEO\c++\code\gen\2\3\Sdata-self\A\source
1,505 学生目录
10,876 文件
470.19 MB
5,438 有效学生/题目组合
```

直接原因：

- `A.zip` 250.9 MB > 前端 80 MB 限制
- `SH-S01313/migrate.cpp` 216.8 MB > 后端 64 MB 限制
- 批量循环没有逐文件 catch -> 整批 500

### 已完成 P1 后端

- 流式 ZIP 上传：
  - raw zip 流式落盘
  - `.part` + rename
  - sha256
  - Content-Length 预检
  - 5 GiB 上限
  - 磁盘预检
- 流式预览：
  - fflate 流式解压
  - treeSample/students/problemFolders
  - invalidStudents/duplicates
  - 路径安全校验
- 后台异步导入：
  - `POST /uploads/:id/run` 202
  - 500 条事务
  - 密码每批只 hash 一次
  - batch 优先级 10
  - 逐条失败隔离
- 进度/分页/取消：
  - `GET /api/admin/batch/:id`
  - `POST /api/admin/batch/:id/cancel`
  - 状态 uploaded/importing/queued/judging/finished/failed/canceled
- 启动恢复：importing 标记 failed（不 resume）

### 已完成 P1 前端

- `/admin/batch` 改为异步链路：
  - XHR 流式上传 + 进度
  - preview 层级/treeSample/students/problemFolders
  - invalid/duplicates/validCount
- 映射工作区：
  - 每个题目文件夹一行
  - 个人/团队/公共筛选
  - 顺序批量绑定
  - 手动改映射
  - 未映射禁止开始
  - 学生×题目=提交数上界
- run 202 + 1s 轮询 + 分页 + 取消 + CSV
- 单题目模式保留

### 已完成导出

- `GET /api/admin/batch/:id/export?format=csv|xlsx|html`
- 长表 10 列
- CSV RFC4180 + BOM
- 学生×题目矩阵：
  - `matrix=1` CSV
  - XLSX 第二 sheet
  - HTML 表格
- HTML 自包含、可打印、自动分析摘要
- XLSX 流式 WorkbookWriter
- 5000 行 keyset 500/页、逐行 chunk
- 前端 4 个按钮：CSV / 矩阵 CSV / Excel / HTML

### 已完成 P1 收尾

- 导入恢复：
  - `recoverInterruptedBatchImports`
  - 跳过已导入/已失败项
  - chunk 事务幂等
  - upload/zip 丢失 -> `BATCH_RESUME_UPLOAD_MISSING`
- 题目搜索：
  - `GET /api/admin/problems/picker?scope=personal|team|public|all`
  - 标题/displayId/标签/数字 id 搜索
  - limit 200/500
  - 批量映射 UI 接入
- 附件：
  - 50 MiB
  - PDF/图片/ZIP
  - 题目可见即可下载
  - 管理员/出题人上传/删除/替换
  - 不暴露 storage_path
  - 前端管理 Tab + 题目附件 Tab

### 未完成 P1

- 5000×4 压力验收（用户明确暂不做）
- 附件 50 MiB 仍内存缓冲
- 题目 picker 上限 500（超过 500 题时全量匹配受限）

## 3.5 统计 / UI / PDF

### 已完成 S1

- `GET /api/contests/:id/statistics`
- 正式榜/封榜口径
- OI/IOI：分数分布
- ACM/CF：通过题数/罚时
- KPI：
  - 参赛
  - 提交
  - 平均
  - 中位
  - 标准差
  - 满分
  - 0 分
- 总分分布 + 累计曲线
- 分数段环形图
- 每题得分/AC 分布
- 难度/区分度
- 班级/团队对比
- 自动分析
- 隐藏选手排除；管理员可包含
- 2 秒缓存
- 前端 `/contest/:contestId/statistics`
- AntD 虚拟成绩表
- 1505 行虚拟滚动
- ≥5000 行提示 + 前 2000 预览
- 公开比赛页 + 管理控制台入口
- ECharts 按需加载
  - 统计页 chunk 约 536 KB
  - gzip 约 180 KB
  - 主 chunk 不含 ECharts
- 两个 PDF 打印入口：
  - `?print=analysis`
  - `?print=results`
- 不再生成 `statistics.html`

### 已开始复用

- 班级教练工作台新增“薄弱标签掌握率”图
- 复用 `StatisticsChart` ECharts 组件
- 尚未做训练统计图表

### 已完成 S2/S3

- 5000+ 服务端分页：
  - `/official-ranking/page?offset&limit&query`
  - 默认 100，上限 500
  - 用户名/姓名/班级搜索
  - 前端成绩表服务端分页
  - 打印 results 仍用完整榜
- 班级统计复用：
  - 教练工作台“薄弱标签掌握率”图
- 训练统计复用：
  - 训练计划成员完成度图

### 未完成 S2/S3

- ECharts render 完成栅栏
- 完整浏览器 E2E（统计页/打印页）
- 性能实测（1505 首屏 <1s、60fps）
- 隐藏选手团队聚合严格排除
- 搜索未覆盖排名/分数/题号

## 3.6 运维 / 部署 / 发布

- Windows 便携版
- NSIS 安装器
- GitHub Actions Windows Release
- 自动上传 Release 资产
- Windows 一键部署脚本：
  - install/uninstall/start/stop/status
  - 防火墙、桌面快捷方式、HKCU 自启
  - 数据目录保留
  - health 等待
  - dry-run 验证
  - 维护文档
- 每日自动备份：
  - 保留 7 份
  - 校验
  - manual/pre-restore 不自动清理
- 升级检查：
  - GitHub Releases
  - 包含 prerelease
  - 1 小时缓存
  - 升级前备份
- 本地监控：
  - 请求/5xx/平均/p95
  - 慢请求
  - RSS/heap/CPU
  - 事件循环延迟
  - 队列/磁盘/uptime
- Electron：
  - 托盘
  - 关闭到托盘
  - 开机自启
  - 单实例
- 浏览器 E2E：
  - 登录
  - 帮助
  - 系统页
  - 班级
  - 训练
  - 学生统计

## 3.7 测试/构建

当前验证：

- `npx vitest run --maxWorkers=2`：**110 文件 / 1008 用例通过**
- `npm run build`：通过
- `npm run web:build`：通过
- 浏览器 E2E：2 passed（主流程 + 建班/学生访问）
- 子代理统计页烟测：图表/分析/虚拟表/搜索通过
- Windows deploy：PowerShell 语法解析通过；`install.ps1 -DryRun` 退出码 0
- Electron packaged smoke：PASS（window/server/health/LAN/web）
- NSIS 安装态 smoke：PASS（安装/启动/health/LAN/卸载）

## 3.8 v1.1.0-rc.8 发布（2026-11-06）

- Tag：`v1.1.0-rc.8`
- Release：https://github.com/LEOOOOOOOOOISME/oi-local-judge/releases/tag/v1.1.0-rc.8
- CI run：`42235882817`，success
- 资产：
  - `OiJudge-Setup-1.1.0-rc.8.exe` 252,539,081 B
  - `oi-local-judge-1.1.0-rc.8-win-x64.zip` 360,004,526 B
- Release 为 prerelease
- 发布说明：`docs/releases/RELEASE_NOTES.md`
- **rc.8 是升级修复版**：
  - 修复 rc.7 从 rc.6 旧库启动时报 `no such column: status`
  - 根因：`batch_items(batch_id,status)` 索引在 `ensureColumn` 之前创建
  - 回归测试 + 真实旧库 `/api/health` 200
- rc.7 已发布但升级迁移缺陷，建议使用 rc.8

## 3.9 v1.1.0-rc.9 发布：安全 + 批量进度 + 成绩正确性（2026-11-11）

- Tag：`v1.1.0-rc.9`
- Release：https://github.com/LEOOOOOOOOOISME/oi-local-judge/releases/tag/v1.1.0-rc.9
- CI run：`43029313936`，success
- 资产：
  - `OiJudge-Setup-1.1.0-rc.9.exe` 252,561,277 B
  - `oi-local-judge-1.1.0-rc.9-win-x64.zip` 360,033,607 B
- prerelease：是

### P0 安全

- Session 密钥：
  - 删除 `dev-only-change-me`
  - 首次启动 `randomBytes(32)`，持久化 `secrets.json`
  - 旧默认值自动迁移，旧 Session 失效
- 管理员：
  - 删除 `admin/admin123`
  - 首次随机 20 位密码，CLI 打印一次 / Electron 原生弹窗可复制
  - `must_change_password=1`
  - 旧 admin123 升级强制改密
  - 新增 `POST /api/auth/change-password`
  - 改密前除改密/logout/me 外 403 `PASSWORD_CHANGE_REQUIRED`
- 监听：
  - 默认 `127.0.0.1`
  - `OIJ_HOST=0.0.0.0` / `OIJ_LAN=1` 显式开放
  - `install.ps1 -Lan` 才开防火墙
- 最小隔离：
  - `judge/isolation.ts`
  - 只透传启动必需 env，剔除 `OIJ_*`/`NODE_OPTIONS`
  - 工作目录移到 dataDir 同级 `<dataDir>-judge-tmp`
  - 编译/runner/checker/validator/generator/interactive 全部应用

### 批量进度

- `batch_jobs` 新增 `phase/started_at/updated_at/heartbeat_at/eta_seconds`
- `GET /api/admin/batch/jobs` 分页/状态过滤，永久保留
- `GET /api/admin/batch/jobs/:id` 聚合轮询
- `DELETE /api/admin/batch/jobs/:id` 仅终态，审计
- 阶段：uploaded → parsing → importing → queued → judging → finished/failed/canceled
- 导入单飞，其他排队；与在线共用 judge 队列，batch priority 10
- 前端 `/admin/batch/:jobId` 刷新恢复、任务列表、阶段进度、ETA、失败趋势

### P1 成绩正确性

- merge 同分不 AC→WA
- preview 返回 `afterVerdict/verdictChanged`
- published 禁止 discard，非法状态 409
- 交互 runner 共享 CPU 预算，超限 TLE
- 重复源文件写入 `ignoredFiles`
- Hack promote/revert 事务化 + 故障回滚测试

### 验证

- 全量：**113 文件 / 1032 用例通过**
- `npm run build`：通过
- 浏览器 E2E：2 passed
- 安全实际启动：`127.0.0.1:18899`，`/api/health` 200，随机密钥/随机管理员
- 桌面 smoke：本环境 Electron runtime 缺失，未跑；构建/tsc 通过

## 3.10 v1.1.0-rc.10 发布：第二轮审查修复（2026-11-13）

- Tag：`v1.1.0-rc.10`
- Release：https://github.com/LEOOOOOOOOOISME/oi-local-judge/releases/tag/v1.1.0-rc.10
- CI run：`43447435301`，success
- 资产：
  - `OiJudge-Setup-1.1.0-rc.10.exe` 252,574,574 B
  - `oi-local-judge-1.1.0-rc.10-win-x64.zip` 360,115,035 B
- prerelease：是

### 已修复

- F-01：可选/强制独立 Windows worker 账户
  - `OIJ_WORKER_ISOLATION=optional|required`
  - `OIJ_WORKER_USER/PASSWORD` 或 `worker.json`
  - required 缺凭据启动 fail closed
  - native runner `CreateProcessWithLogonW + Job Object`
  - dataDir deny worker 读，workdir grant worker 读写
  - install.ps1 `-WorkerIsolation` 创建账户/ACL/防火墙出站阻断
- F-02：登录限流在密码校验前检查；IP+账号、IP 双维度
- F-03：显式 Session 密钥必须 ≥32 字符，弱值/旧值 fail closed
- F-04：升级扫描所有 admin，旧 `admin123` 全部强制改密并 bump session
- F-05：内置 HTTPS：
  - `OIJ_TLS_CERT` / `OIJ_TLS_KEY`
  - TLS 时 Cookie `Secure`
  - `OIJ_COOKIE_SECURE=1` 支持反代
- F-06：README 删除旧默认账号/0.0.0.0，补随机密码/loopback/LAN/TLS
- F-07：Electron 模式初始密码不写 stdout/desktop.log；只走 ready IPC + 弹窗
- F-08：ZIP 重复规范化路径 fail closed，预览/导入一致
- F-09：登录/注册限流改为有界 TTL Map
- F-10：交互 runner HANDLE_LIST 失败 fail closed
- F-11：`OIJ_LAN=1` 在 loadConfig 统一生效

### 验证

- 116 文件 / 1056 用例通过
- `npm run build:native`、`npm run build` 通过
- 浏览器 E2E：2 passed
- worker required 缺凭据：启动即退出，不监听
- 真实 worker 账户创建/CreateProcessWithLogonW 成功路径未在管理员会话实机验证

---

## 4. 没有完成 / 待精进

## 4.1 批量（P0/P1 已完成，剩余验收与边界）

- [x] 流式 ZIP 上传
- [x] 流式解压
- [x] 后台异步导入
- [x] 分批事务（500/批）
- [x] 映射工作区：层级预览、无效学生、个人/团队/公共搜索、顺序绑定、手动改、未映射阻止
- [x] Excel `.xlsx` 批量导出
- [x] HTML 批量导出
- [x] 学生×题目矩阵
- [x] 导入 resume
- [x] 取消
- [ ] 5000×4 = 20,000 提交压力测试（用户明确暂缓）
- [ ] 216.8 MB 源码的编译/失败隔离实测
- [ ] 按班级/团队分册导出
- [ ] 5 GB ZIP 磁盘配额/临时目录清理
- [ ] 已记录失败项重试
- [ ] picker 超过 500 题的全量匹配

## 4.2 多核 / 在线

- [ ] `judgeConcurrency` 可视化配置
- [ ] 默认按核数
- [ ] 超核数警告
- [ ] 批量优先级低于在线提交
- [ ] 1000 人在线压测
- [ ] 1000 人同时提交（明确不承诺）
- [ ] 4C8G 目标机 2 小时/300 在线/50 并发验收
- [ ] 真实多核/多进程评测策略（当前只是异步并发 + 外部进程）

## 4.3 洛谷式题号（已完成）

- [x] `problem_categories`
- [x] `problems.category_id/seq/display_id`
- [x] 旧题迁入 P，从 P1001
- [x] 按内部 id 升序
- [x] 管理员新增分类/前缀
- [x] 管理员手动改题号
- [x] URL 同时接受内部 id 和 `P1001`
- [x] 批量文件夹接受 `P1001`
- [x] 删除不复用编号
- [x] 分类独立递增
- [x] 迁移幂等

## 4.4 题目附件（已完成）

- [x] `problem_attachments`
- [x] 上传/下载/删除/替换
- [x] PDF/图片/ZIP
- [x] 50 MiB 限制
- [x] 题目可见即可下载
- [x] 不暴露真实路径
- [x] 管理端附件 Tab
- [x] 题目页附件 Tab
- [ ] 大文件改流式
- [ ] 删除题目时清理附件文件

## 4.5 统计 / UI

- [x] 5000+ 服务端分页
- [x] 班级/训练统计复用（薄弱标签图、训练完成度图）
- [ ] 真实性能实测：
  - 1505 首屏 <1s
  - 滚动 60fps
- [ ] `statistics.html` 实际卡顿原因（用户未能提供 DevTools）
- [ ] 旧榜单页表格虚拟化/分页（统计页已虚拟/分页，原榜单仍 `pagination=false`）
- [ ] 打印等待改成 ECharts `onRendered` 栅栏
- [ ] 自动分析样本阈值处理（当前置空，不提示）
- [ ] 隐藏选手团队聚合严格排除
- [ ] 统计页/打印页完整 E2E
- [ ] PDF 分页/中文/图表实测

## 4.6 Electron 包启动阻塞（人工验收，P0）

### 现象

人工运行 Electron 安装包/便携包后：

```text
- 没有窗口
- 没有托盘
- 没有明显报错
- 网页托管没有启动
- 浏览器访问不到 LAN 地址
```

### 影响

- 打包后的桌面端不可用
- 局域网 OJ 无法从 Electron 启动
- 阻塞安装包验收、rc.7 发布、4C/8G 验收

### 状态

**已修复。** 根因与实际验证如下。

### 根因

release 产物继承了构建缓存的 Low integrity 标签：

```text
icacls: Mandatory Label\Low Mandatory Level
```

Low IL 进程无法写 `%APPDATA%\OiJudge` → Electron 单实例锁/缓存 Access Denied → `requestSingleInstanceLock()` 返回 false → 旧 `main.ts` 把它当成“已有实例”静默 `app.quit()`，所以无窗口、无托盘、无 server、无报错。

同一 release 目录 robocopy 到普通目录（Medium 标签）后完整启动，证明 server/web/native/utilityProcess 本身正常。

### 修复

- `tools/build-portable.mjs`：
  - 校验 Electron runtime 必需文件
  - 输出树 `icacls /setintegritylevel Medium /T`
  - 校验关键文件不再 Low
  - ZIP 必需项补 electron.exe/resources.pak/icudtl.dat/default_app.asar
- `apps/desktop/src/main.ts`：
  - `desktop.log` 启动日志（不可写回退 LocalLow）
  - 启动前 userData 可写性探测，权限失败弹窗明确报错
  - 单实例锁失败写日志
  - server `stdio: 'inherit'` → `'pipe'`，输出进日志，失败带子进程输出，超时 60s
  - `OIJ_DESKTOP_USER_DATA` 隔离覆盖
- 新增 `tools/electron-smoke.mjs` + `npm run smoke:desktop` / `smoke:desktop:dev`

### 验证

- `npm run smoke:desktop`：PASS
- `npm run smoke:desktop:dev`：PASS
- 打包态实跑：
  - 窗口 `OiJudge · 本地 OI 评测`
  - tray ready
  - server 随机端口
  - `/api/health` 200
  - LAN 访问 200
  - Web UI 200
- 主工作树打包烟测：PASS

### 需要注意

- 本沙箱开发态 Electron 仍是 Low IL；正常机器不受影响。
- NSIS 安装包已在 rc.7/rc.8 CI 实际构建并发布；`--prepackaged` 输入为已规范化的 portable 目录。
- Windows `mjs` 曾因 CRLF shebang 导致 release 测试失败，已加 `.gitattributes` 强制 LF。

### 复现与验收

```text
1. 运行安装包/portable exe
2. 检查进程树（Electron + node server）
3. 检查 8787 端口监听
4. 访问 http://127.0.0.1:8787/api/health
5. 检查 userData/logs
6. 确认窗口或托盘出现
```

验收标准：

- 启动后出现窗口或托盘
- 服务进程启动
- `/api/health` 返回 200
- 浏览器可通过 LAN 地址访问
- 无静默退出

### 相关文件

- `apps/desktop/src/main.ts`
- `electron-builder.yml`
- `tools/release/build-release.mjs`
- `tools/release/build-portable.mjs`
- `apps/server/src/cli.ts`

## 4.7 运维 / 发布

- [x] NSIS 安装包实际构建：
  - rc.6 本地验证包 241.1 MB
  - rc.7 CI 发布包 252,538,915 B
  - 静默安装/卸载实测
  - 安装态 smoke PASS
- [x] 安装包完整性规范化（Medium IL）
- [ ] 安装包签名（当前 NotSigned，SmartScreen 可能提示）
- [ ] 自定义图标
- [ ] 首次冷启动超时 60s 偏低，建议 120s
- [ ] Windows 服务化（当前只托盘/启动项/脚本）
- [ ] 自动下载/安装升级（当前检查 + 手动安装）
- [ ] 升级失败回滚
- [x] v1.1.0-rc.8 发布：GitHub Release + NSIS + ZIP
- [ ] 4C/8G 目标机验收
- [ ] 生产环境自动备份异地/SMB
- [ ] 监控告警（当前只本地指标页）
- [ ] 日志轮转

## 4.8 LemonLime 对齐

已参考但未完全实现：

- [ ] 最大评测线程 UI
- [ ] 测试全部/未测试/选中
- [ ] 一键重测失败/编译错误
- [ ] 源目录同步
- [ ] Subtask Skip 完整对齐
- [ ] 分数分布/标准差/区分度导出
- [ ] HTML 完整成绩单
- [ ] 编译器配置/时间内存倍率
- [ ] 自动识别 IO 模式（明确不做，按题目配置）

---

## 5. 当前关键文件

- 规格：
  - `docs/superpowers/specs/2026-11-06-batch-scale-numbering-design.md`
  - `docs/superpowers/specs/2026-11-06-statistics-dashboard-design.md`
- 进度：
  - `docs/PROGRESS.md`
- 批量：
  - `apps/server/src/http/admin-batch.ts`
  - `apps/web/src/pages/AdminBatchPage.tsx`
- 统计：
  - `apps/server/src/services/contest-statistics.ts`
  - `apps/web/src/pages/ContestStatisticsPage.tsx`
  - `apps/web/src/components/StatisticsChart.tsx`
- 班级：
  - `apps/server/src/services/teams.ts`
  - `apps/web/src/pages/ClassDetailPage.tsx`
- 训练：
  - `apps/server/src/services/training-plans.ts`
  - `apps/web/src/pages/TrainingPlansPage.tsx`
- 学习统计：
  - `apps/server/src/services/learning-stats.ts`
  - `apps/web/src/pages/StudentLearningPage.tsx`
- 运维：
  - `apps/server/src/services/backup-scheduler.ts`
  - `apps/server/src/services/update-check.ts`
  - `apps/server/src/services/metrics.ts`
  - `apps/desktop/src/main.ts`

---

## 6. 下一阶段建议

### 第一优先：批量/Electron 验收

1. 5000×4 实测
2. 导入 resume
3. 题目搜索后端 scope
4. NSIS 安装包实际构建
5. 4C/8G 验收

### 第二优先：统计收尾

1. 5000+ 服务端分页
2. 班级/训练复用
3. 打印栅栏
4. 性能实测
5. E2E

### 第四优先：题目附件

1. `problem_attachments`
2. 上传/下载/删除/替换
3. 权限/大小限制

### 第五优先：运维/发布

1. Windows 服务化
2. 升级安装/回滚
3. rc.7
4. 4C/8G 验收
