# Phase A Ranking Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable ranking engine and official-score storage/API so OI contests can merge in-contest online submissions with published batch scores.

**Architecture:** Pure ranking strategies live in `packages/shared`. Server storage keeps per-cell official scores in `contest_official_scores`; a service loads contest configuration, participants, submissions, and official scores, then delegates to a preset strategy. A new HTTP endpoint exposes the official ranking; the existing `/api/contests/:id/ranking` stays for compatibility.

**Tech Stack:** TypeScript, node:sqlite, Fastify, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-phase-a-ranking-batch-design.md`

## Global Constraints

- Windows x64, Node 24, no new dependencies.
- Existing tests must stay green.
- All new DB columns must be additive via `ensureColumn`.
- No implementation of batch import, corrections, hack, or `answers.json` in this plan.
- Ranking preset defaults: OI/IOI same-rank; ACM solved→penalty→last AC; CF-like score→penalty→last AC.
- CF-like is not exact Codeforces; never label it "complete CF".

---

### Task 1: Shared ranking strategy engine

**Files:**
- Create: `packages/shared/src/rankings.ts`
- Create: `packages/shared/src/rankings.test.ts`
- Modify: `packages/shared/src/index.ts` (export new module)

**Interfaces:**
- Produces:
```ts
export type RankingPreset = 'oi' | 'ioi' | 'acm' | 'cf-like';
export interface RankingProblem { id: number; points: number; }
export interface RankingUser { id: number; }
export interface RankingSubmissionInput {
  userId: number; problemId: number; verdict: string; score: number; createdAt: number;
}
export interface RankingCell { problemId: number; score: number; verdict: string | null; attempts: number; firstAcAt: number | null; }
export interface RankingRowResult {
  rank: number; userId: number; totalScore: number; solved: number;
  penalty: number; lastAcAt: number | null; cells: RankingCell[];
}
export interface RankingConfig {
  preset: RankingPreset;
  tie: 'same-rank';
  cfLike?: { decay: number };
  freezeAt?: number | null;
}
export function computeRanking(input: {
  config: RankingConfig;
  problemIds: number[];
  userIds: number[];
  submissions: RankingSubmissionInput[];
  officialScores?: Array<{ userId: number; problemId: number; score: number; verdict: string }>;
  contestStartAt?: number | null;
  contestEndAt?: number | null;
}): RankingRowResult[];
```

- [ ] **Step 1: Write failing tests**

Create `packages/shared/src/rankings.test.ts` with:
- OI: two users same total → same rank (1,1), next rank 3.
- OI uses `officialScores` over submissions when provided.
- ACM: user with more solved ranks first; equal solved lower penalty first.
- ACM penalty = sum of minutes from contest start to first AC + 20 per wrong attempt before AC.
- CF-like: earlier AC gets higher score than later AC; decay config respected.
- IOI: same-rank total ordering.
- Freeze: submissions after `freezeAt` excluded.

Run: `npx vitest run packages/shared/src/rankings.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `computeRanking`**

Implement per preset:
- OI/IOI: per cell best score; total; same-rank by total; cells include attempts and firstAcAt.
- ACM: per cell first AC, wrong attempts before AC; solved; penalty; sort solved desc, penalty asc, lastAcAt asc; same triple same rank.
- CF-like: per cell score `Math.round(points * (1 - decay * elapsed / duration))`; only first AC counts; penalty as ACM; sort score desc, penalty asc, lastAcAt asc.

- [ ] **Step 3: Run tests**

Run: `npx vitest run packages/shared/src/rankings.test.ts`
Expected: PASS.

- [ ] **Step 4: Typecheck and commit**

Run: `npx tsc -p packages/shared/tsconfig.json`
Commit: `feat: add shared ranking strategy engine`.

---

### Task 2: Official score storage

**Files:**
- Modify: `apps/server/src/storage/migrate.ts`
- Create: `apps/server/src/storage/repos/official-scores.ts`
- Create: `apps/server/tests/official-scores.test.ts`

**Interfaces:**
- Produces:
```ts
export interface OfficialScoreRow {
  contest_id: number; user_id: number; problem_id: number;
  score: number; verdict: string; source: 'online' | 'batch';
  batch_id: number | null; updated_at: number;
}
export function getOfficialScore(db, contestId, userId, problemId): OfficialScoreRow | null;
export function listOfficialScores(db, contestId): OfficialScoreRow[];
export function upsertOfficialScore(db, input: {
  contestId: number; userId: number; problemId: number;
  score: number; verdict: string; source: 'online' | 'batch'; batchId?: number | null;
}): void;
export function seedOfficialScoresFromSubmissions(db, contestId: number): number;
```

- [ ] **Step 1: Add failing tests**

Tests:
- upsert then get returns values.
- seed from contest submissions picks max score per user/problem; only contest_id matches; finished/AC/partial included; other contests ignored.
- upsert overwrite updates score/source/batch_id.

Run: `npx vitest run apps/server/tests/official-scores.test.ts` → FAIL.

