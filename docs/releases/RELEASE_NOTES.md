# OiJudge v1.1.0

Windows x64 正式版，面向局域网 OI 评测、比赛与教学训练。

> 升级前请备份数据目录。正式版安装包未签名，Windows SmartScreen 可能提示。

## 下载

- `OiJudge-Setup-1.1.0.exe`：NSIS 安装器，可选择安装目录，创建桌面/开始菜单快捷方式。
- `oi-local-judge-1.1.0-win-x64.zip`：便携版，解压即用。
- `SHA256SUMS.txt`：资产校验值。

安装版与便携版共用数据目录。具体路径以启动日志/安装向导为准。

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
