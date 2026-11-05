# Authoring Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把一次已完成的生成任务发布为正式测试点/子任务，并在发布前跑质量门禁。

**Architecture:** 新增 `publish-generation.ts` 纯服务；API 只做参数解析与错误映射；事务内替换 `problem_subtasks` / `problem_testcases`，把生成文件复制到题目 `data/` 目录，标记 job `published`。质量门禁允许“未做确定性复跑”作为 warning，由发布者显式确认。

**Tech Stack:** TypeScript、Fastify、`node:sqlite`、Vitest、React/AntD。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md` 第 3.5/3.8 节。

## Global Constraints

- 不新增依赖。
- 发布必须在单事务内完成：子任务、测试点、题目限制、job 状态要么全成功，要么全回滚。
- 发布前必须跑 `evaluateQualityGates`；有 `block` 拒绝；只有 warning 时必须 `confirmWarnings: true`。
- 生成文件必须复制到稳定目录 `problems/<id>/data/authoring-<jobId>/`，不能引用 job 临时目录。
- 所有路径必须校验在 `config.dataDir` 内，禁止路径穿越。
- 测试用临时 DB/目录，不依赖真实 g++。

---

### Task 1: Publish service and API

**Files:**
- Modify: `apps/server/src/authoring/quality-gates.ts`
- Create: `apps/server/src/authoring/publish-generation.ts`
- Modify: `apps/server/src/storage/repos/generation-jobs.ts`
- Modify: `apps/server/src/storage/repos/problems.ts`
- Modify: `apps/server/src/http/admin-authoring.ts`
- Create: `apps/server/tests/publish-generation.test.ts`

**Interfaces:**
- `publishGenerationJob(options: { db; config; problemId; jobId; confirmWarnings?; now? }): PublishGenerationResult`
- `class PublishError extends Error { code; status; report? }`
- `replaceSubtasks(db, problemId, items: Array<{ name; points; aggregation }>): number[]` returns new ids in order.
- `markGenerationJobPublished(db, jobId, now)`.

- [ ] **Step 1: Add empty-determinism warning**

In `quality-gates.ts`, replace the `determinism.length !== cases.length` block:

```ts
if (input.determinism.length === 0) {
  findings.push(
    finding('determinism', 'warn', '未做确定性复跑；发布前请人工确认 generator 可复现'),
  );
} else if (input.determinism.length !== cases.length) {
  // existing block
} else {
  // existing mismatch/pass
}
```

- [ ] **Step 2: Add repo helpers**

In `generation-jobs.ts`:

```ts
export function markGenerationJobPublished(db: DatabaseSync, id: number, now: number): void {
  db.prepare("UPDATE data_generation_jobs SET status = 'published', finished_at = ?, heartbeat_at = ? WHERE id = ?")
    .run(now, now, id);
}
```

Add `'published'` to `GenerationJobStatus`.

In `problems.ts`:

```ts
export function replaceSubtasks(
  db: DatabaseSync,
  problemId: number,
  items: Array<{ name: string; points: number; aggregation: string }>,
): number[] {
  db.prepare('DELETE FROM problem_subtasks WHERE problem_id = ?').run(problemId);
  const insert = db.prepare(
    'INSERT INTO problem_subtasks(problem_id, name, points, aggregation) VALUES (?, ?, ?, ?)',
  );
  return items.map((item) => Number(insert.run(problemId, item.name, item.points, item.aggregation).lastInsertRowid));
}
```

- [ ] **Step 3: Implement publish service**

Create `apps/server/src/authoring/publish-generation.ts` with:

```ts
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getAsset } from '../storage/repos/assets.js';
import { getProblem, replaceSubtasks, replaceTestcases } from '../storage/repos/problems.js';
import { getGenerationJob, listGenerationCases, markGenerationJobPublished } from '../storage/repos/generation-jobs.js';
import { parseDataPlan, splitGroupPoints, type DataPlan } from './data-plan.js';
import { evaluateQualityGates, toGateCaseSnapshot, type GateFinding, type QualityGateReport } from './quality-gates.js';

