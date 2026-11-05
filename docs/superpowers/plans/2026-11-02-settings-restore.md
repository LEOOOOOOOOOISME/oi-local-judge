# Settings Center + Restore v1.1 Plan

**Goal:** 管理员可在应用内查看/修改需要重启生效的配置，并可请求从备份恢复；恢复在下次启动、打开数据库之前执行，避免运行中替换 SQLite。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md` 第 1 节；`requirement.txt` FR-SYS-002/003/005/010。

## Global Constraints

- 不新增依赖。
- 配置优先级：环境变量 > `<dataDir>/settings.json` > 默认值；UI 显示哪些项被环境变量覆盖。
- 只允许白名单字段：`host`、`port`、`judgeConcurrency`、`gxx`、`sessionTtlSec`。
- 不在运行中替换 DB；恢复写 pending marker，CLI 启动时在 `openDatabase` 前执行。
- 恢复前自动备份当前 `db/problems/submissions/plugins/hacks` 到 `backups/pre-restore-<timestamp>/`。
- 路径必须限制在 `dataDir` 内；`backupId` 只允许 `[A-Za-z0-9._-]`。
- 恢复必须 `confirm: "RESTORE"`。

---

### Task A: Settings persistence + API

**Files:**
- Modify: `apps/server/src/config.ts`
- Create: `apps/server/src/services/settings.ts`
- Modify: `apps/server/src/http/admin-system.ts`
- Create: `apps/server/tests/settings.test.ts`

**Interfaces:**
```ts
export interface PersistedSettings {
  host?: string; port?: number; judgeConcurrency?: number; gxx?: string; sessionTtlSec?: number;
}
export function settingsFilePath(dataDir: string): string;
export function readPersistedSettings(dataDir: string): PersistedSettings;
export function writePersistedSettings(dataDir: string, patch: PersistedSettings): PersistedSettings;
export function settingsView(config: Config, dataDir: string): {
  effective: Pick<Config,'host'|'port'|'judgeConcurrency'|'gxx'|'sessionTtlSec'>;
  persisted: PersistedSettings;
  envOverrides: string[];
};
```
- `loadConfig` determines dataDir first, then reads settings file and merges.
- Env wins; `envOverrides` lists keys set in env.
- `writePersistedSettings` validates and writes atomically (`settings.json.tmp` rename).
- API:
  - `GET /api/admin/system/settings`
  - `PUT /api/admin/system/settings` body partial; returns `{settings, restartRequired:true}`
- Validation: host non-empty/<=255, port 1..65535, concurrency 1..8, sessionTtl 300..604800, gxx non-empty/<=1024.
- Tests: save/read; env > file; invalid values 400; GET/PUT round-trip; no secrets in response.

---

### Task B: Staged restore

**Files:**
- Modify: `apps/server/src/services/system-ops.ts`
- Modify: `apps/server/src/cli.ts`
- Modify: `apps/server/src/http/admin-system.ts`
- Create: `apps/server/tests/restore.test.ts`

**Interfaces:**
```ts
export interface RestoreRequest { backupId: string; requestedAt: number; restartRequired: true }
export function requestRestore(config: Config, backupId: string, now?): RestoreRequest;
export function applyPendingRestore(config: Config): { restored: boolean; backupId?: string; preRestoreId?: string };
```
- `requestRestore`: find backup by id (`listBackups`), verify manifest; write `<dataDir>/restore/pending.json`.
- `applyPendingRestore`:
  - read marker, validate backup path within `<dataDir>/backups`,
  - copy current data to `backups/pre-restore-<timestamp>/`,
  - copy backup `db/oijudge.db` and dirs into dataDir (remove DB `-wal`/`-shm`),
  - remove marker.
- CLI: `applyPendingRestore(config)` before `openDatabase`; log result.
- API `POST /api/admin/system/restore` body `{backupId, confirm}`; wrong confirm 400; unknown 404; returns `restartRequired:true`.
- Tests: request marker; apply restores DB/problem file; pre-restore backup exists; traversal backupId rejected.

---

### Task C: Admin system UI tabs

**Files:**
- Modify: `apps/web/src/pages/AdminSystemPage.tsx`
- Modify: `apps/web/src/api/types.ts`
- Modify: `apps/web/src/styles/admin.css`

- Add “设置” tab: effective/persisted/envOverrides; form for host/port/concurrency/gxx/sessionTtl; save + restart warning.
- Add “恢复” action in backups table: confirm modal with `RESTORE` input; POST; show restart required.
- Keep diagnostics/backups.
- `npm run web:typecheck`, `npm run web:build`.

## Acceptance

- Settings save writes `settings.json`; GET shows effective + env overrides; restart required.
- Restore request cannot touch arbitrary path; startup applies before DB open and creates pre-restore backup.
- UI shows settings and restore action with explicit confirmation.
