# OiJudge v1.1.0-rc.8

Windows x64 预发布版本，面向局域网 OI 评测、比赛与教学训练：Electron 桌面端、浏览器选手/管理端、原生 Job Object 评测器。

> 这是 RC 预发布，不建议直接用于无备份的正式比赛。升级前请备份 `%APPDATA%\OiJudge` 数据目录。

## 下载

GitHub Release 附件同时提供安装器与便携包，`<version>` 与发布 tag 一致（例如 tag `v1.1.0-rc.8` 对应 `1.1.0-rc.8`）：

- `OiJudge-Setup-<version>.exe`：NSIS 安装器，支持自选安装目录，创建桌面与开始菜单快捷方式。
- `oi-local-judge-<version>-win-x64.zip`：便携版 ZIP，解压即用。

两者均内置 Node 服务、Web 前端、`ojrunner.exe`、`ojinteract.exe` 与 MinGW 运行库。安装版与便携版共用 `%APPDATA%\OiJudge` 数据目录。

## rc.8 修复（重要）

- 修复从 rc.6/rc.7 旧库升级失败：
  - 现象：`npm start` 报 `no such column: status`
  - 原因：`SCHEMA` 在 `ensureColumn` 之前创建 `batch_items(batch_id, status)` 索引，而 rc.6 的 `batch_items` 没有 `status`
  - 修复：索引改到列迁移之后创建
  - 回归测试：构造 rc.6 风格 `batch_items`，执行 `migrate()` 不抛错，补齐 `status/error_code/error_message` 并创建索引
  - 已用真实旧 `runtime/db/oijudge.db` 启动验证：`/api/health` 200
- 修正 update-check 发布测试：远端 fixture 使用比当前版本更高的 `rc.999`，避免版本 bump 后误判

> rc.7 的升级迁移有缺陷，建议直接使用 rc.8；已安装 rc.7 的用户升级前仍请备份数据目录。

## rc.7 新增

### 批量评测

- 5000 人级批量导入链路：
  - 原始 ZIP 流式上传，`.part` + rename，sha256，Content-Length/磁盘预检
  - fflate 流式预览，不整包 `unzipSync`
  - 文件结构、学生/题目层级、无效学生、重复项预览
  - 可视化映射工作区：个人/团队/公共题目筛选、按题目顺序批量绑定、手动改映射、未映射禁止开始
  - 后台异步导入：202 + 轮询，500 条事务，逐条失败隔离
  - 导入 resume：重启后跳过已导入/已失败项继续
  - 单文件上限 512 MiB（管理员可配置），ZIP 上限 5 GiB
  - batch 评测优先级低于在线提交
- 批量结果导出：
  - CSV 长表
  - 学生×题目矩阵 CSV
  - Excel `.xlsx`（成绩明细 + 矩阵双 sheet，流式 WorkbookWriter）
  - 自包含 HTML（可打印、自动分析摘要、矩阵）
  - 5000 行 keyset 分页、逐行 chunk，不整包拼字符串
- 失败隔离：
  - `SOURCE_TOO_LARGE`、`EMPTY_SOURCE`、`UNSUPPORTED_SOURCE`
  - `UNMAPPED_PROBLEM`、`INVALID_STUDENT_FOLDER`
  - `USER_CREATE_FAILED`、`SUBMIT_FAILED`、`UNSAFE_PATH`
  - `BATCH_RESUME_UPLOAD_MISSING`
  - 单条失败不再导致整批 500

### 题号与题目附件

- 洛谷式分类题号：
  - `problem_categories`
  - 旧题按内部 id 升序迁入 P，生成 `P1001…`
  - 分类独立递增，编号不复用
  - 管理员新增分类、手动改题号
  - `/api/problems/:idOrDisplayId` 同时接受数字 id 和 `P1001`
  - 旧数字 URL 兼容
  - 批量文件夹接受 `P1001` 或数字 id
- 题目附件：
  - PDF / 图片 / ZIP
  - 单文件 50 MiB
  - `visibility=problem|admin`
  - 题目可见即可下载
  - 管理端附件 Tab、题目页附件 Tab
  - 鉴权下载，不暴露真实路径

### 比赛统计与 PDF

- `GET /api/contests/:id/statistics`：
  - 正式榜/封榜口径
  - OI/IOI 分数分布；ACM/CF 通过题数/罚时
  - KPI、总分分布+累计、分数段环形
  - 每题得分/AC 分布、难度/区分度、班级/团队对比
  - 自动分析
- 统计仪表盘：
  - ECharts 按需加载
  - 1505 行虚拟滚动
  - 5000+ 服务端分页 + 搜索
  - 公开比赛页 + 管理控制台入口
- PDF：
  - 分析报告 PDF：KPI、图表、自动分析
  - 完整个人成绩 PDF：可见参赛者；管理员可含隐藏
  - 浏览器打印，不引入服务端 Chromium
- 班级/训练统计复用：
  - 教练工作台“薄弱标签掌握率”
  - 训练计划成员完成度图

### 班级、训练与教练

- 班级 = 团队的一种：`kind=class`、多教练、`allowContest`
- 班级管理 UI、改名、删除、参赛开关
- 班级参赛名单只算学生
- 训练计划：
  - 后端 + 前端
  - 题目、目标分、截止时间
  - 成员进度、逾期
  - 平台管理员 `scope=all` 全量计划列表
