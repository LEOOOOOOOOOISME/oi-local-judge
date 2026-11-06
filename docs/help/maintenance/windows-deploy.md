# Windows 一键部署

适用于 Windows 10/11 + PowerShell 5.1。脚本位于：

```text
tools/deploy/windows/
  install.ps1
  uninstall.ps1
  start.ps1
  stop.ps1
  status.ps1
  oij-common.ps1
```

## 前提

- 已构建：
  - 仓库：`npm run build`
  - 或便携版：`npm run build:release`
- Node.js 已安装（或使用便携版自带的资源路径）
- 防火墙步骤需要管理员 PowerShell；可加 `-NoFirewall` 跳过

## 安装

```powershell
# 仓库/已构建目录
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\install.ps1

# 指定便携版目录
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\install.ps1 `
  -RepoRoot C:\builds\oi-local-judge-1.1.0-win-x64 `
  -Port 8787
```

默认：

```text
部署目录：%LOCALAPPDATA%\OiJudge\deploy
数据目录：%LOCALAPPDATA%\OiJudge\runtime
端口：8787
```

安装会：

1. 校验应用目录
2. 复制/链接应用树
3. 创建数据目录
4. 创建防火墙规则（默认）
5. 创建桌面快捷方式（默认）
6. 写 HKCU Run 开机自启（默认）
7. 启动服务并等待 `/api/health`
8. 写 `install.json`

## 先演练

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\install.ps1 -DryRun
```

DryRun 不修改机器，只打印计划。

## 启动 / 停止 / 状态

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\start.ps1
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\stop.ps1
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\status.ps1
```

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\uninstall.ps1
```

默认保留数据目录；按脚本提示选择是否删除。

## 参数

| 参数 | 说明 |
|---|---|
| `-RepoRoot` | 应用源目录（仓库或便携版） |
| `-DeployDir` | 部署目录 |
| `-DataDir` | 数据目录 |
| `-Port` | 端口，默认 8787 |
| `-NoFirewall` | 不创建防火墙规则 |
| `-NoShortcut` | 不创建桌面快捷方式 |
| `-NoAutostart` | 不写开机自启 |
| `-DryRun` | 只演练，不修改 |

## 故障排查

- 端口占用：先 `status.ps1`，确认 8787 是否被其他进程占用
- 健康检查失败：查看数据目录下 `logs/` 与服务进程
- 防火墙：校园网跨机器访问需要放行 TCP 端口
- 开机自启：检查 HKCU Run 中的 `OiJudge`
- 重装：数据目录默认保留，升级前建议先做备份

## 与 Electron 的关系

桌面端还有托盘/开机自启；本脚本面向**服务器式部署**，适合一台 Windows 机器作为局域网 OJ 主机。
