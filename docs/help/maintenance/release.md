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
