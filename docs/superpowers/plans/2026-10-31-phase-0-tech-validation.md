# Phase 0 技术验证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 4 核/8GB Windows 目标上验证五个高风险技术点（Electron+SQLite、Job Object runner、testlib SPJ、Fastify+WS、性能基线），产出可复用的最小骨架与决策记录。

**Architecture:** npm workspaces 单仓库；`apps/server` 提供 Fastify HTTP/WS 与 SQLite；`apps/desktop` 用 Electron `utilityProcess` 拉起 server 并加载页面；`native/runner` 是 C++17/Win32 的 Job Object 执行器；`packages/shared` 放纯类型与纯函数。

**Tech Stack:** Node 24、TypeScript 5、Fastify 5、better-sqlite3、Electron、Vite（Phase 1 引入）、C++17 + MinGW GCC 16、CMake、Vitest、Playwright（electron）。

**Spec:** `docs/superpowers/specs/2026-10-31-oi-judge-design.md`

## Global Constraints

- 仅 Windows 10/11 x64；不引入 MSVC、Docker、WSL、Python 依赖。
- 使用本机 WinLibs GCC 16.1.0（路径自动探测），不把编译器打包进仓库。
- 性能预算：服务 RSS ≤350MB、总内存 ≤900MB、事件循环 p99 ≤50ms、API p95 ≤150ms、启动 ≤4s。
- 依赖纪律：testlib.h（MIT）保留 LICENSE；GPL/AGPL 代码不得复制进仓库。
- 所有新增源码文件 UTF-8 无 BOM；路径避免中文/空格（临时目录用短路径）。
- 每个任务结束必须提交；提交信息用 `feat:` / `test:` / `chore:` / `docs:` 前缀。
- 失败要留下记录：任何验证不通过，写进 `docs/research/phase-0-results.md` 并给出替代方案。

---

### Task 1: Monorepo 骨架与共享协议

**Files:**
- Create: `package.json`、`.npmrc`、`tsconfig.base.json`、`vitest.config.ts`
- Create: `packages/shared/package.json`、`packages/shared/tsconfig.json`
- Create: `packages/shared/src/protocol.ts`、`packages/shared/src/index.ts`
- Test: `packages/shared/src/protocol.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `WS_EVENTS`（常量对象）、`VERDICTS`（状态码数组）、`type Verdict`

- [ ] **Step 1: 写失败测试** `packages/shared/src/protocol.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { VERDICTS, WS_EVENTS } from './protocol.js';

