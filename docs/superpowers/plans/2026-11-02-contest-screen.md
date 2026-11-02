# Contest Screen: ICPC Roll + OI Countdown

**Goal:** 大屏支持 ICPC 滚榜（从低到高逐队揭示、暂停/继续/跳过/调速）和 OI 倒计时（剩余/封榜/结束），同时保留现有 5s 刷新。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md` 1.1 大屏；用户 2026-11-02 明确要求。

## Global Constraints

- 只改前端；不改后端排行榜数据。
- 不新增依赖。
- 滚榜只影响展示，不修改排名/分数。
- 现有大屏 URL `/contest/:id/screen` 保持。
- 5s 轮询继续；滚榜状态在轮询后保持（不重置已揭示数量）。
- 全屏、Top N、深色样式保留。

---

### Task 1: Pure screen helpers + tests

**Files:**
- Create: `apps/web/src/utils/screen.ts`
- Create: `apps/web/src/utils/screen.test.ts`

**Interfaces:**
```ts
export type ScreenMode = 'live' | 'roll';
export interface CountdownParts { remainingMs: number; text: string; urgent: boolean }
export function formatScreenCountdown(target: number | null, now: number): CountdownParts | null;
export function rollRevealOrder<T>(rows: readonly T[]): T[]; // bottom -> top
export function rollRevealCount(total: number, revealed: number, step: number): number;
export function rollIntervalMs(speed: 0.5 | 1 | 2): number; // base 1200ms
```

Tests:
- countdown formats `mm:ss` / `hh:mm:ss`, null target -> null, urgent < 5min
- roll order reverses
- reveal count clamps
- speed mapping.

### Task 2: Screen UI

**Files:**
- Modify: `apps/web/src/pages/ContestScreenPage.tsx`
- Modify: `apps/web/src/styles/screen.css`

Requirements:
- Header toggle: `实时榜` / `ICPC 滚榜`.
- Roll mode:
  - rows start hidden except bottom? Start with all hidden until "开始滚榜".
  - controls: 开始/暂停、继续、跳过全部、速度 0.5x/1x/2x、重置。
  - reveal from bottom (last place) upward; each tick reveals `step` rows.
  - show `已揭示 X/Y`; completed message.
  - ranking refresh must not reset revealed count; new rows append/clamp.
- OI countdown:
  - large countdown block in header: 距结束 / 已封榜 / 已结束; also freeze countdown if freeze_at future.
  - use `formatScreenCountdown`.
  - urgent red under 5 min.
- Keep problem cells/top N/auto refresh.
- CSS for controls, hidden/reveal animations, countdown.
- `npm run web:typecheck`, `npm run web:build`.

Commit: `feat(screen): add ICPC roll and OI countdown`.
