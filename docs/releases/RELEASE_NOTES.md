# OiJudge v1.2.0

Windows x64 正式版，面向局域网 OI 评测、比赛与教学训练。

> 升级前请备份数据目录。正式版安装包未签名，Windows SmartScreen 可能提示。

## 下载

- `OiJudge-Setup-1.2.0.exe`：NSIS 安装器，可选择安装目录，创建桌面/开始菜单快捷方式。
- `oi-local-judge-1.2.0-win-x64.zip`：便携版，解压即用。
- `SHA256SUMS.txt`：资产校验值。

安装版与便携版共用数据目录。具体路径以启动日志/安装向导为准。

## v1.2.0 客观题产品化

- 新增 Y 题号序列：客观题自动 `Y1001`、`Y1002`…；编程题仍为 `P1001` 起。
- 管理端新建客观题默认使用 Y 分类。
- 客观题作答页改为洛谷有题式布局：
  - 左侧答题卡/题号导航
  - 当前题、已答、未答状态
  - 逐题卡片、A/B/C/D 行式选项
  - 单选、多选、判断、填空
  - 底部固定提交栏
- 外层标题栏、色调、字体和按钮保持 OiJudge 风格。
- 滚动时答题卡自动跟随当前题；点击题号和聚焦仍优先。
- 比赛组卷支持：
  - 纯客观题
  - 客观题 + 编程题混排
- 比赛控制台显示题目类型、比赛配置分值和客观题小题合计。
- 权限/团队适配：
  - 客观题答案在公开详情、列表、比赛接口中统一剥离
  - 无 ACL 返回 404
  - team-owned 客观题按团队可见性控制
  - 团队赛客观题与编程题进入同一排名路径
- 客观题评分仍使用原后端逻辑，未改提交协议。

## v1.1.3 worker 修复

- 修复 `net user` 对超过 14 字符密码的交互式确认：
  - 非交互安装拿不到 `Y`，worker 账户创建失败，安装器返回退出码 1。
  - 现生成 14 字符随机密码，满足复杂度要求且不再触发提示。
- worker 日志改为 UTF-8，记录 `net.exe` 的真实输出、退出码和当前身份，不再只显示 `?`。
- `net.exe` 参数改为数组传递，避免 PowerShell 5.1 对 `/comment:"..."` 的再拆分。

## v1.1.2 启动修复（重要）

- 安装器安装完成后统一把安装目录规范为 **Medium integrity**：
  - 之前安装到 Low integrity 目录时，Electron 无法写 `%APPDATA%`，会无窗口、无后台静默退出。
- 桌面版默认使用 `127.0.0.1:8787`，不再随机端口：
  - 可用 `OIJ_PORT` 显式覆盖。
- worker 隔离脚本改用 `net.exe` 管理本地账户：
  - 修复 Windows PowerShell 5.1 缺少 `Get-LocalUser`/`New-LocalUser` 导致隔离启用失败。
  - 密码改为无符号字符，避免 `net.exe` 把 `/` 开头的密码当成参数。
- 安装向导勾选 worker 隔离后，只有全部步骤成功才写入 `worker.json required:true`；失败保持 optional。
- 判题并发默认提升到最多 8 个逻辑 CPU（4 核机器仍为 4），可在系统设置中修改。
- 首次冷启动服务等待从 60 秒提高到 120 秒，避免杀毒扫描/大数据库恢复时误报启动失败。

## v1.1.1 元数据修复

- 修正 `OiJudge.exe` 的 Windows 文件属性：
  - `FileDescription`、`ProductName`、`CompanyName`
  - `FileVersion` / `ProductVersion`
  - `LegalCopyright`
- 之前通过 `--prepackaged` 构建时，electron-builder 跳过版本资源，文件属性显示为 Electron；现已在归档前写入 OiJudge 元数据。
- v1.1.1 功能与 v1.1.0 相同；v1.1.2 / v1.2.0 额外修复启动、端口和 worker 安装问题。

## 亮点

### 评测

- C++14 / C++17 / C++20、C11
- OI / IOI / ACM / CF-like 排名
- 传统题、文件 IO、testlib SPJ、交互题、提交答案题、客观题
- 子任务依赖、部分分、Hack、重测、取消评测
- Windows Job Object 资源限制、编译缓存、崩溃恢复