describe('protocol', () => {
  it('keeps stable WebSocket event names', () => {
    expect(WS_EVENTS).toEqual({
      submissionQueued: 'submission.queued',
      submissionUpdated: 'submission.updated',
      rankingDelta: 'ranking.delta',
      announcement: 'announcement',
      clarification: 'clarification',
    });
  });

  it('contains all judge verdicts', () => {
    expect(VERDICTS).toEqual([
      'AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'PE', 'PC', 'SK', 'SE', 'UKE',
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run packages/shared/src/protocol.test.ts`
Expected: FAIL（找不到 `protocol.ts` / vitest 未配置）

- [ ] **Step 3: 实现最小骨架**

`package.json`：

```json
{
  "name": "oi-local-judge",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b",
    "build:runner": "node tools/build-runner.mjs",
    "bench": "node tools/bench/run-all.mjs"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`.npmrc`：

```ini
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
```

`tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 20000,
  },
});
```

`packages/shared/package.json`：

```json
{
  "name": "@oij/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/shared/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

`packages/shared/src/protocol.ts`：

```ts
export const WS_EVENTS = {
  submissionQueued: 'submission.queued',
  submissionUpdated: 'submission.updated',
  rankingDelta: 'ranking.delta',
  announcement: 'announcement',
  clarification: 'clarification',
} as const;

export const VERDICTS = [
  'AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', 'OLE', 'PE', 'PC', 'SK', 'SE', 'UKE',
] as const;

export type Verdict = (typeof VERDICTS)[number];
```

`packages/shared/src/index.ts`：`export * from './protocol.js';`

- [ ] **Step 4: 运行测试确认通过**

Run: `npm install`
Run: `npm test`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add package.json .npmrc tsconfig.base.json vitest.config.ts packages/shared
git commit -m "chore: scaffold npm workspaces and shared protocol"
```

---

### Task 2: Fastify 服务 + 健康检查 + WebSocket 回显

**Files:**
- Create: `apps/server/package.json`、`apps/server/tsconfig.json`
- Create: `apps/server/src/app.ts`、`apps/server/src/cli.ts`
- Create: `apps/server/src/http/health.ts`
- Test: `apps/server/tests/health.test.ts`

**Interfaces:**
- Consumes: `@oij/shared`
- Produces: `buildApp(opts?: { logger?: boolean }): FastifyInstance`；HTTP `GET /api/health`；WS `/ws` 接收 `{"type":"ping"}` 回 `{"type":"pong"}`

- [ ] **Step 1: 写失败测试** `apps/server/tests/health.test.ts`

```ts
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

describe('server', () => {
  it('returns health payload', async () => {
    const app = await buildApp();
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, data: { status: 'ok', version: 1 } });
  });

  it('echoes ping over websocket', async () => {
    const app = await buildApp();
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const msg = await new Promise<unknown>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'ping' })));
      ws.on('message', (raw) => resolve(JSON.parse(String(raw))));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout')), 3000);
    });
    ws.close();
    expect(msg).toEqual({ type: 'pong' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run apps/server/tests/health.test.ts`
Expected: FAIL（缺少 `apps/server`、依赖未安装）

- [ ] **Step 3: 实现**

`apps/server/package.json`：

```json
{
  "name": "@oij/server",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/app.ts" },
  "dependencies": {
    "@fastify/websocket": "^11.0.0",
    "@oij/shared": "workspace:*",
    "fastify": "^5.0.0"
  },
  "devDependencies": { "ws": "^8.18.0", "@types/ws": "^8.5.12" }
}
```

> npm 不识别 `workspace:*` 时改为 `"@oij/shared": "*"`（npm 会自动链接 workspace）。

`apps/server/tsconfig.json`：extends 根配置，`rootDir: "src"`、`outDir: "dist"`、`include: ["src", "tests"]`。

`apps/server/src/http/health.ts`：

```ts
import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true, data: { status: 'ok', version: 1 } }));
}
```

`apps/server/src/app.ts`：

```ts
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { healthRoutes } from './http/health.js';

export interface AppOptions { logger?: boolean }

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(websocket);
  await app.register(healthRoutes);
  app.get('/', async (_req, reply) =>
    reply.type('text/html').send(
      '<!doctype html><html><head><title>OiJudge</title></head><body><h1>OiJudge</h1></body></html>',
    ),
  );
  app.get('/ws', { websocket: true }, (socket) => {
    socket.on('message', (raw: Buffer) => {
      const msg = JSON.parse(String(raw)) as { type?: string };
      if (msg.type === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });
  });
  return app;
}
```

`apps/server/src/cli.ts`：

```ts
import { buildApp } from './app.js';

const app = await buildApp({ logger: true });
const port = Number(process.env.OIJ_PORT ?? 8787);
const host = process.env.OIJ_HOST ?? '0.0.0.0';
await app.listen({ port, host });
app.log.info({ port, host }, 'ojserver listening');
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm install`
Run: `npm test -- --run apps/server/tests/health.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add apps/server
git commit -m "feat: add fastify server with health and websocket echo"
```

---

### Task 3: SQLite（better-sqlite3）与 Electron ABI 验证

**Files:**
- Modify: `apps/server/package.json`（加 `better-sqlite3`）
- Create: `apps/server/src/storage/db.ts`
- Test: `apps/server/tests/db.test.ts`
- Create: `tools/check-sqlite-electron.cjs`

**Interfaces:**
- Consumes: 无
- Produces: `openDatabase(file: string): Database.Database`（开启 WAL/foreign_keys/busy_timeout）

- [ ] **Step 1: 写失败测试** `apps/server/tests/db.test.ts`

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('sqlite', () => {
  it('enables WAL and commits a 20-row transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-db-'));
    dirs.push(dir);
    const db = openDatabase(join(dir, 'test.db'));
    db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL)`);
    const insert = db.prepare('INSERT INTO t(v) VALUES (?)');
    db.transaction(() => { for (let i = 0; i < 20; i++) insert.run(`v${i}`); })();
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect((db.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n).toBe(20);
    db.close();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run apps/server/tests/db.test.ts`
Expected: FAIL（找不到 `better-sqlite3` / `openDatabase`）

- [ ] **Step 3: 实现**

`apps/server/package.json` dependencies 增加：

```json
"better-sqlite3": "^12.0.0"
```

devDependencies 增加：

```json
"@types/better-sqlite3": "^7.6.13"
```

`apps/server/src/storage/db.ts`：

```ts
import Database from 'better-sqlite3';

export function openDatabase(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -65536');
  db.pragma('mmap_size = 134217728');
  db.pragma('temp_store = MEMORY');
  db.pragma('wal_autocheckpoint = 1000');
  return db;
}
```

`tools/check-sqlite-electron.cjs`：

```js
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE t(x)');
db.prepare('INSERT INTO t VALUES (?)').run(1);
console.log(JSON.stringify({ ok: true, sqlite: db.prepare('select sqlite_version() v').get().v }));
db.close();
```

- [ ] **Step 4: 运行测试 + Electron ABI 验证**

Run: `npm install`
Run: `npm test -- --run apps/server/tests/db.test.ts`
Expected: PASS

Run（Electron 在 Task 4 安装后）：
`npx electron tools/check-sqlite-electron.cjs`
Expected: 输出 `{"ok":true,...}`。
若报 `NODE_MODULE_VERSION` 不匹配：记录到 `phase-0-results.md`，改用 `@libsql/client` 或 `node:sqlite`，并停止 Task 4 的依赖假设。

- [ ] **Step 5: 提交**

```bash
git add apps/server/package.json apps/server/src/storage/db.ts apps/server/tests/db.test.ts tools/check-sqlite-electron.cjs package-lock.json
git commit -m "feat: add sqlite wrapper with wal and electron abi check"
```

---

### Task 4: Electron 壳 + utilityProcess + Playwright 冒烟

**Files:**
- Create: `apps/desktop/package.json`、`apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main.ts`、`apps/desktop/src/preload.ts`
- Create: `playwright.config.ts`
- Test: `tests/e2e/desktop-smoke.spec.ts`
- Modify: `apps/server/src/cli.ts`（向 `process.parentPort` 发送 ready）

**Interfaces:**
- Consumes: `buildApp`/server CLI（Task 2）
- Produces: Electron 主进程启动服务并加载 `http://127.0.0.1:<port>`；页面 `<title>OiJudge</title>` 可见

- [ ] **Step 1: 写失败测试** `tests/e2e/desktop-smoke.spec.ts`

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import { join } from 'node:path';

test('desktop window loads local server', async () => {
  const app = await electron.launch({ args: [join(process.cwd(), 'apps/desktop/dist/main.js')] });
  const page = await app.firstWindow();
  await expect(page).toHaveTitle('OiJudge');
  await expect(page.locator('body')).toContainText('OiJudge');
  await app.close();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run tests/e2e/desktop-smoke.spec.ts`
Expected: FAIL（Playwright/Electron 未安装或 main.js 不存在）

- [ ] **Step 3: 实现**

安装：

```bash
npm i -D electron @playwright/test
```

`apps/desktop/package.json`：

```json
{
  "name": "@oij/desktop",
  "private": true,
  "type": "module",
  "main": "dist/main.js",
  "scripts": { "build": "tsc -p tsconfig.json" }
}
```

`apps/desktop/src/main.ts`：

```ts
import { app, BrowserWindow, utilityProcess } from 'electron';
import { join } from 'node:path';

let win: BrowserWindow | null = null;

async function startServer(): Promise<number> {
  const entry = join(app.getAppPath(), '..', 'server', 'dist', 'cli.js');
  const child = utilityProcess.fork(entry, [], { stdio: 'inherit' });
  return await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10000);
    child.on('message', (msg: { type?: string; port?: number }) => {
      if (msg?.type === 'ready' && typeof msg.port === 'number') {
        clearTimeout(timer); resolve(msg.port);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}

app.whenReady().then(async () => {
  const port = await startServer();
  win = new BrowserWindow({
    width: 1280, height: 800, title: 'OiJudge',
    webPreferences: { preload: join(import.meta.dirname, 'preload.js'), contextIsolation: true },
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

`apps/desktop/src/preload.ts`：

```ts
import { contextBridge } from 'electron';
contextBridge.exposeInMainWorld('oij', { version: 1 });
```

`apps/server/src/cli.ts` 增加：

```ts
const parentPort = (process as unknown as { parentPort?: { postMessage(v: unknown): void } }).parentPort;
if (parentPort) parentPort.postMessage({ type: 'ready', port: (app.server.address() as { port: number }).port });
```

`playwright.config.ts`：

```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: 'tests/e2e', timeout: 30000, workers: 1 });
```

> 注意：`app.getAppPath()` 在打包后指向 asar，Phase 0 只验证开发布局；Phase 1 改为 `utilityProcess.fork(path.join(process.resourcesPath, 'server/cli.js'))`。

- [ ] **Step 4: 构建并运行测试**

Run: `npm run build --workspaces --if-present`
Run: `npx playwright test`
Expected: PASS（窗口标题 OiJudge，body 含 OiJudge 文本）
若 Electron 下载失败：配置 `ELECTRON_MIRROR` 后重试，并把结果写入 `phase-0-results.md`。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop playwright.config.ts tests/e2e apps/server/src/cli.ts package.json package-lock.json
git commit -m "feat: add electron shell with utilityProcess server and smoke test"
```

---

### Task 5: 原生 Runner（Job Object）原型

**Files:**
- Create: `native/runner/src/main.cpp`
- Create: `tools/build-runner.mjs`
- Create: `apps/server/src/judge/runner.ts`
- Create: `tests/fixtures/{ok,tle,alloc}.cpp`
- Test: `apps/server/tests/runner.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `runSandboxed(opts): Promise<RunResult>`；`RunResult = { exitCode, cpuMs, wallMs, peakMemKb, timedOut, oom, signal, stdoutBytes, stderrBytes }`

- [ ] **Step 1: 写失败测试** `apps/server/tests/runner.test.ts`

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSandboxed } from '../src/judge/runner.js';

const gxx = process.env.OIJ_GXX ?? 'g++';
const runner = join(process.cwd(), 'native/runner/out/ojrunner.exe');

function compile(src: string, out: string) {
  writeFileSync(src, `#include <cstdio>\nint main(){ ${src.includes('tle') ? 'for(;;){}' : src.includes('alloc') ? 'char*p=new char[128*1024*1024];p[0]=1;return 0;' : 'puts("ok");return 0;'} }`);
  execFileSync(gxx, ['-O2', '-std=c++17', '-o', out, src]);
}

describe('runner', () => {
  it('runs a normal program and reports times', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-run-'));
    const exe = join(dir, 'ok.exe');
    compile(join(dir, 'ok.cpp'), exe);
    const r = await runSandboxed({ runner, exe, workdir: dir, timeMs: 1000, wallMs: 3000, memoryMb: 64, processLimit: 1, stdinFile: join(dir, 'in.txt'), stdoutFile: join(dir, 'out.txt'), stderrFile: join(dir, 'err.txt') });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.cpuMs).toBeGreaterThanOrEqual(0);
  });

  it('kills TLE', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-run-'));
    const exe = join(dir, 'tle.exe');
    compile(join(dir, 'tle.cpp'), exe);
    const r = await runSandboxed({ runner, exe, workdir: dir, timeMs: 200, wallMs: 1000, memoryMb: 64, processLimit: 1, stdinFile: join(dir, 'in.txt'), stdoutFile: join(dir, 'out.txt'), stderrFile: join(dir, 'err.txt') });
    expect(r.timedOut).toBe(true);
  }, 20000);

  it('detects memory limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-run-'));
    const exe = join(dir, 'alloc.exe');
    compile(join(dir, 'alloc.cpp'), exe);
    const r = await runSandboxed({ runner, exe, workdir: dir, timeMs: 2000, wallMs: 5000, memoryMb: 32, processLimit: 1, stdinFile: join(dir, 'in.txt'), stdoutFile: join(dir, 'out.txt'), stderrFile: join(dir, 'err.txt') });
    expect(r.oom || r.peakMemKb > 32 * 1024).toBe(true);
  }, 20000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node tools/build-runner.mjs 2>&1; npm test -- --run apps/server/tests/runner.test.ts`
Expected: FAIL（runner 与 `runSandboxed` 不存在）

- [ ] **Step 3: 实现 C++ runner（核心）**

`native/runner/src/main.cpp` 必须完成：

```cpp
// 关键调用顺序（完整错误处理按需补全）
// 1) 解析 --exe/--time-ms/--memory-mb/--process-limit/--wall-ms/--workdir/--input/--output
// 2) CreateJobObjectW(nullptr, nullptr)
// 3) SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info)：
//    ProcessMemoryLimit = memoryMb * 1024 * 1024
//    ActiveProcessLimit = processLimit
//    PerProcessUserTimeLimit = (timeMs + 1000) * 10000
//    LimitFlags = JOB_OBJECT_LIMIT_PROCESS_TIME | JOB_OBJECT_LIMIT_PROCESS_MEMORY |
//                 JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
//                 JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
// 4) CreateFileW 打开 input/output/stderr；STARTUPINFOW 设置 hStdInput/hStdOutput/hStdError
// 5) CreateProcessW(exe, nullptr, nullptr, nullptr, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
//                   env, workdir, &si, &pi)
// 6) AssignProcessToJobObject(job, pi.hProcess); ResumeThread(pi.hThread)
// 7) WaitForSingleObject(pi.hProcess, wallMs)
// 8) GetExitCodeProcess + GetProcessTimes；QueryInformationJobObject 取 PeakProcessMemoryUsed
// 9) 超时则 TerminateJobObject(job, 1)
// 10) 输出单行 JSON：
// {"exitCode":0,"cpuMs":0,"wallMs":0,"peakMemKb":0,"timedOut":false,"oom":false,
//  "signal":0,"stdoutBytes":0,"stderrBytes":0}
```

`tools/build-runner.mjs`：

```js
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const gxx = process.env.OIJ_GXX ?? 'g++';
const outDir = join(process.cwd(), 'native/runner/out');
mkdirSync(outDir, { recursive: true });
execFileSync(gxx, [
  '-O2', '-std=c++17', '-Wall', '-Wextra',
  '-o', join(outDir, 'ojrunner.exe'),
  join(process.cwd(), 'native/runner/src/main.cpp'),
], { stdio: 'inherit' });
console.log('built', join(outDir, 'ojrunner.exe'));
```

`apps/server/src/judge/runner.ts`：

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  runner: string; exe: string; workdir: string;
  timeMs: number; wallMs: number; memoryMb: number; processLimit: number;
  stdinFile: string; stdoutFile: string; stderrFile: string;
}
export interface RunResult {
  exitCode: number; cpuMs: number; wallMs: number; peakMemKb: number;
  timedOut: boolean; oom: boolean; signal: number; stdoutBytes: number; stderrBytes: number;
}

export async function runSandboxed(o: RunOptions): Promise<RunResult> {
  const { stdout } = await execFileAsync(o.runner, [
    '--exe', o.exe, '--workdir', o.workdir,
    '--time-ms', String(o.timeMs), '--wall-ms', String(o.wallMs),
    '--memory-mb', String(o.memoryMb), '--process-limit', String(o.processLimit),
    '--input', o.stdinFile, '--output', o.stdoutFile, '--stderr', o.stderrFile,
  ], { timeout: o.wallMs + 5000, windowsHide: true });
  return JSON.parse(stdout.trim()) as RunResult;
}
```

- [ ] **Step 4: 构建并运行测试**

Run: `node tools/build-runner.mjs`
Run: `npm test -- --run apps/server/tests/runner.test.ts`
Expected: PASS（3 tests）
额外手工验证：`alloc.exe` 在 32MB 限额下被终止；`tle.exe` 在 1s 墙钟内被杀；无残留进程（任务管理器/`tasklist` 检查）。
若 Job Object 在普通权限下无法限制：记录现象，测试改为验证 `timedOut` 与退出码，并在 `phase-0-results.md` 标注残余风险。

- [ ] **Step 5: 提交**

```bash
git add native/runner tools/build-runner.mjs apps/server/src/judge apps/server/tests/runner.test.ts tests/fixtures
git commit -m "feat: add job-object runner prototype with sandbox tests"
```

---

### Task 6: GCC 16 编译 + testlib / Lemon 六参数 SPJ 验证

**Files:**
- Create: `vendor/testlib.h`、`vendor/testlib.LICENSE`（MIT，来自 MikeMirzayanov/testlib）
- Create: `tests/fixtures/checker-testlib.cpp`、`tests/fixtures/checker-lemon.cpp`、`tests/fixtures/std-ab.cpp`
- Create: `apps/server/src/judge/checker.ts`
- Test: `apps/server/tests/checker.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `runChecker(opts): Promise<{ status: Verdict; score: number; message: string }>`；支持 `mode: 'testlib' | 'lemon'`

- [ ] **Step 1: 下载 testlib 并写失败测试**

```bash
mkdir -p vendor
curl.exe -L -o vendor/testlib.h https://raw.githubusercontent.com/MikeMirzayanov/testlib/master/testlib.h
curl.exe -L -o vendor/testlib.LICENSE https://raw.githubusercontent.com/MikeMirzayanov/testlib/master/LICENSE
```

`apps/server/tests/checker.test.ts`：

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runChecker } from '../src/judge/checker.js';

const gxx = process.env.OIJ_GXX ?? 'g++';

describe('checker', () => {
  it('testlib checker returns AC for equal output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oij-chk-'));
    writeFileSync(join(dir, 'in.txt'), '1 2\n');
    writeFileSync(join(dir, 'ans.txt'), '3\n');
    writeFileSync(join(dir, 'out.txt'), '3\n');
    writeFileSync(join(dir, 'checker.cpp'), `#include "testlib.h"\nint main(int argc,char*argv[]){registerTestlibCmd(argc,argv);long long a=inf.readInt(),b=inf.readInt();long long x=ouf.readLong();if(x==a+b)quitf(_ok,"ok");quitf(_wa,"bad");}`);
    const exe = join(dir, 'checker.exe');
    execFileSync(gxx, ['-O2', '-std=c++17', '-I', join(process.cwd(), 'vendor'), '-o', exe, join(dir, 'checker.cpp')]);
    const r = await runChecker({ mode: 'testlib', checker: exe, input: join(dir, 'in.txt'), output: join(dir, 'out.txt'), answer: join(dir, 'ans.txt'), workdir: dir, timeMs: 10000 });
    expect(r.status).toBe('AC');
    expect(r.score).toBe(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run apps/server/tests/checker.test.ts`
Expected: FAIL（`checker.ts` 未实现 / testlib.h 下载失败）

- [ ] **Step 3: 实现 checker 包装**

`apps/server/src/judge/checker.ts` 要点：

```ts
export type CheckerMode = 'testlib' | 'lemon';
export interface CheckerOptions {
  mode: CheckerMode; checker: string; input: string; output: string; answer: string;
  workdir: string; timeMs: number; fullScore?: number;
}
export interface CheckerResult { status: Verdict; score: number; message: string }
```

- testlib：`execFile(checker, [input, output, answer], { timeout: timeMs, cwd: workdir })`；解析退出码（0=AC，1=WA，2=PE，3=…；Phase 0 以实测为准）与 stderr 中的 `points`；失败/超时 → SE。
- lemon：`execFile(checker, [input, output, answer, String(fullScore), scoreFile, infoFile], …)`；读 `scoreFile` 数字，0..fullScore；崩溃 → SE。
- 所有输出截断 64KB；记录 `message`。

- [ ] **Step 4: 运行测试确认通过并记录协议**

Run: `npm test -- --run apps/server/tests/checker.test.ts`
Expected: PASS
然后手工跑一个 `quitp(0.5, ...)` 的 checker，记录退出码/stdout/stderr 实际值到 `docs/research/phase-0-results.md`，并据此修正解析逻辑（testlib 部分分协议以实测为准）。

- [ ] **Step 5: 提交**

```bash
git add vendor tests/fixtures apps/server/src/judge/checker.ts apps/server/tests/checker.test.ts docs/research/phase-0-results.md
git commit -m "feat: add testlib and lemon checker wrappers with protocol probe"
```

---

### Task 7: 微基准与 Phase 0 结论

**Files:**
- Create: `tools/bench/runner-bench.mjs`、`tools/bench/sqlite-bench.mjs`、`tools/bench/ranking-bench.mjs`、`tools/bench/run-all.mjs`
- Create: `docs/research/phase-0-results.md`（若 Task 6 已创建则补充）
- Test: `tests/bench/bench.test.ts`（只验证脚本能跑出合法 JSON，不设硬阈值）

**Interfaces:**
- Consumes: Task 3/5/6 的实现
- Produces: `docs/research/phase-0-results.md` 中的基线数据与决策

- [ ] **Step 1: 写失败测试** `tests/bench/bench.test.ts`

```ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('bench scripts', () => {
  it('sqlite bench emits json', () => {
    const out = execFileSync(process.execPath, ['tools/bench/sqlite-bench.mjs'], { encoding: 'utf8' });
    const data = JSON.parse(out) as { insert20Ms: number };
    expect(typeof data.insert20Ms).toBe('number');
  }, 60000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- --run tests/bench/bench.test.ts`
Expected: FAIL（脚本不存在）

- [ ] **Step 3: 实现基准脚本**

`tools/bench/sqlite-bench.mjs`：打开临时库，建表，循环 1000 次「20 行事务」，输出 `{insert20Ms, readMs, dbBytes}`（取中位数）。
`tools/bench/runner-bench.mjs`：编译一个空程序，循环 20 次调用 `runSandboxed`，输出 `{spawnMsMedian, totalMs, peakMemKb}`。
`tools/bench/ranking-bench.mjs`：构造 500 用户 × 8 题结果（每行 8 个 0..100 分数），计算每人的总分并排序，序列化为 JSON，输出 `{computeMs, serializeKb}`。纯内联实现，不依赖后续排名模块。
`tools/bench/run-all.mjs`：依次执行三个脚本，打印汇总 JSON。

- [ ] **Step 4: 运行基准并记录**

Run: `node tools/bench/run-all.mjs`
Run: `npm test -- --run tests/bench/bench.test.ts`
Expected: PASS，并把结果写入 `docs/research/phase-0-results.md`：
- runner 单点开销（目标 <15ms）
- 20 行结果事务（目标 <10ms）
- 500×8 榜单计算/序列化（目标 <5ms）
- Electron 空载内存、关 GPU 后内存（手工记录）
- SQLite ABI 结论、testlib 协议结论

- [ ] **Step 5: 提交**

```bash
git add tools/bench tests/bench docs/research/phase-0-results.md
git commit -m "chore: add phase-0 micro benchmarks and results"
```

---

### Task 8: Phase 0 决策记录与收尾

**Files:**
- Modify: `docs/research/phase-0-results.md`
- Modify: `README.md`（状态改为 Phase 1）

**Interfaces:**
- Consumes: Task 1–7 的全部结果
- Produces: 通过/不通过结论，以及 Phase 1 计划的输入

- [ ] **Step 1: 汇总决策**

在 `docs/research/phase-0-results.md` 写清：
- SQLite：better-sqlite3 是否可直接在 Electron 加载；失败时的替代方案。
- Runner：Job Object 是否可靠限制内存/进程/时间；单点开销；是否需要常驻守护。
- testlib：部分分协议实测（退出码/输出），最终解析规则。
- 性能：三项微基准数值与是否达标。
- 结论：Phase 1 是否按当前设计开工；有无设计修订。

- [ ] **Step 2: 全量验证**

Run: `npm test`
Run: `node tools/build-runner.mjs`
Run: `node tools/bench/run-all.mjs`
Expected: 全部通过；若有失败，记录为 Phase 1 的已知问题，不得静默跳过。

- [ ] **Step 3: 提交并推送**

```bash
git add -A
git commit -m "docs: record phase-0 technical validation results"
git push origin main
```

> 推送凭据：本机 Git 的 schannel 凭据可能失败。用 `gh auth token` 生成 `AUTHORIZATION: basic` 头推送，或临时把真实 Git 目录加入 PATH 后 `gh auth setup-git`；不要把 token 写入仓库。

- [ ] **Step 4: 汇报**

向用户汇报：5 项验证结果、性能数字、风险是否关闭、下一步（Phase 1 计划）。

---

## Self-Review

- **Spec coverage**：Phase 0 覆盖设计文档 10.4 的 5 项微基准与 14 章风险表中的 SQLite ABI、testlib、Job Object、Electron、4 核压测口径；Phase 1 的功能需求不在本计划内，另行编写。
- **Placeholder scan**：无 TBD/TODO；C++ runner 步骤给出了完整调用顺序与 JSON 契约，具体错误处理在实现时补齐（属于实现细节，不是缺失步骤）。
- **Type consistency**：`RunResult`、`CheckerResult`、`Verdict`、`WS_EVENTS` 命名在后续任务中保持一致。
- **Scope**：本计划只做技术验证，不交付完整产品；产出可运行的骨架与决策记录。