- 学习统计：
  - 错题：从未 AC / 最新非 AC
  - 标签掌握度
  - 班级学习统计
  - 14 天未活跃
  - 定时重建 + 管理员手动重建
- 教练：
  - 班级工作台
  - 学生提交列表
  - 查看源码 + 审计 `submission.source_view`

### 团队与比赛

- 团队成员与参赛资格同步
- 解散团队撤销 team 来源资格
- 纯团队赛禁止个人报名
- 班级参赛名单/冲突检测只算学生
- CF-like 团队 Hack 分完整化
- 比赛结果报告导出
- 队列位置显示
- 隐藏题提交记录过滤
- 正式榜服务端分页 + 用户名/姓名/班级搜索

### Electron 与交付

- 修复打包态启动无窗口/无网页：
  - 根因：release 产物继承 Low integrity 标签，无法写 `%APPDATA%`
  - build-portable 输出树 icacls 规范化 Medium
  - desktop 启动日志、userData 可写性探测、单实例失败日志
  - server stdio pipe、60s 超时、子进程输出入日志
- NSIS 安装包实际构建：
  - `OiJudge-Setup-1.1.0-rc.8.exe`
  - 静默安装/卸载实测
  - 安装态 smoke：窗口、server、`/api/health` 200、LAN、Web UI
- 新增 `npm run build:installer`
- 新增 `npm run smoke:desktop` / `smoke:desktop:dev`
- Windows 一键部署脚本：
  - install/uninstall/start/stop/status
  - 防火墙、快捷方式、HKCU 自启
  - 数据目录保留
  - dry-run
- `.gitattributes` 强制 `.mjs/.cjs` LF，修复 Windows CRLF shebang 导致的 release 测试失败

## 已有功能

### 评测

- C++14 / C++17 / C++20、C11
- OI / IOI / ACM / CF-like 排名
- 传统题、文件 IO、SPJ/testlib、交互题、客观题、输出型题
- 子任务依赖、部分分、Hack、重测
- 取消排队中 / 运行中评测
- 10 秒提交冷却、崩溃恢复、OLE
- Job Object 沙箱、时间/内存限制、输出限制
- 编译缓存、评测并发配置

### 比赛

- 草稿 / 运行 / 封榜 / 结束 / 归档
- 服务器时钟自动开始、封榜、解封、结束
- 参赛资格与比赛访问控制
- 个人 / 团队 / 混合报名
- 管理员导入 / 开放报名 / 审核报名
- 报名窗口、accepted 自助取消、审核、签到、监考
- 比赛大屏、奖项、团队奖、参赛证书
- 正式榜缓存与 `ranking.delta`
- 比赛公告、Hack、补题/订正排名

### 出题与题库

- 题目管理、Markdown/KaTeX、资源上传
- Data Plan、生成器、质量门禁、预览、发布
- 题目 ACL、可见性、题单分享
- 题单：个人/团队/公开

### 团队与社区

- 团队创建/邀请/转让/解散
- 团队题单、团队题目库
- 讨论区、站内消息、公告
- 用户/班级/排名/审计

### 帮助与运维

- 帮助中心、系统诊断、备份/恢复
- 每日自动备份（保留 7 份 + 校验）
- 版本检查（含 prerelease）+ 升级前备份
- 本地监控指标
- Electron 托盘/开机自启/单实例
- 局域网监听、LAN 地址日志

## 升级说明

- 从 rc.6 升级前请备份数据目录。
- 首次启动会自动迁移：
  - `problems.display_id/category_id/seq`
  - 旧题按 id 升序迁移到 P1001…
  - `batch_items` 状态/错误字段
  - `problem_attachments` 表
- 旧 `/problem/<数字 id>` 链接继续兼容。
- 批量 zip 映射可继续使用数字题目 id，也可使用 `P1001`。

## 已知限制

- **安装器未签名**，默认 Electron 图标，首次运行可能触发 SmartScreen。
- 首次冷启动可能受 Defender 扫描影响，当前 server 启动超时 60s，建议后续提高到 120s。
- **4C/8G 目标环境尚未完成正式验收**：2 小时 300 在线 + 50 并发、5000×4 批量压测未做。
- 批量附件/题目附件 50 MiB 仍内存缓冲，未流式落盘。
- 删除题目不会清理附件文件。
- 题目 picker 上限 500，超过 500 题的自动匹配受限。
- 统计搜索仅覆盖用户名/姓名/班级，不含排名/分数/题号。
- 打印个人成绩 PDF 仍传输完整榜。
- 隐藏选手团队聚合尚未严格排除。
- Windows 目前为托盘/启动项/脚本部署，不是 SCM 服务。
- 备份为目录复制，不是压缩归档；大目录会同步阻塞。
- 浏览器 E2E 仅覆盖主流程、建班/学生访问，未覆盖统计打印/批量全流程。
- RC 版本接口与数据结构仍可能调整。

## 规划中

- 安装包签名、自定义图标、冷启动超时
- Windows SCM 服务化
- 自动下载/安装升级与回滚
- 5000×4 与 4C/8G 正式验收
- 统计打印 E2E
- 附件流式与清理
- 训练/班级更多统计图