### 比赛

- 个人 / 团队 / 混合报名
- 管理员导入 / 开放报名 / 审核报名
- 封榜、解封、归档、大屏、奖项、证书
- 正式榜缓存、WebSocket 增量、服务端分页与搜索
- 补题 / 订正排名、Hack、比赛结果报告

### 批量评测

- 大批量 ZIP 导入，流式上传/解压
- 学生/题目层级预览、无效项与重复项报告
- 可视化题目映射、顺序绑定、手动修改
- 后台异步导入、失败隔离、重启恢复
- 服务端持久进度：阶段、心跳、ETA、失败趋势
- 刷新页面后恢复当前批次
- CSV、矩阵 CSV、Excel、HTML 导出

### 统计与教学

- 比赛统计仪表盘：KPI、分布、每题、难度/区分度、班级/团队对比
- 分析报告 PDF、完整个人成绩 PDF
- ECharts 按需加载、虚拟滚动、服务端分页
- 班级、训练计划、成员完成度
- 错题、标签掌握度、学习统计、教练查看源码

### 题库

- Markdown + KaTeX + 安全 HTML 题面
- Data Plan、生成器、质量门禁
- std / checker / validator / generator / interactor / judger / brute
- 题目 ACL、题单、分类题号 `P1001…`
- 题目附件、OI/Cena/Lemon 题包导入导出

### 安全与运维

- 首次启动随机管理员密码，强制首次改密
- Session 密钥自动生成并持久化
- 默认只监听 `127.0.0.1`，LAN 显式开启
- 登录失败限流先于密码校验
- 可选内置 HTTPS，Session Cookie 自动 `Secure`
- 可选独立 Windows worker 账户、数据目录 ACL、防火墙出站阻断
- 自动备份、恢复快照、系统诊断、监控指标
- NSIS 安装器、便携版、Windows 部署脚本

## 重要升级说明

- 默认没有公开管理员账号/密码。
- 首次启动：
  - CLI 打印一次性随机管理员密码；
  - Electron 弹窗显示并支持复制；
  - 首次登录必须改密。
- 旧库存在 `admin/admin123` 时：
  - 所有旧管理员都会被强制改密；
  - 旧 Session 被吊销。
- 默认只监听 `127.0.0.1`。需要局域网访问时显式设置：
  - `OIJ_LAN=1`
  - 或 `OIJ_HOST=0.0.0.0`
  - 或安装脚本 `-Lan`
- 显式 `OIJ_SESSION_SECRET` 必须至少 32 字符，且不能是旧默认值。
- 需要 HTTPS 时配置 `OIJ_TLS_CERT` / `OIJ_TLS_KEY`；反向代理终止 TLS 可设置 `OIJ_COOKIE_SECURE=1`。
- 面向不可信选手代码时，使用安装器中的“启用判题账户隔离”选项，或运行：
  - `install.ps1 -WorkerIsolation`
  - 并设置 `OIJ_WORKER_ISOLATION=required`

## 验证

本次正式版发布前完成：

- 全量单元/接口测试
- 服务端、桌面端、Web 构建
- 浏览器 E2E 主流程
- 便携版启动与健康检查
- NSIS 安装/卸载 smoke
- rc.10 数据目录升级检查

## 已知边界

- 安装包未签名（无代码签名证书），SmartScreen 可能提示。
- worker 账户隔离需要管理员创建本地账户；未启用时以服务账户运行，不等同于强安全沙箱。
- 首次冷启动可能受 Defender 扫描影响。
- Python 3 评测尚未接入。
- 交互题使用自定义 argv/stdin/stdout 协议，testlib `registerInteraction` 完整兼容未完成。
- 代码查重按需求不做。
- 题目附件为内存缓冲；删除题目不清理附件文件。
- 统计搜索仅覆盖用户名/姓名/班级。
- Windows 当前为托盘/启动项/脚本部署，不是 SCM 服务。
- 备份为目录复制，不是压缩归档。

## 许可

OiJudge 使用 Apache License 2.0。第三方组件声明见 `THIRD_PARTY_NOTICES.md`。

## 反馈

问题与建议请提交到 GitHub Issues，并附上版本、操作系统、日志与复现步骤。
