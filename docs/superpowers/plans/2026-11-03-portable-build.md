# Portable Windows Build Plan

**Goal:** 生成可运行的 Windows 便携版目录/ZIP：Electron 外壳、内置 server/web、native runner、生产依赖；用户数据放 `%APPDATA%/OiJudge/runtime`，不污染安装目录。

**Decisions：**
- 本轮做 portable zip，不做 NSIS（当前环境无 makensis/electron-builder）。
- 保留 `electron.exe` 并复制为 `OiJudge.exe`；启动脚本 `启动 OiJudge.cmd`。
- 不新增依赖。
- 生产依赖用 `npm ls --omit=dev --parseable` 复制，避免整包 dev 依赖。
- 打包后目录结构：
  ```
  OiJudge/
    OiJudge.exe
    启动 OiJudge.cmd
    resources/app/
      package.json (main=apps/desktop/dist/main.js)
      apps/desktop/dist
      apps/server/dist + package.json
      apps/web/dist
      packages/shared/dist + package.json
      native/runner/out/ojrunner.exe
      native/interact/out/ojinteract.exe
      node_modules/... (production)
  ```

## Task A: Desktop path/runtime fix

**Files:** `apps/desktop/src/main.ts`

- `appRoot = app.isPackaged ? join(process.resourcesPath,'app') : join(__dirname,'../../..')`
- `process.chdir(appRoot)` before starting server.
- `serverEntry()` uses appRoot.
- env:
  - `OIJ_DATA_DIR = join(app.getPath('userData'),'runtime')`
  - `OIJ_RUNNER = join(appRoot,'native/runner/out/ojrunner.exe')`
  - `OIJ_INTERACT_RUNNER = join(appRoot,'native/interact/out/ojinteract.exe')`
- Keep host 0.0.0.0, port 0, LAN log.

## Task B: Build script

**Files:** `tools/build-portable.mjs`; root `package.json` script `build:portable`.

- Validate `apps/server/dist/cli.js`, `apps/web/dist/index.html`, `apps/desktop/dist/main.js`, native exes.
- Clean `release/oi-local-judge-<version>-win-x64`.
- Copy Electron dist.
- Copy app dirs/package.jsons.
- Copy production node_modules (parse `npm ls --omit=dev --parseable --all`; unique; preserve relative paths).
- Write app package.json `{name,version,main:'apps/desktop/dist/main.js'}` (no `type` so desktop CJS works; server/shared have own type module).
- Rename/copy electron.exe -> OiJudge.exe; write cmd launcher.
- Print total size; optional zip via PowerShell Compress-Archive if `--zip`.
- Must be idempotent.

## Verify

```bash
npm run build
node tools/build-portable.mjs --zip
```

- Check `release/.../resources/app/apps/server/dist/cli.js`, web index, runner, OiJudge.exe, zip.
- Run `npm run electron:smoke` to ensure desktop still starts in dev.
- Do NOT launch GUI in automated test unless it exits.

## Acceptance

- Portable dir/ZIP exists and contains all runtime pieces.
- No dev dependencies required.
- Desktop dev still works.
- Data dir uses userData, not repo cwd.
