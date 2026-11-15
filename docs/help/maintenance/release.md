# 发布构建（维护者）

Windows 正式版/预发布由 GitHub Actions 的 `.github/workflows/release.yml` 构建并发布。

## 前置条件

- Windows x64 runner（CI 使用 `windows-latest`）
- Node.js 24
- MinGW-w64 g++
- 仓库可写 Release 权限
- 可选：代码签名证书秘密（没有证书时发布 unsigned）

## 发版流程

```powershell
# 1. 同步版本：5 个 package.json + package-lock.json
npm run release:bump -- 1.1.0

# 2. 更新发布说明
# docs/releases/RELEASE_NOTES.md

# 3. 提交并推送 main
git add package.json package-lock.json apps/*/package.json packages/shared/package.json docs/releases/RELEASE_NOTES.md
git commit -m "chore: release 1.1.0"
git push origin main

# 4. 打 tag 并推送
git tag v1.1.0
git push origin v1.1.0
```

tag 触发后 CI：

1. `npm ci`
2. 下载 Electron runtime
3. 构建 native runner
4. `npm run build:release` 生成便携目录 + ZIP
5. `npm run build:installer` 生成 NSIS 安装器
6. 可选代码签名
7. 生成 `SHA256SUMS.txt`
8. 创建/更新 GitHub Release 并上传资产

## RC 与正式版

- tag 含 `-rc`：创建 prerelease
- 正式 tag（如 `v1.1.0`）：普通 Release，并标记 Latest
- 正式版不使用 `--prerelease`

## 代码签名

当前仓库没有证书，发布为 unsigned；SmartScreen 可能提示。

如以后配置签名，在 GitHub Actions Secrets 添加：

- `WINDOWS_CERT_PFX_BASE64`：PFX 的 Base64
- `WINDOWS_CERT_PASSWORD`：PFX 密码

CI 会解码 PFX，设置 `CSC_LINK`/`CSC_KEY_PASSWORD`，构建后验证
Authenticode 状态必须为 `Valid`。没有秘密时明确记录 unsigned。

## worker 隔离

正式安装器提供可选“启用判题账户隔离”页面：

- 默认不启用
- 勾选后需要管理员创建 `OiJudgeWorker`
- 成功写入 `worker.json`、ACL、防火墙规则
- 失败/UAC 取消保持 optional，不伪造成功

PowerShell 部署：

```powershell
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\install.ps1 -WorkerIsolation
powershell -ExecutionPolicy Bypass -File tools\deploy\windows\install.ps1 -Interactive
```

## 产物

```text
release/oi-local-judge-<version>-win-x64/
release/oi-local-judge-<version>-win-x64.zip
release/installer/OiJudge-Setup-<version>.exe
release/SHA256SUMS.txt
```

## 发布后检查

```powershell
gh release view v1.1.0 --json isPrerelease,isLatest,assets
gh release download v1.1.0
```

必须确认：

- `isPrerelease=false`
- `isLatest=true`
- 安装器、ZIP、SHA256SUMS 均存在
- 安装/启动/health 200/卸载正常

## 失败处理

- CI 失败：修复后重跑
- Release 尚未发布：可删除远端 tag 后重打
- 已发布：不移动正式 tag，发布 `v1.1.1` 修复
- 不得把失败构建标记为成功，也不得伪造测试结果
