# System Ops v1.1 Plan: Diagnostics + Backup

**Goal:** 管理员能在应用内看到系统健康状态，并创建可验证的数据备份；恢复先留到下一任务，避免高风险误操作。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md` 第 1 节；`requirement.txt` FR-SYS-005/007/013。

## Global Constraints

- 不新增依赖。
- 备份目录固定在 `<dataDir>/backups/<timestamp>/`，不把 `backups/` 自身再复制进去。
- 备份前执行 `PRAGMA wal_checkpoint(TRUNCATE)`，保证主 DB 文件一致。
- 诊断不得因 g++/runner 缺失而 500；每项返回 pass/warn/fail。
- 备份操作只允许 admin；写审计（现有 `/api/admin` hook 已覆盖）。
- 恢复、删除备份不在本计划；不要做“一键恢复”半成品。

---

### Task A: Backend diagnostics + backup

**Files:**
- Create: `apps/server/src/services/system-ops.ts`
- Modify: `apps/server/src/http/admin-system.ts`
- Create: `apps/server/tests/system-ops.test.ts`

**Interfaces:**
```ts
export interface DiagnosticCheck { name: string; status: 'pass'|'warn'|'fail'; detail: string }
export interface DiagnosticsReport { ok: boolean; generatedAt: number; checks: DiagnosticCheck[]; queue: {queued:number; running:number; failed:number} }
export function getDiagnostics(db, config, now?): DiagnosticsReport
export interface BackupEntry { id: string; path: string; createdAt: number; sizeBytes: number; manifest: Record<string, unknown> }
export function createBackup(db, config, now?): BackupEntry
export function listBackups(config): BackupEntry[]
```

- [ ] `getDiagnostics` checks:
  - `PRAGMA integrity_check` = ok
  - dataDir writable (`accessSync` W_OK)
  - `ojrunner.exe` exists
  - `ojinteract.exe` exists
  - g++ `--version` works (execFileSync timeout 2s; failure -> warn)
  - disk free >= 2GB (warn if lower)
  - judge queue counts
  - process memory
- [ ] `createBackup`:
  - `db.exec('PRAGMA wal_checkpoint(TRUNCATE)')`
  - copy `db/oijudge.db` to backup `db/`
  - copy `problems`, `submissions`, `plugins`, `hacks` if exist
  - write `manifest.json` with createdAt/version/entries
  - compute size recursively; return entry
- [ ] `listBackups` reads dirs with manifest, newest first.
- [ ] Routes:
  - `GET /api/admin/system/diagnostics`
  - `GET /api/admin/system/backups`
  - `POST /api/admin/system/backups`
- [ ] Tests:
  - diagnostics contains integrity/dataDir/runner/gxx/queue; missing gxx -> warn not throw
  - backup creates manifest and copies db/problems; backups dir not nested
  - listBackups returns created entry
- [ ] Run `npx vitest ...`, `tsc`, commit `feat: add diagnostics and backups`.

---

### Task B: Admin system page

**Files:**
- Create: `apps/web/src/pages/AdminSystemPage.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/AppShell.tsx`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/styles/admin.css`

- [ ] `/admin/system` page with two tabs:
  - 诊断：checks 表格/卡片，状态色，刷新；显示队列与内存
  - 备份：列表（时间/大小/路径），创建按钮，创建后刷新
- [ ] only admin nav; lazy route.
- [ ] `npm run web:typecheck`, `npm run web:build`.
- [ ] Commit `feat(web): add admin system diagnostics and backups`.

## Acceptance

- Admin opens `/admin/system`, sees diagnostics.
- Missing compiler/runner shows warn/fail, page does not crash.
- Create backup creates `<dataDir>/backups/<id>/manifest.json`; list shows it.
- No restore/delete yet; documented as next.