- [ ] **Step 2: Add schema**

In `migrate.ts` create `contest_official_scores` table + indexes. Add `ensureColumn` for:
- `contests.ranking_rule_json TEXT NOT NULL DEFAULT '{}'`
- `contests.archived_at INTEGER`
- `contest_participants.hidden_at INTEGER`
- `submissions.phase TEXT NOT NULL DEFAULT 'contest'`
- `submissions.batch_id INTEGER`
- `batch_jobs.contest_id INTEGER`
- `batch_jobs.mode TEXT`
- `batch_jobs.problem_level INTEGER`
- `batch_jobs.problem_map_json TEXT NOT NULL DEFAULT '{}'`
- `batch_jobs.created_by INTEGER`
- `batch_items.score INTEGER NOT NULL DEFAULT 0`
- `batch_items.verdict TEXT`
- `batch_items.time_ms INTEGER NOT NULL DEFAULT 0`
- `batch_items.memory_kb INTEGER NOT NULL DEFAULT 0`

- [ ] **Step 3: Implement repo and seed**

Seed query:
```sql
SELECT user_id, problem_id, MAX(score) AS score
FROM submissions
WHERE contest_id = ? AND phase = 'contest' AND status = 'finished'
GROUP BY user_id, problem_id
```
For verdict, prefer `AC` when any AC for that score; otherwise `PC`/`WA` from the max-score row (order by score desc, created_at asc).

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run apps/server/tests/official-scores.test.ts`
Commit: `feat: add official score storage`.

---

### Task 3: Official ranking service and API

**Files:**
- Create: `apps/server/src/services/official-ranking.ts`
- Create: `apps/server/tests/official-ranking.test.ts`
- Modify: `apps/server/src/http/contests.ts`

**Interfaces:**
- Consumes Task 1 `computeRanking`, Task 2 official scores.
- Produces:
```ts
export function getOfficialRanking(db, contestId): {
  contest: ContestRow;
  problems: Array<{ id: number; points: number; ordinal: number }>;
  rows: RankingRowResult[];
  config: RankingConfig;
  archived: boolean;
} | null;
```
- API: `GET /api/contests/:id/official-ranking` returns `{ok:true,data}`; 404 if contest missing.

- [ ] **Step 1: Failing tests**

Tests:
- OI contest: participant without submissions appears with 0.
- OI contest: published official score included; hidden participant excluded.
- ACM contest: no batch needed; submissions produce sorted rows.
- Archived contest returns `archived:true` and still data.
- Missing contest 404.

Run: `npx vitest run apps/server/tests/official-ranking.test.ts` → FAIL.

- [ ] **Step 2: Implement service**

- Load contest, `contest_problems`, participants (hidden_at null), submissions `phase='contest'`, official scores.
- Parse `ranking_rule_json`; fallback `{preset:'oi', tie:'same-rank'}`.
- For OI, if no official rows and submissions exist, seed once.
- Call `computeRanking`.
- Return rows and metadata.

- [ ] **Step 3: Add route**

In `contests.ts`:
```ts
app.get('/api/contests/:id/official-ranking', async (req, reply) => {
  const data = getOfficialRanking(options.db, Number(req.params.id));
  if (!data) return reply.code(404).send({ ok:false, error:{code:'NOT_FOUND'} });
  return { ok:true, data };
});
```

- [ ] **Step 4: Run tests, build, commit**

Run:
- `npx vitest run apps/server/tests/official-ranking.test.ts`
- `npm run build`
Commit: `feat: add official ranking API`.

---

### Task 4: Frontend official ranking integration

**Files:**
- Modify: `apps/web/src/pages/ContestRankingPage.tsx`
- Modify: `apps/web/src/api/types.ts`
- Create: `apps/web/src/pages/AdminContestBatchPage.tsx` (placeholder page only; functionality in next plan)

**Interfaces:**
- API response from Task 3.
- Ranking row fields: `rank,userId,totalScore,solved,penalty,lastAcAt,cells`.

- [ ] **Step 1: Add types and fetch**

Add `OfficialRanking` types and fetch `/api/contests/:id/official-ranking`; fall back to old `/ranking` only on 404.

- [ ] **Step 2: Render official columns**

Show rank/user/class/total/per-problem/penalty; archived badge; freeze badge.

- [ ] **Step 3: Build and headless smoke**

Run:
- `npx tsc -p apps/web/tsconfig.json --noEmit`
- `npm run build`
- Edge headless: open contest ranking, verify rows and no console errors.

- [ ] **Step 4: Commit**

Commit: `feat: show official ranking page`.

---

## Verification

- `npx vitest run` — all tests pass.
- `npm run build` — passes.
- Manual: create OI contest, seed official score in DB test, open official ranking.
- No changes to batch import/hack/correction behavior in this plan.

## Non-goals (next plan)

- Contest batch draft/preview/publish endpoints and UI.
- Roster CSV import/hide UI.
- Corrections, hack, `answers.json`.