export class PublishError extends Error {
  readonly code: string;
  readonly status: number;
  readonly report?: QualityGateReport;
  constructor(code: string, status: number, message: string, report?: QualityGateReport) {
    super(message); this.name = 'PublishError'; this.code = code; this.status = status; this.report = report;
  }
}

export interface PublishGenerationResult {
  testcases: number;
  subtasks: number;
  warnings: GateFinding[];
  report: QualityGateReport;
}

export function publishGenerationJob(options: { db: DatabaseSync; config: Config; problemId: number; jobId: number; confirmWarnings?: boolean; now?: number }): PublishGenerationResult {
  const { db, config, problemId, jobId } = options;
  const job = getGenerationJob(db, jobId);
  if (!job || job.problem_id !== problemId) throw new PublishError('JOB_NOT_FOUND', 404, 'generation job not found');
  if (job.status !== 'finished') throw new PublishError('JOB_NOT_READY', 409, 'generation job is not finished');
  const problem = getProblem(db, problemId);
  if (!problem) throw new PublishError('PROBLEM_NOT_FOUND', 404, 'problem not found');
  const parsed = parseDataPlan(job.plan_json);
  if (!parsed.ok || !parsed.plan) throw new PublishError('PLAN_INVALID', 409, 'data plan is invalid');
  const plan = parsed.plan;
  const cases = listGenerationCases(db, jobId);
  if (cases.length === 0 || cases.some((row) => row.status !== 'finished')) {
    throw new PublishError('CASES_NOT_READY', 409, 'not all cases are finished');
  }
  const hasValidator = getAsset(db, problemId, 'validator') !== null;
  const snapshots = cases.map(toGateCaseSnapshot);
  const report = evaluateQualityGates({
    plan,
    cases: snapshots,
    compile: { generator: true, std: true, validator: hasValidator ? true : null, checker: null },
    hasValidator,
    requiresValidator: false,
    samples: [],
    determinism: [],
    budget: {
      actualWallMs: Math.max(0, (job.finished_at ?? job.created_at) - (job.started_at ?? job.created_at)),
      maxWallMs: 30 * 60 * 1000,
      actualDiskBytes: reportDisk(snapshots),
      maxDiskBytes: 2 * 1024 * 1024 * 1024,
    },
  });
  if (!report.pass) throw new PublishError('QUALITY_GATE_BLOCKED', 409, 'quality gates blocked publish', report);
  const warnings = report.findings.filter((finding) => finding.level === 'warn');
  if (warnings.length > 0 && !options.confirmWarnings) {
    throw new PublishError('QUALITY_GATE_WARNINGS', 409, 'quality gates have warnings', report);
  }

  const dataDir = join(config.dataDir, 'problems', String(problemId), 'data', `authoring-${jobId}`);
  mkdirSync(dataDir, { recursive: true });
  const testcases: Array<{ inputPath: string; outputPath: string; points: number; subtaskId: number }> = [];
  const groupPoints = new Map(plan.groups.map((group) => [group.id, splitGroupPoints(group.points, group.count)]));
  for (const row of cases) {
    if (!row.input_path || !row.output_path) throw new PublishError('CASE_FILES_MISSING', 409, `case ${row.id} has no files`);
    const inputAbs = resolve(config.dataDir, row.input_path);
    const outputAbs = resolve(config.dataDir, row.output_path);
    if (!inputAbs.startsWith(resolve(config.dataDir)) || !outputAbs.startsWith(resolve(config.dataDir)) || !existsSync(inputAbs) || !existsSync(outputAbs)) {
      throw new PublishError('CASE_FILES_MISSING', 409, `case ${row.id} files are missing`);
    }
    const inputName = `${row.group_id}-${row.case_index}.in`;
    const outputName = `${row.group_id}-${row.case_index}.out`;
    copyFileSync(inputAbs, join(dataDir, inputName));
    copyFileSync(outputAbs, join(dataDir, outputName));
    const points = groupPoints.get(row.group_id)?.[row.case_index - 1] ?? 0;
    testcases.push({
      inputPath: `problems/${problemId}/data/authoring-${jobId}/${inputName}`,
      outputPath: `problems/${problemId}/data/authoring-${jobId}/${outputName}`,
      points,
      subtaskId: 0,
    });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const subtaskIds = replaceSubtasks(db, problemId, plan.groups.map((group) => ({ name: group.name, points: group.points, aggregation: 'sum' })));
    const idByGroup = new Map(plan.groups.map((group, index) => [group.id, subtaskIds[index]]));
    for (const item of testcases) item.subtaskId = idByGroup.get(cases[testcases.indexOf(item)].group_id) ?? 0;
    replaceTestcases(db, problemId, testcases);
    db.prepare('UPDATE problems SET time_ms = ?, memory_mb = ? WHERE id = ?').run(plan.limits.timeMs, plan.limits.memoryMb, problemId);
    markGenerationJobPublished(db, jobId, options.now ?? Date.now());
    db.exec('COMMIT');
    return { testcases: testcases.length, subtasks: subtaskIds.length, warnings, report };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function reportDisk(snapshots: ReturnType<typeof toGateCaseSnapshot>[]): number {
  return snapshots.reduce((sum, row) => sum + row.inputBytes + row.outputBytes, 0);
}
```

Fix the `cases[testcases.indexOf(item)]` hack before using: build `{ row, item }` pairs. The implementer must not ship it as-is.

- [ ] **Step 4: API route**

In `admin-authoring.ts`, import `publishGenerationJob, PublishError` and add:

```ts
app.post<{ Params: { id: string; jobId: string }; Body: { confirmWarnings?: boolean } }>(
  '/api/admin/problems/:id/generation-jobs/:jobId/publish',
  { preHandler: guard },
  async (request, reply) => {
    try {
      const data = publishGenerationJob({
        db: options.db,
        config: options.config,
        problemId: Number(request.params.id),
        jobId: Number(request.params.jobId),
        confirmWarnings: request.body?.confirmWarnings === true,
      });
      return { ok: true, data };
    } catch (error) {
      if (error instanceof PublishError) {
        return reply.code(error.status).send({
          ok: false,
          error: { code: error.code, message: error.message, report: error.report },
        });
      }
      throw error;
    }
  },
);
```

- [ ] **Step 5: Tests**

Create `apps/server/tests/publish-generation.test.ts`:
- helper creates problem, generation job, cases rows with temp `.in/.out` files, marks finished.
- success: publish -> testcases rows, subtasks, job published.
- warning without confirm -> 409 `QUALITY_GATE_WARNINGS` (no validator).
- confirm -> success.
- failed case -> 409 `CASES_NOT_READY`.

- [ ] **Step 6: Run**

```bash
npx vitest run apps/server/tests/publish-generation.test.ts apps/server/tests/quality-gates.test.ts apps/server/tests/admin-authoring.test.ts
npx tsc -p apps/server/tsconfig.json --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/authoring/quality-gates.ts apps/server/src/authoring/publish-generation.ts apps/server/src/storage/repos/generation-jobs.ts apps/server/src/storage/repos/problems.ts apps/server/src/http/admin-authoring.ts apps/server/tests/publish-generation.test.ts
git commit -m "feat(authoring): publish generation jobs to testcases"
```

---

### Task 2: Frontend publish action

**Files:**
- Modify: `apps/web/src/components/DataPlanPanel.tsx`
- Modify: `apps/web/src/api/types.ts` (if needed)
- Test: `apps/web/src/components/data-plan-form.test.ts` (only pure helper if added)

- [ ] Add a “发布到题目” button when latest job status is `finished`.
- [ ] On 409 `QUALITY_GATE_WARNINGS`, show a confirm modal listing warnings; retry with `confirmWarnings: true`.
- [ ] On success, invalidate problem/testcases queries and show `testcases`/`subtasks` counts.
- [ ] Run `npm run web:typecheck && npm run web:build`.
- [ ] Commit.

---

## Self-Review

- [ ] Quality gates block publish; warnings require explicit confirm.
- [ ] Testcases and subtasks are replaced atomically.
- [ ] Generated files copied to stable `data/authoring-<jobId>/` paths.
- [ ] Job status `published` prevents re-publish? Add guard: if `job.status === 'published'`, return 409 `JOB_ALREADY_PUBLISHED`.
- [ ] No path traversal; all file paths resolve under dataDir.
