# Release Automation Plan

**Goal:** 一条命令生成可复用 Windows 发布包；构建在临时 git worktree 中执行，不修改当前开发工作树；并发构建用锁串行化；ZIP 流式生成，避免内存爆掉。

**Decisions：**
- `npm run build:release` 为入口；默认生成 portable 目录 + ZIP。
- 构建源：临时 `git worktree --detach HEAD`（或 `--rev`），主工作树只作为 node_modules/native 缓存来源。
- 锁：`release/.build.lock` 独占创建；若 PID 仍存活则拒绝；陈旧锁清理。
- 输出：`release/oi-local-judge-<version>-win-x64/` + `.zip`；先写临时目录，完成后原子替换。
- ZIP 用 fflate 流式 `ZipPassThrough/ZipDeflate`，不用 `Compress-Archive`（700MB 会内存爆）。
- 不改主工作树 `apps/*/dist`、`runtime/`、`release/` 以外的文件。
- 不新增运行时依赖；构建脚本可用 `fflate`（已有）。

## Task A: isolated build + streaming zip

**Files:**
- Modify: `tools/build-portable.mjs`：支持 `--source <dir>`、`--release-dir <dir>`、`--version`；不再假设 ROOT=脚本父目录。
- Create: `tools/release/build-release.mjs`
- Modify: `package.json`：`build:release`、`build:portable`。
- Create: `docs/help/maintenance/release.md`（可选，构建说明）。
- Create: `tools/release/release.test.mjs`（不跑 700MB；测参数/锁/临时路径 helper）。

`build-release.mjs` steps:
1. parse `--rev`、`--zip`(default true)、`--no-worktree`(debug)、`--keep`。
2. lock `release/.build.lock` with `wx`; stale PID check.
3. `git` locate: `OIJ_GIT` env or `C:\Program Files\Git\cmd\git.exe` or `git`.
4. temp worktree `os.tmpdir()/oij-release-<ts>`; `git worktree add --detach <temp> <rev>`.
5. junction `<temp>/node_modules` -> main `node_modules`; copy `native/runner/out`, `native/interact/out`, `vendor` if not present; copy `package-lock.json`.
6. run `npm run build` in temp (env `OIJ_RELEASE_BUILD=1`).
7. run `node tools/build-portable.mjs --source <temp> --release-dir <main>/release` (script from main; or temp).
8. zip streaming via fflate: traverse output dir, `ZipDeflate` level 1; write to `<zip>.tmp`; rename.
9. validate zip: PowerShell `[IO.Compression.ZipFile]::OpenRead` entry count + required names; no full extract.
10. cleanup worktree (`git worktree remove --force`), temp, lock; `--keep` preserves.
11. log sizes/duration.

Refactor build-portable:
- `SOURCE_ROOT` = `--source` or project root.
- `RELEASE_DIR` = `--release-dir` or `<source>/release`.
- Required files checked under source.
- Electron dist from main node_modules (source node_modules junction).
- App copy from source.
- MinGW detection unchanged.
- `--zip` deprecated? Keep for direct use; release script handles zip.
- Atomic output: build to `<release>/.staging-<ts>` then rename; but existing script copies directly. Could leave; lock prevents concurrent release. Dev worktree unaffected.

## Task B: installer (next)

- `electron-builder.yml` committed.
- `tools/release/build-installer.mjs`: use `.release-tools` prefix install `electron-builder` (not committed), `--prepackaged` portable `resources/app`, output `release/installer/OiJudge-Setup-<version>.exe`; verify PE/size.
- If network unavailable, report; portable zip remains.

## Verify

```bash
npm run build:release
```

- Exit 0; zip valid; portable dir; dev worktree `git status` unaffected.
- Run packaged server health/root smoke.
- Tests: `npm test` still 503.

## Acceptance

- One command builds portable + zip from an isolated worktree.
- No concurrent-build corruption; second invocation refuses with clear message.
- Dev worktree not touched.
- ZIP validated by central directory.
