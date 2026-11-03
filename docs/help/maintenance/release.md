# 发布构建（维护者）

`npm run build:release` 一条命令生成 Windows 便携版目录和 ZIP。构建在临时
git worktree 中执行，不会改写当前开发工作树的 `apps/*/dist`、`runtime/` 或
`release/`。

## 前置条件

- Windows x64，Node.js 24+，npm 11+。
- 已安装 Git for Windows（默认使用
  `C:\Program Files\Git\cmd\git.exe`；也可用 `OIJ_GIT` 指定）。
- 首次构建前在开发工作树执行过一次 `npm install` 和 `npm run build:native`；
  发布构建只复用 `node_modules`、`native/runner/out`、`native/interact/out`
  和 `vendor`，不会重新安装依赖。
- MinGW（g++）可用时，构建会把 `libgcc_s_seh-1.dll`、`libstdc++-6.dll`、
  `libwinpthread-1.dll` 一起打包；找不到时输出警告，便携包在没有 MinGW 的
  机器上可能无法启动评测器。

## 用法

```bash
# 构建 HEAD 的便携目录 + ZIP
npm run build:release

# 指定 revision / 不生成 ZIP / 保留临时 worktree（排查用）
npm run build:release -- --rev v1.1.0
npm run build:release -- --no-zip
npm run build:release -- --keep

# 直接打包当前工作树（调试用，不隔离，会写当前工作树）
node tools/build-portable.mjs --zip
```

产物：

```text
release/oi-local-judge-<version>-win-x64/
release/oi-local-judge-<version>-win-x64.zip
```

## 隔离与并发

1. 在 `release/.build.lock` 独占创建锁文件。锁中的 PID 仍存活时，第二次构建
   会直接拒绝；PID 已退出（或锁文件损坏且超过宽限期）时自动清理陈旧锁。
2. 在系统临时目录创建 `oij-release-<时间戳>-<pid>` worktree：
   `git worktree add --detach <temp> <rev>`。
3. 通过 junction 链接开发工作树的 `node_modules`，复制 native 产物与
   `package-lock.json`。
4. 在临时 worktree 执行 `npm run build`，再用
   `tools/build-portable.mjs --source <temp> --release-dir <main>/release`
   打包。
5. 用 fflate `ZipDeflate`（level 1）流式写 `<zip>.tmp`，逐个文件压缩并直接
   落盘；完成后校验 EOCD/中央目录与关键条目，再原子 rename 为正式 ZIP。
6. 删除 worktree、junction、临时目录和锁；`--keep` 会保留 worktree。

ZIP 校验会检查中央目录结构、条目数、路径安全（拒绝绝对路径和 `..`）以及
`OiJudge.exe`、启动脚本、server/web/shared dist、native runner、关键
`node_modules` 等必需条目，不需要解压整包。

## 验证建议

```bash
# 单元测试（不构建 700 MB 包）
npx vitest run tools/release/release.test.mjs
npm test

# 解压后直接启动 server 做健康检查
node release/oi-local-judge-<version>-win-x64/resources/app/apps/server/dist/cli.js
```

发布目录和 ZIP 位于 `release/`，该目录已被 `.gitignore` 忽略，不会污染提交。

## GitHub Actions（云端发布）

仓库内的 `.github/workflows/release.yml` 在 GitHub 托管的 `windows-latest`
上完成同样的构建，并额外生成 NSIS 安装包；本机不需要安装 MinGW、Electron
或 electron-builder。

工作流步骤：

1. `actions/setup-node@v4` 安装 Node.js 24，`npm ci` 安装依赖（带 npm 缓存）。
2. `msys2/setup-msys2@v2` 安装 `mingw-w64-x86_64-gcc`，把 MSYS2 的
   `mingw64\bin` 加入 `PATH` 并设置 `OIJ_GXX`，保证 `g++` 可用。
3. `npm run build:native` 编译 `ojrunner.exe` / `ojinteract.exe`。
4. `npm run build:release` 生成便携目录和 ZIP。
5. 安装 `electron-builder@24.13.3`，以 `--prepackaged` 指向便携目录
   （`release/oi-local-judge-<version>-win-x64/`，其中已含 `OiJudge.exe` 与
   `resources/app/`）生成 NSIS 安装器；配置见仓库根目录
   `electron-builder.yml`。

### 触发方式

**手动触发**（推荐在功能分支验证时使用）：

```bash
gh workflow run release.yml --ref feat/1.1-stability-authoring
gh run list --workflow release.yml --limit 3    # 取 run URL
# 或在 GitHub 页面：Actions → Release → Run workflow → 选择分支
```

**标签触发**：推送形如 `v*` 的标签自动构建，适合正式发版：

```bash
git tag v1.1.0
git push origin v1.1.0
```

`workflow_dispatch` 需要工作流文件已存在于目标分支；如果 GitHub 提示工作流
不在默认分支上，先把分支推送到远端再手动触发，或改用标签触发。

### 产物与下载

一次成功运行产出三个 artifact，均保留 14 天：

| artifact | 内容 | 位置 |
|---|---|---|
| `oi-local-judge-portable` | 便携目录（解压即用） | `release/oi-local-judge-<version>-win-x64/` |
| `oi-local-judge-zip` | 便携版 ZIP | `release/oi-local-judge-<version>-win-x64.zip` |
| `OiJudge-Setup` | NSIS 安装器 | `release/installer/OiJudge-Setup-<version>.exe` |

```bash
# 列出最近的运行
gh run list --workflow release.yml --limit 5

# 下载指定运行的全部 artifact（run id 来自上一条命令）
gh run download <run-id>

# 只下载安装器
gh run download <run-id> -n OiJudge-Setup
```

安装器支持自选安装目录，并创建桌面和开始菜单快捷方式；安装后的程序与便携
版共用一个 `%APPDATA%\OiJudge` 数据目录。

失败时工作流会打印 `release/` 内容、剩余磁盘空间和 `git status`，并直接以
非零退出码失败，不会静默跳过缺失的产物。
