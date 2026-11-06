# OI Local Judge — 目标、已完成与未完成

最后更新：2026-11-06  
当前分支：`feat/1.1-stability-authoring`  
当前 HEAD：`25b0699 merge: Windows one-click deploy`  
当前 Release：`v1.1.0-rc.6`

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

### 未完成 P1

- Excel/HTML 批量导出
- 学生×题目矩阵
- 5000×4 压力验收
- 导入恢复（resume）
- 题目搜索的真正后端 scope 接口（当前前端过滤/limit 500）

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

### 未完成 S2/S3

- 5000+ 真正的服务端分页
- 班级统计复用
- 训练统计复用
- ECharts render 完成栅栏
- 完整浏览器 E2E（统计页/打印页）
- 性能实测（1505 首屏 <1s、60fps）
- 隐藏选手团队聚合严格排除

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

- `npm test`：**106 文件 / 969 用例通过**
- `npm run build`：通过
- `npm run web:build`：通过
- 浏览器 E2E：2 passed（主流程 + 建班/学生访问）
- 子代理统计页烟测：图表/分析/虚拟表/搜索通过
- Windows deploy：PowerShell 语法解析通过；`install.ps1 -DryRun` 退出码 0

---

## 4. 没有完成 / 待精进

## 4.1 加急批量（最高优先级）

- [ ] 流式 ZIP 上传，避免 10 GB body 整包 Buffer
- [ ] 流式解压，避免 `unzipSync` 内存峰值
- [ ] 后台异步导入，不阻塞 HTTP
- [ ] 分批事务（500/批）
- [ ] 真实映射工作区：
  - 文件结构图
  - 学生/题目层级预览
  - 无效学生列表
  - 个人/团队/公共题目搜索
  - 按题目顺序批量绑定
  - 手动改映射
  - 未映射阻止开始
- [ ] 5000×4 = 20,000 提交压力测试
- [ ] 216.8 MB 源码的编译/失败隔离实测
- [ ] Excel `.xlsx` 批量导出
- [ ] HTML 批量导出
- [ ] 学生×题目矩阵
- [ ] 按班级/团队分册导出
- [ ] 5 GB ZIP 磁盘配额/临时目录清理
- [ ] 批量任务取消/恢复/重试

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

## 4.4 题目附件

目前只有设计，没有实现：

- [ ] `problem_attachments`
- [ ] 上传/下载/删除/替换
- [ ] PDF/图片/ZIP
- [ ] 50 MB 限制
- [ ] 题目可见即可下载
- [ ] 不暴露真实路径

## 4.5 统计 / UI

- [ ] 5000+ 服务端分页
- [ ] 班级/训练统计复用
- [ ] 真实性能实测：
  - 1505 首屏 <1s
  - 滚动 60fps
- [ ] `statistics.html` 实际卡顿原因（用户未能提供 DevTools）
- [ ] 旧榜单页表格虚拟化/分页（目前统计页已虚拟，原榜单仍 `pagination=false`）
- [ ] 打印等待改成 ECharts `onRendered` 栅栏
- [ ] 自动分析样本阈值处理（当前置空，不提示）
- [ ] 隐藏选手团队聚合严格排除
- [ ] 统计页/打印页完整 E2E
- [ ] PDF 分页/中文/图表实测

## 4.6 运维 / 发布

- [ ] Windows 服务化（当前只有托盘/自启）
- [ ] 自动下载/安装升级（当前检查 + 手动安装）
- [ ] 升级失败回滚
- [ ] 安装器签名
- [ ] 自定义图标
- [ ] v1.1.0-rc.7 发布
- [ ] 4C/8G 目标机验收
- [ ] 生产环境自动备份异地/SMB
- [ ] 监控告警（当前只本地指标页）
- [ ] 日志轮转

## 4.7 LemonLime 对齐

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

### 第一优先：批量 P1

1. 流式上传/解压
2. 后台导入
3. 分批事务
4. 映射工作区
5. 5000×4 实测

### 第二优先：统计收尾

1. 5000+ 服务端分页
2. 班级/训练复用
3. 打印栅栏
4. 性能实测
5. E2E

### 第三优先：题号 + 附件

1. P1001 分类迁移
2. 管理员题号管理
3. 附件上传/下载

### 第四优先：运维/发布

1. Windows 服务化
2. 升级安装/回滚
3. rc.7
4. 4C/8G 验收
