# Authoring Data Pipeline（Data Plan + 后台生成 + 预览 + 质量门禁）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让出题人用一份可校验的 Data Plan，在独立后台任务中完成 generator → std → validator 的逐点生成，并在页面上保存、预览、取消、定位失败点；同时提供发布前质量门禁服务与最小上下文帮助。

**Architecture:** 新增 `apps/server/src/authoring/` 领域层：Data Plan 纯函数服务、testlib generator 契约执行器、独立生成任务（不复用 `judge_tasks` / `scheduler`）、质量门禁纯函数。HTTP 层新增 `admin-authoring.ts`，数据落 `problem_data_plans` / `data_generation_jobs` / `data_generation_cases` 三张新表，由 `authoring-migrate.ts` 幂等建表。前端在题目管理页新增“数据计划”Tab，复用 AntD Table/Input/Select/Modal/Tabs/Drawer，不引入新依赖。

**Tech Stack:** TypeScript 5.7、Node 24、Fastify 5、`node:sqlite`、Vitest 3、React 18、Ant Design 5、`@tanstack/react-query` 5、fflate（仅在需要时沿用，本计划不新增用法）。

**Spec:** `docs/superpowers/specs/2026-11-02-oi-judge-v0.3-requirements.md`（第 3 节、6.1、7.1、8 节）

## Global Constraints

- 不新增任何运行时依赖或开发依赖。
- 保持现有 API 包络：成功 `{ ok: true, data }`；失败 `{ ok: false, error: { code, message } }`。
- 所有管理员出题接口使用现有 `requireRole(['admin', 'setter'])` 守卫；路由文件只接收 `adminGuard`。
- 生成任务不得写入 `judge_tasks`，不得调用 `scheduler.ts`，不得占用正式评测并发。
- 所有 generator 参数按 argv 数组传递，禁止 shell 拼接；禁止 `exec` / `shell: true`。
- DB 中保存相对 `dataDir` 的 POSIX 风格路径；文件系统使用 `join(config.dataDir, relativePath)`。
- 所有时间戳为毫秒整数；测试通过注入 `now()` 固定时间，不依赖真实时钟。
- 新文件统一 UTF-8 无 BOM；计划内代码不使用 `// TODO` / `TBD` / “后续补充”占位。
- 一个 Task 一个 commit，commit message 使用 `feat:` / `test:` 前缀。
- 本计划只覆盖传统题/文件 IO 的 Data Plan 生成；交互题、SPJ、客观题沿用现有流程。

### 假设 / 需调整（与现有代码的边界）

1. **新旧生成入口并存。** 现有 `POST /api/admin/problems/:id/generate`（`apps/server/src/http/admin-tools.ts`）使用 `argv[1]=seed` 的旧协议，本计划不修改它。新 Data Plan 流水线使用 spec 3.4 的 `--seed/--group/--index` 契约；两者在 1.1 期间并存，互不影响。若产品要求单一入口，需要另开任务把旧路由转调新服务，本计划不猜。
2. **`points` 语义。** 本计划规定 `groups[].points` 始终是该子任务的总分，所有 group 的 `points` 之和必须等于 100；`pointsMode: 'per-test'` 表示把这组总分平均拆到组内每个测试点（余数从第一个点开始 +1），`pointsMode: 'auto'` 只作为 UI 一键均分的辅助值，保存前会落成具体 `points`。这样不与 spec 3.3 的“`points` 总和必须等于满分”冲突。
3. **index 从 1 开始。** 存储与展示的 `index` 为 `1..count`，`seed = seedStart + index - 1`；spec 3.3 的“第 i 个点用 seedStart + i”在内部按 0 基循环实现，对外仍暴露 1 基 index。
4. **帮助文档不渲染 Markdown。** `docs/help/` 是仓库内容源，当前应用没有 Markdown 读取/渲染接口。Task 6 的 `HelpTip` 只展示标题、摘要、仓库路径并跳转 `/help`；不新增全文搜索、TOC、CMS。这是“最小接入”，不是完整帮助中心。
5. **迁移不改 `migrate.ts`。** 新表由 `apps/server/src/storage/authoring-migrate.ts` 的 `migrateAuthoring(db)` 幂等创建，并在新路由注册时调用；`schema_migrations` 仍保持版本 1，避免与现有迁移逻辑耦合。
6. **本计划不写 `problem_testcases`。** 生成结果暂存到 `problems/:id/authoring/jobs/:jobId/`，预览/门禁读取暂存结果；把结果发布为正式测试点属于发布步骤，不在本计划的 6 个 Task 内。这是本计划与端到端验收（AUT-EXP-01）的最大边界。

## File Structure

新增服务端文件：

```text
apps/server/src/authoring/
├── data-plan.ts                 # 类型、解析、校验、展开、均分、命名
├── data-plan-templates.ts       # 4 个模板
├── generator-contract.ts        # --seed/--group/--index argv 执行器
├── generation-job.ts            # 独立后台生成任务 + 默认 runtime
└── quality-gates.ts             # 发布前质量门禁纯函数

apps/server/src/storage/
├── authoring-migrate.ts         # 三张新表 + 索引
└── repos/
    ├── data-plans.ts            # problem_data_plans CRUD
    └── generation-jobs.ts       # job / case 仓储

apps/server/src/http/
└── admin-authoring.ts           # /api/admin/problems/:id/data-plan 与 generation-jobs

apps/server/tests/
├── data-plan.test.ts
├── generation-job.test.ts
├── admin-authoring.test.ts
├── quality-gates.test.ts
└── authoring-help-docs.test.ts
```

新增前端文件：

```text
apps/web/src/components/
├── data-plan-form.ts            # 表单 <-> DataPlan 纯函数
├── data-plan-form.test.ts
├── DataPlanPanel.tsx            # 数据计划 Tab（编辑、校验、启动、进度、预览）
├── AiPromptDrawer.tsx           # 仅复制的 AI 提示词抽屉
└── HelpTip.tsx                  # 最小上下文帮助

apps/web/src/help/
└── authoring-help.ts            # 帮助条目注册表
```

修改的现有文件：

```text
apps/server/src/app.ts                    # 仅 import + registerAdminAuthoringRoutes
apps/web/src/api/types.ts                 # 追加 Data Plan / Generation 类型
apps/web/src/pages/AdminProblemPage.tsx   # 追加“数据计划”Tab
apps/web/src/pages/HelpPage.tsx           # 追加“出题人文档”卡片
apps/web/src/styles/admin.css             # Data Plan 与 HelpTip 样式
apps/web/src/styles/help.css              # 出题人文档卡片样式
```

---

### Task 1: Data Plan schema / parser / validator / templates

**Files:**
- Create: `apps/server/src/authoring/data-plan.ts`
- Create: `apps/server/src/authoring/data-plan-templates.ts`
- Test: `apps/server/tests/data-plan.test.ts`

**Interfaces:**
- Produces:
  - `DATA_PLAN_SCHEMA = 'oijudge.data-plan/1'`
  - `interface DataPlan { schema; limits: DataPlanLimits; groups: DataPlanGroup[]; pointsMode: 'group' | 'per-test' | 'auto'; naming: string }`
  - `parseDataPlan(raw: unknown, options?: DataPlanValidationOptions): DataPlanValidationResult`
  - `validateDataPlan(value: unknown, options?: DataPlanValidationOptions): DataPlanValidationResult`
  - `expandDataPlan(plan: DataPlan): ExpandedDataPlanCase[]`
  - `splitGroupPoints(points: number, count: number): number[]`
  - `applyAutoPoints(plan: DataPlan, totalPoints?: number): DataPlan`
  - `formatCaseName(naming: string, groupId: string, index: number): string`
  - `caseFileName(plan: DataPlan, groupId: string, index: number): string`
  - `buildDataPlanTemplate(input: BuildDataPlanTemplateInput): DataPlan`
  - `DATA_PLAN_TEMPLATES: readonly DataPlanTemplateInfo[]`
- Later tasks consume `DataPlan`, `DataPlanValidationResult`, `expandDataPlan`, `caseFileName`, `splitGroupPoints`, `buildDataPlanTemplate`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/data-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DATA_PLAN_SCHEMA,
  applyAutoPoints,
  caseFileName,
  expandDataPlan,
  parseDataPlan,
  splitGroupPoints,
  validateDataPlan,
  type DataPlan,
} from '../src/authoring/data-plan.js';
import {
  DATA_PLAN_TEMPLATES,
  buildDataPlanTemplate,
} from '../src/authoring/data-plan-templates.js';

function basePlan(overrides: Partial<DataPlan> = {}): DataPlan {
  return {
    schema: DATA_PLAN_SCHEMA,
    limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
    groups: [
      {
        id: 'sub1',
        name: '基础',
        points: 30,
        count: 5,
        seedStart: 1,
        args: ['--n=10', '--m=10'],
        dependsOn: [],
      },
      {
        id: 'sub2',
        name: '大规模',
        points: 70,
        count: 10,
        seedStart: 1001,
        args: ['--n=100000', '--m=200000'],
        dependsOn: ['sub1'],
      },
    ],
    pointsMode: 'group',
    naming: '{group}-{index}',
    ...overrides,
  };
}

function errorCodes(plan: unknown): string[] {
  return validateDataPlan(plan).issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code);
}

describe('data plan parser and validator', () => {
  it('accepts the minimal JSON and reports totals', () => {
    const result = parseDataPlan(JSON.stringify(basePlan()));
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.plan?.groups).toHaveLength(2);
    expect(result.totals).toMatchObject({ testCount: 15, points: 100 });
  });

  it('rejects a points sum that is not the full score', () => {
    const plan = basePlan();
    plan.groups[0].points = 20;
    const result = validateDataPlan(plan);
    expect(result.ok).toBe(false);
    expect(errorCodes(plan)).toContain('POINTS_SUM');
  });

  it('rejects a dependency cycle', () => {
    const plan = basePlan();
    plan.groups[0].dependsOn = ['sub2'];
    expect(errorCodes(plan)).toContain('DEPENDENCY_CYCLE');
  });

  it('rejects an unknown dependency and a self dependency', () => {
    const plan = basePlan();
    plan.groups[0].dependsOn = ['missing'];
    plan.groups[1].dependsOn = ['sub2'];
    const codes = errorCodes(plan);
    expect(codes).toContain('DEPENDENCY_UNKNOWN');
    expect(codes).toContain('DEPENDENCY_SELF');
  });

  it('rejects seed overflow and count budget', () => {
    const overflow = basePlan();
    overflow.groups[0].seedStart = 2_147_483_640;
    overflow.groups[0].count = 100;
    expect(errorCodes(overflow)).toContain('SEED_OVERFLOW');

    const budget = basePlan();
    budget.groups[0].count = 150;
    budget.groups[1].count = 100;
    expect(errorCodes(budget)).toContain('COUNT_BUDGET');
  });

  it('rejects non-string args and a naming template without placeholders', () => {
    const plan = basePlan() as unknown as {
      groups: Array<{ args: unknown[] }>;
      naming: string;
    };
    plan.groups[0].args = ['--n=10', 5];
    plan.naming = 'case';
    const codes = errorCodes(plan);
    expect(codes).toContain('ARGS_INVALID');
    expect(codes).toContain('NAMING_INVALID');
  });

  it('reports a JSON parse failure instead of throwing', () => {
    const result = parseDataPlan('{not json');
    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.issues[0].code).toBe('JSON_PARSE');
  });
});

describe('data plan expansion and points helpers', () => {
  it('expands one-based indexes and seeds', () => {
    const cases = expandDataPlan(basePlan());
    expect(cases).toHaveLength(15);
    expect(cases[0]).toMatchObject({ groupId: 'sub1', index: 1, seed: 1 });
    expect(cases[4]).toMatchObject({ groupId: 'sub1', index: 5, seed: 5 });
    expect(cases[5]).toMatchObject({ groupId: 'sub2', index: 1, seed: 1001 });
    expect(cases[14]).toMatchObject({ groupId: 'sub2', index: 10, seed: 1010 });
  });

  it('builds safe case file names', () => {
    expect(caseFileName(basePlan(), 'sub2', 3)).toBe('sub2-3.in');
    expect(() =>
      caseFileName(basePlan({ naming: '../{group}-{index}' }), 'sub1', 1),
    ).toThrow(/unsafe/);
  });

  it('splits points evenly and keeps the remainder on the first cases', () => {
    expect(splitGroupPoints(10, 3)).toEqual([4, 3, 3]);
    expect(splitGroupPoints(10, 2)).toEqual([5, 5]);
  });

  it('auto distributes 100 points across groups', () => {
    const plan = applyAutoPoints(basePlan({ pointsMode: 'auto' }), 100);
    expect(plan.groups.map((group) => group.points)).toEqual([50, 50]);
    expect(plan.pointsMode).toBe('auto');
  });
});

describe('data plan templates', () => {
  it('exposes four templates', () => {
    expect(DATA_PLAN_TEMPLATES.map((template) => template.id)).toEqual([
      '10-30-60',
      'subtask-ladder',
      'extreme-random',
      'single-group',
    ]);
  });

  it('builds a valid 10/30/60 plan', () => {
    const plan = buildDataPlanTemplate({
      template: '10-30-60',
      limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
    });
    const result = validateDataPlan(plan);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(plan.groups.map((group) => group.points)).toEqual([10, 30, 60]);
    expect(plan.groups.map((group) => group.count)).toEqual([2, 6, 12]);
  });

  it('builds a subtask ladder with a dependency chain', () => {
    const plan = buildDataPlanTemplate({
      template: 'subtask-ladder',
      limits: { timeMs: 2000, memoryMb: 512, outputMb: 64 },
    });
    expect(plan.groups.map((group) => group.dependsOn)).toEqual([[], ['sub1'], ['sub2']]);
    expect(validateDataPlan(plan).ok).toBe(true);
  });

  it('builds a single group plan with ten cases', () => {
    const plan = buildDataPlanTemplate({
      template: 'single-group',
      limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
    });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].count).toBe(10);
    expect(plan.groups[0].points).toBe(100);
    expect(validateDataPlan(plan).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/server/tests/data-plan.test.ts`

Expected: FAIL，报错 `Cannot find module '../src/authoring/data-plan.js'`。

- [ ] **Step 3: Implement `apps/server/src/authoring/data-plan.ts`**

```ts
export const DATA_PLAN_SCHEMA = 'oijudge.data-plan/1';
export const DEFAULT_TOTAL_POINTS = 100;
export const DEFAULT_MAX_TOTAL_COUNT = 200;
export const MAX_SEED = 2_147_483_647;
export const MAX_OUTPUT_MB = 4096;

export interface DataPlanLimits {
  timeMs: number;
  memoryMb: number;
  outputMb: number;
}

export interface DataPlanGroup {
  id: string;
  name: string;
  /** 子任务总分；所有 group 的 points 之和必须等于满分。 */
  points: number;
  count: number;
  /** 第 1 个测试点的 seed；第 index 个点使用 seedStart + index - 1。 */
  seedStart: number;
  /** 原样传给 generator 的 argv 参数，不做 shell 拼接。 */
  args: string[];
  dependsOn: string[];
}

export type DataPlanPointsMode = 'group' | 'per-test' | 'auto';

export interface DataPlan {
  schema: typeof DATA_PLAN_SCHEMA;
  limits: DataPlanLimits;
  groups: DataPlanGroup[];
  pointsMode: DataPlanPointsMode;
  naming: string;
}

export interface DataPlanIssue {
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface DataPlanTotals {
  testCount: number;
  points: number;
  estimatedSeconds: number;
  estimatedBytes: number;
}

export interface DataPlanValidationOptions {
  totalPoints?: number;
  maxTotalCount?: number;
  estimatedSecondsPerCase?: number;
  estimatedBytesPerCase?: number;
}

export interface DataPlanValidationResult {
  ok: boolean;
  plan: DataPlan | null;
  issues: DataPlanIssue[];
  totals: DataPlanTotals;
}

export interface ExpandedDataPlanCase {
  groupId: string;
  groupName: string;
  index: number;
  seed: number;
  args: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(
  path: string,
  code: string,
  message: string,
  severity: DataPlanIssue['severity'] = 'error',
): DataPlanIssue {
  return { path, code, message, severity };
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function emptyTotals(): DataPlanTotals {
  return { testCount: 0, points: 0, estimatedSeconds: 0, estimatedBytes: 0 };
}

export function computeDataPlanTotals(
  groups: readonly DataPlanGroup[],
  options: DataPlanValidationOptions = {},
): DataPlanTotals {
  const testCount = groups.reduce((sum, group) => sum + group.count, 0);
  const points = groups.reduce((sum, group) => sum + group.points, 0);
  return {
    testCount,
    points,
    estimatedSeconds: testCount * (options.estimatedSecondsPerCase ?? 3),
    estimatedBytes: testCount * (options.estimatedBytesPerCase ?? 1024 * 1024),
  };
}

function findDependencyCycle(groups: readonly DataPlanGroup[]): string[] | null {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const status = state.get(id) ?? 0;
    if (status === 1) {
      const start = stack.indexOf(id);
      return [...stack.slice(start === -1 ? 0 : start), id];
    }
    if (status === 2) return null;
    state.set(id, 1);
    stack.push(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const group of groups) {
    const cycle = visit(group.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * 将任意 JSON 值规范化为 DataPlan 并校验。结构错误会返回 plan:null；
 * 业务约束错误仍返回规范化后的 plan，方便前端继续编辑并展示问题。
 */
export function validateDataPlan(
  value: unknown,
  options: DataPlanValidationOptions = {},
): DataPlanValidationResult {
  const issues: DataPlanIssue[] = [];
  const totalPoints = options.totalPoints ?? DEFAULT_TOTAL_POINTS;
  const maxTotalCount = options.maxTotalCount ?? DEFAULT_MAX_TOTAL_COUNT;

  if (!isRecord(value)) {
    return {
      ok: false,
      plan: null,
      issues: [issue('$', 'ROOT_INVALID', '数据计划必须是 JSON 对象')],
      totals: emptyTotals(),
    };
  }

  if (value.schema !== DATA_PLAN_SCHEMA) {
    issues.push(
      issue('schema', 'SCHEMA_INVALID', `schema 必须是 ${DATA_PLAN_SCHEMA}`),
    );
  }

  const limitsRaw = value.limits;
  const limits: DataPlanLimits = { timeMs: 0, memoryMb: 0, outputMb: 0 };
  if (!isRecord(limitsRaw)) {
    issues.push(issue('limits', 'LIMITS_INVALID', 'limits 必须是对象'));
  } else {
    if (!positiveInt(limitsRaw.timeMs)) {
      issues.push(issue('limits.timeMs', 'LIMIT_INVALID', 'timeMs 必须是正整数'));
    } else {
      limits.timeMs = limitsRaw.timeMs;
    }
    if (!positiveInt(limitsRaw.memoryMb)) {
      issues.push(issue('limits.memoryMb', 'LIMIT_INVALID', 'memoryMb 必须是正整数'));
    } else {
      limits.memoryMb = limitsRaw.memoryMb;
    }
    if (!positiveInt(limitsRaw.outputMb)) {
      issues.push(issue('limits.outputMb', 'LIMIT_INVALID', 'outputMb 必须是正整数'));
    } else if (limitsRaw.outputMb > MAX_OUTPUT_MB) {
      issues.push(
        issue(
          'limits.outputMb',
          'LIMIT_TOO_LARGE',
          `outputMb 不能超过 ${MAX_OUTPUT_MB}`,
        ),
      );
    } else {
      limits.outputMb = limitsRaw.outputMb;
    }
  }

  const groupsRaw = value.groups;
  const groups: DataPlanGroup[] = [];
  if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) {
    issues.push(issue('groups', 'GROUPS_EMPTY', '至少需要一个子任务组'));
  } else {
    groupsRaw.forEach((raw, groupIndex) => {
      const path = `groups[${groupIndex}]`;
      if (!isRecord(raw)) {
        issues.push(issue(path, 'GROUP_INVALID', '子任务组必须是对象'));
        return;
      }

      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
        issues.push(
          issue(`${path}.id`, 'GROUP_ID_INVALID', 'id 必须是 1-32 位字母、数字、_ 或 -'),
        );
      }

      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (name.length === 0 || name.length > 64) {
        issues.push(
          issue(`${path}.name`, 'GROUP_NAME_INVALID', 'name 必须是 1-64 个字符'),
        );
      }

      if (!nonNegativeInt(raw.points)) {
        issues.push(
          issue(`${path}.points`, 'GROUP_POINTS_INVALID', 'points 必须是非负整数'),
        );
      }

      if (!positiveInt(raw.count) || raw.count > 100) {
        issues.push(
          issue(`${path}.count`, 'GROUP_COUNT_INVALID', 'count 必须是 1-100 的整数'),
        );
      }

      if (!nonNegativeInt(raw.seedStart)) {
        issues.push(
          issue(`${path}.seedStart`, 'GROUP_SEED_INVALID', 'seedStart 必须是非负整数'),
        );
      }

      const args: string[] = [];
      if (!Array.isArray(raw.args)) {
        issues.push(issue(`${path}.args`, 'ARGS_INVALID', 'args 必须是字符串数组'));
      } else {
        raw.args.forEach((arg, argIndex) => {
          if (
            typeof arg !== 'string' ||
            arg.length > 512 ||
            /[\0\r\n]/.test(arg)
          ) {
            issues.push(
              issue(
                `${path}.args[${argIndex}]`,
                'ARGS_INVALID',
                '每个参数必须是不含 NUL/换行的字符串（长度 <= 512）',
              ),
            );
          } else {
            args.push(arg);
          }
        });
      }

      const dependsOn: string[] = [];
      if (raw.dependsOn !== undefined) {
        if (!Array.isArray(raw.dependsOn)) {
          issues.push(
            issue(`${path}.dependsOn`, 'DEPENDS_INVALID', 'dependsOn 必须是字符串数组'),
          );
        } else {
          raw.dependsOn.forEach((dependency, dependencyIndex) => {
            if (typeof dependency !== 'string' || dependency.length === 0) {
              issues.push(
                issue(
                  `${path}.dependsOn[${dependencyIndex}]`,
                  'DEPENDS_INVALID',
                  '依赖项必须是非空字符串',
                ),
              );
            } else {
              dependsOn.push(dependency);
            }
          });
        }
      }

      groups.push({
        id,
        name,
        points: typeof raw.points === 'number' ? raw.points : 0,
        count: typeof raw.count === 'number' ? raw.count : 0,
        seedStart: typeof raw.seedStart === 'number' ? raw.seedStart : 0,
        args,
        dependsOn,
      });
    });
  }

  let pointsMode: DataPlanPointsMode = 'group';
  if (value.pointsMode === 'per-test' || value.pointsMode === 'auto') {
    pointsMode = value.pointsMode;
  } else if (value.pointsMode !== undefined && value.pointsMode !== 'group') {
    issues.push(
      issue(
        'pointsMode',
        'POINTS_MODE_INVALID',
        'pointsMode 必须是 group、per-test 或 auto',
      ),
    );
  }

  const naming =
    typeof value.naming === 'string' && value.naming.length > 0
      ? value.naming
      : '{group}-{index}';
  if (!naming.includes('{group}') || !naming.includes('{index}')) {
    issues.push(
      issue('naming', 'NAMING_INVALID', 'naming 必须同时包含 {group} 和 {index}'),
    );
  }
  if (/[\\/]/.test(naming) || naming.includes('..') || /[\0\r\n]/.test(naming)) {
    issues.push(
      issue('naming', 'NAMING_INVALID', 'naming 不能包含路径分隔符、..、NUL 或换行'),
    );
  }

  const ids = new Set<string>();
  groups.forEach((group, index) => {
    if (ids.has(group.id)) {
      issues.push(
        issue(`groups[${index}].id`, 'GROUP_ID_DUPLICATE', `重复的子任务 id：${group.id}`),
      );
    }
    ids.add(group.id);
  });

  const pointsSum = groups.reduce((sum, group) => sum + group.points, 0);
  if (pointsSum !== totalPoints) {
    issues.push(
      issue(
        'groups',
        'POINTS_SUM',
        `子任务分值之和为 ${pointsSum}，必须等于满分 ${totalPoints}`,
      ),
    );
  }

  const totalCount = groups.reduce((sum, group) => sum + group.count, 0);
  if (totalCount > maxTotalCount) {
    issues.push(
      issue(
        'groups',
        'COUNT_BUDGET',
        `测试点总数 ${totalCount} 超过预算 ${maxTotalCount}`,
      ),
    );
  }

  groups.forEach((group, index) => {
    if (group.count > 0 && group.seedStart + group.count - 1 > MAX_SEED) {
      issues.push(
        issue(
          `groups[${index}].seedStart`,
          'SEED_OVERFLOW',
          `seed 范围超过 ${MAX_SEED}`,
        ),
      );
    }
    if (group.dependsOn.includes(group.id)) {
      issues.push(
        issue(
          `groups[${index}].dependsOn`,
          'DEPENDENCY_SELF',
          `子任务 ${group.id} 不能依赖自己`,
        ),
      );
    }
    for (const dependency of group.dependsOn) {
      if (!ids.has(dependency)) {
        issues.push(
          issue(
            `groups[${index}].dependsOn`,
            'DEPENDENCY_UNKNOWN',
            `未知依赖：${dependency}`,
          ),
        );
      }
    }
    if (pointsMode === 'per-test' && group.count > 0 && group.points % group.count !== 0) {
      issues.push(
        issue(
          `groups[${index}].points`,
          'POINTS_NOT_DIVISIBLE',
          `${group.points} 分不能平均分给 ${group.count} 个测试点，余数会从第一个点开始补 1`,
          'warning',
        ),
      );
    }
  });

  const cycle = findDependencyCycle(groups);
  if (cycle) {
    issues.push(
      issue(
        'groups',
        'DEPENDENCY_CYCLE',
        `依赖存在环：${cycle.join(' -> ')}`,
      ),
    );
  }

  const plan: DataPlan = {
    schema: DATA_PLAN_SCHEMA,
    limits,
    groups,
    pointsMode,
    naming,
  };
  const totals = computeDataPlanTotals(groups, options);
  return {
    ok: !issues.some((entry) => entry.severity === 'error'),
    plan,
    issues,
    totals,
  };
}

export function parseDataPlan(
  raw: unknown,
  options: DataPlanValidationOptions = {},
): DataPlanValidationResult {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return {
        ok: false,
        plan: null,
        issues: [
          issue('$', 'JSON_PARSE', `JSON 解析失败：${(error as Error).message}`),
        ],
        totals: emptyTotals(),
      };
    }
  }
  return validateDataPlan(value, options);
}

export function expandDataPlan(plan: DataPlan): ExpandedDataPlanCase[] {
  return plan.groups.flatMap((group) =>
    Array.from({ length: group.count }, (_, offset) => ({
      groupId: group.id,
      groupName: group.name,
      index: offset + 1,
      seed: group.seedStart + offset,
      args: [...group.args],
    })),
  );
}

export function splitGroupPoints(points: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(points / count);
  const remainder = points - base * count;
  return Array.from({ length: count }, (_, index) =>
    index < remainder ? base + 1 : base,
  );
}

export function applyAutoPoints(plan: DataPlan, totalPoints = DEFAULT_TOTAL_POINTS): DataPlan {
  if (plan.groups.length === 0) return plan;
  const base = Math.floor(totalPoints / plan.groups.length);
  const remainder = totalPoints - base * plan.groups.length;
  return {
    ...plan,
    pointsMode: 'auto',
    groups: plan.groups.map((group, index) => ({
      ...group,
      points: base + (index < remainder ? 1 : 0),
    })),
  };
}

export function formatCaseName(naming: string, groupId: string, index: number): string {
  return naming
    .replaceAll('{group}', groupId)
    .replaceAll('{index}', String(index));
}

export function caseFileName(plan: DataPlan, groupId: string, index: number): string {
  const name = formatCaseName(plan.naming, groupId, index);
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) {
    throw new Error(`unsafe case name: ${name}`);
  }
  return `${name}.in`;
}
```

- [ ] **Step 4: Implement `apps/server/src/authoring/data-plan-templates.ts`**

```ts
import {
  DATA_PLAN_SCHEMA,
  DEFAULT_TOTAL_POINTS,
  type DataPlan,
  type DataPlanGroup,
  type DataPlanLimits,
} from './data-plan.js';

export type DataPlanTemplateId =
  | '10-30-60'
  | 'subtask-ladder'
  | 'extreme-random'
  | 'single-group';

export interface DataPlanTemplateInfo {
  id: DataPlanTemplateId;
  name: string;
  description: string;
}

export const DATA_PLAN_TEMPLATES: readonly DataPlanTemplateInfo[] = [
  {
    id: '10-30-60',
    name: '10/30/60',
    description: '10% 边界、30% 小数据、60% 大数据，适合常规题。',
  },
  {
    id: 'subtask-ladder',
    name: '子任务阶梯',
    description: '三个子任务逐级扩大，依赖链为 sub1 -> sub2 -> sub3。',
  },
  {
    id: 'extreme-random',
    name: '极限 + 随机',
    description: '最小、最大、随机、特殊构造，适合构造题。',
  },
  {
    id: 'single-group',
    name: '只有一组',
    description: '10 个测试点均分 100 分，适合简单题/练习题。',
  },
];

export interface BuildDataPlanTemplateInput {
  template: DataPlanTemplateId;
  limits: DataPlanLimits;
  totalPoints?: number;
}

function distributePoints(total: number, weights: readonly number[]): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (weightSum <= 0) return weights.map(() => 0);
  const points = weights.map((weight) => Math.floor((total * weight) / weightSum));
  let remainder = total - points.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % points.length) {
    points[index] += 1;
    remainder -= 1;
  }
  return points;
}

function group(
  input: Omit<DataPlanGroup, 'args' | 'dependsOn'> &
    Partial<Pick<DataPlanGroup, 'args' | 'dependsOn'>>,
): DataPlanGroup {
  return {
    ...input,
    args: input.args ?? [],
    dependsOn: input.dependsOn ?? [],
  };
}

export function buildDataPlanTemplate(input: BuildDataPlanTemplateInput): DataPlan {
  const total = input.totalPoints ?? DEFAULT_TOTAL_POINTS;
  const limits = { ...input.limits };
  const groups: DataPlanGroup[] = [];

  if (input.template === '10-30-60') {
    const points = distributePoints(total, [0.1, 0.3, 0.6]);
    groups.push(
      group({
        id: 'sub1',
        name: '边界与样例',
        points: points[0],
        count: 2,
        seedStart: 1,
        args: ['--n=1', '--max-v=10'],
      }),
      group({
        id: 'sub2',
        name: '小数据',
        points: points[1],
        count: 6,
        seedStart: 101,
        args: ['--n=1000', '--max-v=100000'],
      }),
      group({
        id: 'sub3',
        name: '大数据',
        points: points[2],
        count: 12,
        seedStart: 201,
        args: ['--n=100000', '--max-v=1000000000'],
      }),
    );
  } else if (input.template === 'subtask-ladder') {
    const points = distributePoints(total, [0.3, 0.3, 0.4]);
    groups.push(
      group({
        id: 'sub1',
        name: '基础',
        points: points[0],
        count: 5,
        seedStart: 1,
        args: ['--n=10'],
      }),
      group({
        id: 'sub2',
        name: '中等',
        points: points[1],
        count: 5,
        seedStart: 101,
        args: ['--n=1000'],
        dependsOn: ['sub1'],
      }),
      group({
        id: 'sub3',
        name: '大型',
        points: points[2],
        count: 5,
        seedStart: 201,
        args: ['--n=100000'],
        dependsOn: ['sub2'],
      }),
    );
  } else if (input.template === 'extreme-random') {
    const points = distributePoints(total, [0.2, 0.3, 0.1, 0.4]);
    groups.push(
      group({
        id: 'sub1',
        name: '最小值',
        points: points[0],
        count: 1,
        seedStart: 1,
        args: ['--n=1'],
      }),
      group({
        id: 'sub2',
        name: '最大值',
        points: points[1],
        count: 1,
        seedStart: 101,
        args: ['--n=100000', '--max-v=1000000000'],
      }),
      group({
        id: 'sub3',
        name: '随机',
        points: points[2],
        count: 6,
        seedStart: 201,
        args: ['--n=1000'],
      }),
      group({
        id: 'sub4',
        name: '特殊构造',
        points: points[3],
        count: 2,
        seedStart: 301,
        args: ['--n=100000', '--mode=chain'],
      }),
    );
  } else {
    groups.push(
      group({
        id: 'sub1',
        name: '全部测试点',
        points: total,
        count: 10,
        seedStart: 1,
        args: ['--n=1000'],
      }),
    );
  }

  return {
    schema: DATA_PLAN_SCHEMA,
    limits,
    groups,
    pointsMode: 'group',
    naming: '{group}-{index}',
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run apps/server/tests/data-plan.test.ts`

Expected: PASS（全部用例通过）。

- [ ] **Step 6: Type-check the server package**

Run: `npx tsc -p apps/server/tsconfig.json --noEmit`

Expected: 无输出、退出码 0。

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/authoring/data-plan.ts apps/server/src/authoring/data-plan-templates.ts apps/server/tests/data-plan.test.ts
git commit -m "feat(authoring): add data plan parser, validator and templates"
```

---

### Task 2: Independent background generation job

**Files:**
- Create: `apps/server/src/storage/authoring-migrate.ts`
- Create: `apps/server/src/storage/repos/generation-jobs.ts`
- Create: `apps/server/src/authoring/generator-contract.ts`
- Create: `apps/server/src/authoring/generation-job.ts`
- Test: `apps/server/tests/generation-job.test.ts`

**Interfaces:**
- Consumes: `DataPlan`, `expandDataPlan`, `caseFileName`, `parseDataPlan` from Task 1.
- Produces:
  - `migrateAuthoring(db: DatabaseSync): void`
  - `createGenerationJob(db, input): number`
  - `getGenerationJob(db, id): GenerationJobRow | null`
  - `listGenerationJobs(db, problemId, limit?): GenerationJobRow[]`
  - `getActiveGenerationJob(db, problemId): GenerationJobRow | null`
  - `listGenerationCases(db, jobId): GenerationCaseRow[]`
  - `getGenerationCase(db, jobId, caseId): GenerationCaseRow | null`
  - `updateGenerationJob(db, id, patch): void`
  - `updateGenerationCase(db, id, patch): void`
  - `requestGenerationCancel(db, jobId, now): boolean`
  - `blockGenerationCases(db, jobId, message, now): void`
  - `reconcileInterruptedJobs(db, now?, staleMs?): number`
  - `runContractGenerator(input: ContractGeneratorInput): Promise<ContractGeneratorResult>`
  - `interface GenerationRuntime`
  - `createDefaultGenerationRuntime(input): GenerationRuntime`
  - `startGenerationJob(input: StartGenerationOptions): { id: number; total: number }`
  - `runGenerationJob(input: RunGenerationJobOptions): Promise<GenerationJobRow>`
  - `cancelGenerationJob(db, jobId): boolean`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/generation-job.test.ts`:

```ts
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_PLAN_SCHEMA, type DataPlan } from '../src/authoring/data-plan.js';
import {
  cancelGenerationJob,
  runGenerationJob,
  startGenerationJob,
  type GenerationRuntime,
} from '../src/authoring/generation-job.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { upsertAsset } from '../src/storage/repos/assets.js';
import { createProblem } from '../src/storage/repos/problems.js';
import {
  getGenerationJob,
  listGenerationCases,
  updateGenerationJob,
} from '../src/storage/repos/generation-jobs.js';
import { migrateAuthoring } from '../src/storage/authoring-migrate.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'oij-generation-'));
  dirs.push(dir);
  ensureDataDirs(dir);
  const db = openDatabase(join(dir, 'test.db'));
  migrate(db);
  migrateAuthoring(db);
  const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: dir }), dataDir: dir };
  const problemId = createProblem(db, {
    title: 'Generation',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 128,
    testcases: [],
  });
  return { dir, db, config, problemId };
}

function addAsset(
  ctx: ReturnType<typeof setup>,
  kind: 'std' | 'generator' | 'validator',
) {
  const relativeDir = `problems/${ctx.problemId}/src/${kind}`;
  mkdirSync(join(ctx.config.dataDir, relativeDir), { recursive: true });
  writeFileSync(join(ctx.config.dataDir, relativeDir, `${kind}.cpp`), 'int main(){return 0;}');
  upsertAsset(ctx.db, {
    problemId: ctx.problemId,
    kind,
    name: `${kind}.cpp`,
    path: `${relativeDir}/${kind}.cpp`,
    language: 'cpp17',
    sha256: `${kind}-hash`,
    size: 20,
  });
}

function basePlan(): DataPlan {
  return {
    schema: DATA_PLAN_SCHEMA,
    limits: { timeMs: 1000, memoryMb: 128, outputMb: 64 },
    groups: [
      {
        id: 'sub1',
        name: '基础',
        points: 40,
        count: 2,
        seedStart: 10,
        args: ['--n=10'],
        dependsOn: [],
      },
      {
        id: 'sub2',
        name: '大',
        points: 60,
        count: 2,
        seedStart: 100,
        args: ['--n=1000'],
        dependsOn: ['sub1'],
      },
    ],
    pointsMode: 'group',
    naming: '{group}-{index}',
  };
}

function fakeRuntime(options: {
  failGeneratorSeed?: number;
  failStdSeed?: number;
} = {}): GenerationRuntime {
  return {
    async compile() {
      return { ok: true, exe: 'fake.exe', message: '' };
    },
    async generate(input) {
      if (input.seed === options.failGeneratorSeed) {
        return { ok: false, stdout: '', stderr: 'boom', message: 'generator boom' };
      }
      return {
        ok: true,
        stdout: `${input.groupId} ${input.index} ${input.seed}\n1 2 3\n`,
        stderr: '',
        message: 'ok',
      };
    },
    async runStd(input) {
      if (readFileSync(input.inputPath, 'utf8').includes(String(options.failStdSeed))) {
        return {
          ok: false,
          exitCode: 1,
          cpuMs: 5,
          peakMemKb: 1024,
          timedOut: false,
          message: 'std failed',
        };
      }
      const inputText = readFileSync(input.inputPath, 'utf8');
      writeFileSync(input.outputPath, `out:${inputText.trim()}\n`);
      return {
        ok: true,
        exitCode: 0,
        cpuMs: 12,
        peakMemKb: 2048,
        timedOut: false,
        message: 'ok',
      };
    },
    async validate() {
      return { ok: true, message: 'ok' };
    },
  };
}

describe('independent generation jobs', () => {
  it('generates one case per group item with one-based seeds and stats', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    addAsset(ctx, 'validator');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    expect(started.total).toBe(4);

    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime(),
      now: () => 2000,
    });

    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('finished');
    expect(job.completed).toBe(4);
    expect(job.failed).toBe(0);
    const cases = listGenerationCases(ctx.db, started.id);
    expect(cases.map((row) => [row.group_id, row.case_index, row.seed])).toEqual([
      ['sub1', 1, 10],
      ['sub1', 2, 11],
      ['sub2', 1, 100],
      ['sub2', 2, 101],
    ]);
    expect(cases.every((row) => row.status === 'finished')).toBe(true);
    expect(cases[0].input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cases[0].std_time_ms).toBe(12);
    expect(job.stats_json).toContain('maxTimeMs');
  });

  it('keeps going after a generator failure and reports the failure point', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime({ failGeneratorSeed: 11 }),
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime({ failGeneratorSeed: 11 }),
      now: () => 2000,
    });

    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('failed');
    expect(job.failed).toBe(1);
    expect(job.completed).toBe(3);
    const failed = listGenerationCases(ctx.db, started.id).filter(
      (row) => row.status === 'failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].group_id).toBe('sub1');
    expect(failed[0].case_index).toBe(2);
    expect(failed[0].message).toContain('generator boom');
  });

  it('marks cases failed when std fails and still records paths', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime({ failStdSeed: 10 }),
      now: () => 2000,
    });

    const failed = listGenerationCases(ctx.db, started.id).filter(
      (row) => row.status === 'failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].seed).toBe(10);
    expect(failed[0].input_path).toContain('sub1-1.in');
    expect(failed[0].message).toContain('std failed');
  });

  it('skips validator when no validator asset exists', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime(),
      now: () => 2000,
    });
    const cases = listGenerationCases(ctx.db, started.id);
    expect(cases.every((row) => row.validator_ok === null)).toBe(true);
    expect(cases.every((row) => row.validator_message === '')).toBe(true);
  });

  it('cancels a queued job before any case starts', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    expect(cancelGenerationJob(ctx.db, started.id)).toBe(true);
    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('canceled');
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: fakeRuntime(),
      now: () => 2000,
    });
    expect(getGenerationJob(ctx.db, started.id)?.status).toBe('canceled');
    expect(
      listGenerationCases(ctx.db, started.id).every((row) => row.status === 'canceled'),
    ).toBe(true);
  });

  it('fails the job and blocks cases when compilation fails', async () => {
    const ctx = setup();
    addAsset(ctx, 'generator');
    addAsset(ctx, 'std');
    const broken: GenerationRuntime = {
      ...fakeRuntime(),
      async compile(kind) {
        return kind === 'std'
          ? { ok: false, message: 'std compile error' }
          : { ok: true, exe: 'fake.exe', message: '' };
      },
    };
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: broken,
      now: () => 1000,
      schedule: () => undefined,
    });
    await runGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      jobId: started.id,
      runtime: broken,
      now: () => 2000,
    });
    const job = getGenerationJob(ctx.db, started.id)!;
    expect(job.status).toBe('failed');
    expect(job.message).toContain('std compile error');
    expect(listGenerationCases(ctx.db, started.id).every((row) => row.status === 'blocked')).toBe(
      true,
    );
  });

  it('reconciles a stale running job on startup', async () => {
    const ctx = setup();
    const started = startGenerationJob({
      db: ctx.db,
      config: ctx.config,
      problemId: ctx.problemId,
      plan: basePlan(),
      planVersion: 1,
      runtime: fakeRuntime(),
      now: () => 1000,
      schedule: () => undefined,
    });
    updateGenerationJob(ctx.db, started.id, { status: 'running', heartbeatAt: 1000 });
    const { reconcileInterruptedJobs } = await import(
      '../src/storage/repos/generation-jobs.js'
    );
    const count = reconcileInterruptedJobs(ctx.db, 100_000, 60_000);
    expect(count).toBe(1);
    expect(getGenerationJob(ctx.db, started.id)?.status).toBe('failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/server/tests/generation-job.test.ts`

Expected: FAIL，报错 `Cannot find module '../src/authoring/generation-job.js'`。

- [ ] **Step 3: Implement `apps/server/src/storage/authoring-migrate.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';

const AUTHORING_SCHEMA = `
CREATE TABLE IF NOT EXISTS problem_data_plans(
  id INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL UNIQUE,
  schema TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS data_generation_jobs(
  id INTEGER PRIMARY KEY,
  problem_id INTEGER NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  completed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  stats_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  heartbeat_at INTEGER,
  FOREIGN KEY(problem_id) REFERENCES problems(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_problem
  ON data_generation_jobs(problem_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_generation_jobs_active
  ON data_generation_jobs(problem_id, status);
CREATE TABLE IF NOT EXISTS data_generation_cases(
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL,
  problem_id INTEGER NOT NULL,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  case_index INTEGER NOT NULL,
  seed INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_path TEXT,
  output_path TEXT,
  input_sha256 TEXT,
  input_bytes INTEGER NOT NULL DEFAULT 0,
  input_lines INTEGER NOT NULL DEFAULT 0,
  input_utf8 INTEGER NOT NULL DEFAULT 1,
  output_bytes INTEGER NOT NULL DEFAULT 0,
  output_lines INTEGER NOT NULL DEFAULT 0,
  std_exit_code INTEGER,
  std_time_ms INTEGER NOT NULL DEFAULT 0,
  std_memory_kb INTEGER NOT NULL DEFAULT 0,
  validator_ok INTEGER,
  validator_message TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  started_at INTEGER,
  finished_at INTEGER,
  UNIQUE(job_id, group_id, case_index),
  FOREIGN KEY(job_id) REFERENCES data_generation_jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_generation_cases_job
  ON data_generation_cases(job_id, id);
`;

/** Idempotently creates the authoring tables; does not touch schema_migrations. */
export function migrateAuthoring(db: DatabaseSync): void {
  db.exec(AUTHORING_SCHEMA);
}
```

- [ ] **Step 4: Implement `apps/server/src/storage/repos/generation-jobs.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../db.js';

export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'finished'
  | 'failed'
  | 'canceled';

export type GenerationCaseStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'failed'
  | 'blocked'
  | 'canceled';

export interface GenerationJobRow {
  id: number;
  problem_id: number;
  plan_version: number;
  plan_json: string;
  status: GenerationJobStatus;
  completed: number;
  failed: number;
  total: number;
  message: string;
  stats_json: string;
  created_by: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  heartbeat_at: number | null;
}

export interface GenerationCaseRow {
  id: number;
  job_id: number;
  problem_id: number;
  group_id: string;
  group_name: string;
  case_index: number;
  seed: number;
  status: GenerationCaseStatus;
  input_path: string | null;
  output_path: string | null;
  input_sha256: string | null;
  input_bytes: number;
  input_lines: number;
  input_utf8: number;
  output_bytes: number;
  output_lines: number;
  std_exit_code: number | null;
  std_time_ms: number;
  std_memory_kb: number;
  validator_ok: number | null;
  validator_message: string;
  message: string;
  started_at: number | null;
  finished_at: number | null;
}

export interface CreateGenerationCaseInput {
  groupId: string;
  groupName: string;
  index: number;
  seed: number;
}

export interface CreateGenerationJobInput {
  problemId: number;
  planVersion: number;
  planJson: string;
  cases: readonly CreateGenerationCaseInput[];
  createdBy?: number | null;
  now: number;
}

export interface GenerationJobPatch {
  status?: GenerationJobStatus;
  completed?: number;
  failed?: number;
  total?: number;
  message?: string;
  statsJson?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
  heartbeatAt?: number | null;
}

export interface GenerationCasePatch {
  status?: GenerationCaseStatus;
  inputPath?: string | null;
  outputPath?: string | null;
  inputSha256?: string | null;
  inputBytes?: number;
  inputLines?: number;
  inputUtf8?: number;
  outputBytes?: number;
  outputLines?: number;
  stdExitCode?: number | null;
  stdTimeMs?: number;
  stdMemoryKb?: number;
  validatorOk?: number | null;
  validatorMessage?: string;
  message?: string;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export function createGenerationJob(
  db: DatabaseSync,
  input: CreateGenerationJobInput,
): number {
  return transaction(db, () => {
    const result = db
      .prepare(
        `INSERT INTO data_generation_jobs(
           problem_id, plan_version, plan_json, status, total, created_by,
           created_at, heartbeat_at
         ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
      )
      .run(
        input.problemId,
        input.planVersion,
        input.planJson,
        input.cases.length,
        input.createdBy ?? null,
        input.now,
        input.now,
      );
    const jobId = Number(result.lastInsertRowid);
    const insertCase = db.prepare(
      `INSERT INTO data_generation_cases(
         job_id, problem_id, group_id, group_name, case_index, seed, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    for (const item of input.cases) {
      insertCase.run(
        jobId,
        input.problemId,
        item.groupId,
        item.groupName,
        item.index,
        item.seed,
      );
    }
    return jobId;
  });
}

export function getGenerationJob(db: DatabaseSync, id: number): GenerationJobRow | null {
  return (
    (db.prepare('SELECT * FROM data_generation_jobs WHERE id = ?').get(id) as unknown as
      | GenerationJobRow
      | undefined) ?? null
  );
}

export function listGenerationJobs(
  db: DatabaseSync,
  problemId: number,
  limit = 20,
): GenerationJobRow[] {
  return db
    .prepare(
      'SELECT * FROM data_generation_jobs WHERE problem_id = ? ORDER BY id DESC LIMIT ?',
    )
    .all(problemId, limit) as unknown as GenerationJobRow[];
}

export function getActiveGenerationJob(
  db: DatabaseSync,
  problemId: number,
): GenerationJobRow | null {
  return (
    (db
      .prepare(
        `SELECT * FROM data_generation_jobs
         WHERE problem_id = ? AND status IN ('queued', 'running')
         ORDER BY id DESC LIMIT 1`,
      )
      .get(problemId) as unknown as GenerationJobRow | undefined) ?? null
  );
}

export function listGenerationCases(
  db: DatabaseSync,
  jobId: number,
): GenerationCaseRow[] {
  return db
    .prepare('SELECT * FROM data_generation_cases WHERE job_id = ? ORDER BY id')
    .all(jobId) as unknown as GenerationCaseRow[];
}

export function getGenerationCase(
  db: DatabaseSync,
  jobId: number,
  caseId: number,
): GenerationCaseRow | null {
  return (
    (db
      .prepare(
        'SELECT * FROM data_generation_cases WHERE job_id = ? AND id = ?',
      )
      .get(jobId, caseId) as unknown as GenerationCaseRow | undefined) ?? null
  );
}

export function updateGenerationJob(
  db: DatabaseSync,
  id: number,
  patch: GenerationJobPatch,
): void {
  const columns: Record<keyof GenerationJobPatch, string> = {
    status: 'status',
    completed: 'completed',
    failed: 'failed',
    total: 'total',
    message: 'message',
    statsJson: 'stats_json',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    heartbeatAt: 'heartbeat_at',
  };
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const key of Object.keys(patch) as Array<keyof GenerationJobPatch>) {
    if (patch[key] === undefined) continue;
    sets.push(`${columns[key]} = ?`);
    values.push(patch[key] as string | number | null);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE data_generation_jobs SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
    id,
  );
}

export function updateGenerationCase(
  db: DatabaseSync,
  id: number,
  patch: GenerationCasePatch,
): void {
  const columns: Record<keyof GenerationCasePatch, string> = {
    status: 'status',
    inputPath: 'input_path',
    outputPath: 'output_path',
    inputSha256: 'input_sha256',
    inputBytes: 'input_bytes',
    inputLines: 'input_lines',
    inputUtf8: 'input_utf8',
    outputBytes: 'output_bytes',
    outputLines: 'output_lines',
    stdExitCode: 'std_exit_code',
    stdTimeMs: 'std_time_ms',
    stdMemoryKb: 'std_memory_kb',
    validatorOk: 'validator_ok',
    validatorMessage: 'validator_message',
    message: 'message',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
  };
  const sets: string[] = [];
  const values: Array<string | number | null> = [];
  for (const key of Object.keys(patch) as Array<keyof GenerationCasePatch>) {
    if (patch[key] === undefined) continue;
    sets.push(`${columns[key]} = ?`);
    values.push(patch[key] as string | number | null);
  }
  if (sets.length === 0) return;
  db.prepare(`UPDATE data_generation_cases SET ${sets.join(', ')} WHERE id = ?`).run(
    ...values,
    id,
  );
}

export function blockGenerationCases(
  db: DatabaseSync,
  jobId: number,
  message: string,
  now: number,
): void {
  db.prepare(
    `UPDATE data_generation_cases
     SET status = 'blocked', message = ?, finished_at = ?
     WHERE job_id = ? AND status IN ('pending', 'running')`,
  ).run(message, now, jobId);
}

export function requestGenerationCancel(
  db: DatabaseSync,
  jobId: number,
  now: number,
): boolean {
  const result = db
    .prepare(
      `UPDATE data_generation_jobs
       SET status = 'canceled', finished_at = ?, heartbeat_at = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(now, now, jobId);
  if (Number(result.changes) === 0) return false;
  db.prepare(
    `UPDATE data_generation_cases
     SET status = 'canceled', finished_at = ?
     WHERE job_id = ? AND status IN ('pending', 'running')`,
  ).run(now, jobId);
  return true;
}

export function reconcileInterruptedJobs(
  db: DatabaseSync,
  now = Date.now(),
  staleMs = 60_000,
): number {
  const staleBefore = now - staleMs;
  const rows = db
    .prepare(
      `SELECT id FROM data_generation_jobs
       WHERE status IN ('queued', 'running')
         AND created_at < ?
         AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
    )
    .all(staleBefore, staleBefore) as unknown as Array<{ id: number }>;
  for (const row of rows) {
    db.prepare(
      `UPDATE data_generation_jobs
       SET status = 'failed', message = ?, finished_at = ?, heartbeat_at = ?
       WHERE id = ?`,
    ).run('进程重启，生成任务中断', now, now, row.id);
    db.prepare(
      `UPDATE data_generation_cases
       SET status = 'blocked', message = ?, finished_at = ?
       WHERE job_id = ? AND status IN ('pending', 'running')`,
    ).run('进程重启，生成任务中断', now, row.id);
  }
  return rows.length;
}
```

- [ ] **Step 5: Implement `apps/server/src/authoring/generator-contract.ts`**

```ts
import { spawn } from 'node:child_process';

export interface ContractGeneratorInput {
  generator: string;
  seed: number;
  groupId: string;
  index: number;
  args: readonly string[];
  workdir: string;
  timeMs?: number;
  maxStdoutBytes?: number;
}

export interface ContractGeneratorResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
  bytes: number;
  timedOut: boolean;
  overflow: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_STDOUT = 64 * 1024 * 1024;

/** testlib 契约：--seed、--group、--index，其余参数按 argv 原样追加。 */
export function buildGeneratorArgs(
  input: Pick<ContractGeneratorInput, 'seed' | 'groupId' | 'index' | 'args'>,
): string[] {
  return [
    `--seed=${input.seed}`,
    `--group=${input.groupId}`,
    `--index=${input.index}`,
    ...input.args,
  ];
}

export function runContractGenerator(
  input: ContractGeneratorInput,
): Promise<ContractGeneratorResult> {
  const timeoutMs = input.timeMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  return new Promise<ContractGeneratorResult>((resolve) => {
    const chunks: Buffer[] = [];
    let stderr = '';
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;

    const finish = (result: ContractGeneratorResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(input.generator, buildGeneratorArgs(input), {
      cwd: input.workdir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > maxStdoutBytes) {
        overflow = true;
        child.kill();
        return;
      }
      chunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.once('error', (error) => {
      finish({
        ok: false,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr,
        message: error.message,
        bytes,
        timedOut,
        overflow,
      });
    });

    child.once('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8');
      if (timedOut) {
        finish({
          ok: false,
          stdout,
          stderr,
          message: `generator timed out after ${timeoutMs}ms`,
          bytes,
          timedOut,
          overflow,
        });
        return;
      }
      if (overflow) {
        finish({
          ok: false,
          stdout: '',
          stderr,
          message: `generator stdout exceeded ${maxStdoutBytes} bytes`,
          bytes,
          timedOut,
          overflow,
        });
        return;
      }
      if (code === 0) {
        finish({ ok: true, stdout, stderr, message: 'ok', bytes, timedOut, overflow });
        return;
      }
      finish({
        ok: false,
        stdout,
        stderr,
        message: `generator exited with code ${code ?? -1}${
          stderr ? `: ${stderr.trim()}` : ''
        }`,
        bytes,
        timedOut,
        overflow,
      });
    });
  });
}
```

- [ ] **Step 6: Implement `apps/server/src/authoring/generation-job.ts`**

```ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getAsset } from '../storage/repos/assets.js';
import { ensureCompiledProgram } from '../judge/compile-cache.js';
import { runSandboxed } from '../judge/runner.js';
import { runValidator } from '../judge/validator.js';
import {
  caseFileName,
  expandDataPlan,
  parseDataPlan,
  validateDataPlan,
  type DataPlan,
} from './data-plan.js';
import {
  runContractGenerator,
  type ContractGeneratorInput,
  type ContractGeneratorResult,
} from './generator-contract.js';
import {
  blockGenerationCases,
  createGenerationJob,
  getGenerationJob,
  listGenerationCases,
  requestGenerationCancel,
  updateGenerationCase,
  updateGenerationJob,
  type GenerationCaseRow,
  type GenerationJobRow,
} from '../storage/repos/generation-jobs.js';

export type GenerationAssetKind = 'generator' | 'std' | 'validator';

export interface CompileOutcome {
  ok: boolean;
  exe?: string;
  message: string;
}

export interface StdRunInput {
  exe: string;
  inputPath: string;
  outputPath: string;
  workdir: string;
  timeMs: number;
  memoryMb: number;
  wallMs: number;
  outputLimitBytes: number;
}

export interface StdOutcome {
  ok: boolean;
  exitCode: number;
  cpuMs: number;
  peakMemKb: number;
  timedOut: boolean;
  message: string;
}

export interface ValidatorOutcome {
  ok: boolean;
  message: string;
}

export interface GenerationRuntime {
  compile(kind: GenerationAssetKind): Promise<CompileOutcome>;
  generate(input: ContractGeneratorInput): Promise<ContractGeneratorResult>;
  runStd(input: StdRunInput): Promise<StdOutcome>;
  validate(input: {
    exe: string;
    inputPath: string;
    workdir: string;
    timeMs?: number;
  }): Promise<ValidatorOutcome>;
}

export interface DefaultRuntimeOptions {
  db: DatabaseSync;
  config: Config;
  problemId: number;
  includeDir?: string;
}

export function createDefaultGenerationRuntime(
  options: DefaultRuntimeOptions,
): GenerationRuntime {
  const includeDir = options.includeDir ?? join(process.cwd(), 'vendor');
  return {
    async compile(kind) {
      const asset = getAsset(options.db, options.problemId, kind);
      if (!asset || !asset.language) {
        return { ok: false, message: `missing compiled ${kind} source` };
      }
      const result = await ensureCompiledProgram({
        gxx: options.config.gxx,
        dataDir: options.config.dataDir,
        sourcePath: join(options.config.dataDir, asset.path),
        language: asset.language,
        includeDir,
        timeoutMs: 60_000,
      });
      return { ok: result.ok, exe: result.exe, message: result.message };
    },
    generate: (input) => runContractGenerator(input),
    async runStd(input) {
      const stderrFile = join(input.workdir, 'std.stderr.txt');
      try {
        const run = await runSandboxed({
          runner: options.config.runnerPath,
          exe: input.exe,
          workdir: input.workdir,
          timeMs: input.timeMs,
          wallMs: input.wallMs,
          memoryMb: input.memoryMb,
          processLimit: 1,
          stdinFile: input.inputPath,
          stdoutFile: input.outputPath,
          stderrFile,
        });
        const ok =
          run.exitCode === 0 &&
          !run.timedOut &&
          !run.oom &&
          run.stdoutBytes <= input.outputLimitBytes;
        const reason = run.oom
          ? 'std 超出内存限制'
          : run.timedOut
            ? 'std 超时'
            : run.exitCode !== 0
              ? `std 退出码 ${run.exitCode}`
              : run.stdoutBytes > input.outputLimitBytes
                ? 'std 输出超过限制'
                : 'ok';
        return {
          ok,
          exitCode: run.exitCode,
          cpuMs: run.cpuMs,
          peakMemKb: run.peakMemKb,
          timedOut: run.timedOut || run.oom,
          message: reason,
        };
      } catch (error) {
        return {
          ok: false,
          exitCode: -1,
          cpuMs: 0,
          peakMemKb: 0,
          timedOut: false,
          message: (error as Error).message,
        };
      }
    },
    async validate(input) {
      const result = await runValidator({
        validator: input.exe,
        input: input.inputPath,
        workdir: input.workdir,
        timeMs: input.timeMs,
      });
      return { ok: result.ok, message: result.message };
    },
  };
}

export interface StartGenerationOptions {
  db: DatabaseSync;
  config: Config;
  problemId: number;
  plan: DataPlan;
  planVersion: number;
  createdBy?: number | null;
  runtime?: GenerationRuntime;
  now?: () => number;
  schedule?: (task: () => void) => void;
}

export interface StartGenerationResult {
  id: number;
  total: number;
}

export interface RunGenerationJobOptions {
  db: DatabaseSync;
  config: Config;
  problemId: number;
  jobId: number;
  runtime?: GenerationRuntime;
  now?: () => number;
  maxWallMs?: number;
  includeDir?: string;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function relativeDataPath(dataDir: string, absolute: string): string {
  return relative(dataDir, absolute).replace(/\\/g, '/');
}

function jobWorkdir(dataDir: string, problemId: number, jobId: number): string {
  return join(dataDir, 'problems', String(problemId), 'authoring', 'jobs', String(jobId));
}

function summarizeCases(cases: readonly GenerationCaseRow[]) {
  const hashes = new Map<string, number>();
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  let totalDiskBytes = 0;
  for (const row of cases) {
    maxTimeMs = Math.max(maxTimeMs, row.std_time_ms);
    maxMemoryKb = Math.max(maxMemoryKb, row.std_memory_kb);
    totalDiskBytes += row.input_bytes + row.output_bytes;
    if (row.input_sha256) {
      hashes.set(row.input_sha256, (hashes.get(row.input_sha256) ?? 0) + 1);
    }
  }
  const duplicateInputCount = [...hashes.values()].filter((count) => count > 1).reduce(
    (sum, count) => sum + count,
    0,
  );
  return {
    totalCases: cases.length,
    maxTimeMs,
    maxMemoryKb,
    totalDiskBytes,
    duplicateInputCount,
    duplicateRate: cases.length === 0 ? 0 : duplicateInputCount / cases.length,
  };
}

function failJob(
  db: DatabaseSync,
  jobId: number,
  message: string,
  now: number,
): GenerationJobRow {
  blockGenerationCases(db, jobId, message, now);
  updateGenerationJob(db, jobId, {
    status: 'failed',
    message,
    finishedAt: now,
    heartbeatAt: now,
  });
  return getGenerationJob(db, jobId)!;
}

function failCase(
  db: DatabaseSync,
  caseId: number,
  message: string,
  now: number,
  extra: Parameters<typeof updateGenerationCase>[2] = {},
): void {
  updateGenerationCase(db, caseId, {
    status: 'failed',
    message,
    finishedAt: now,
    ...extra,
  });
}

export function startGenerationJob(
  options: StartGenerationOptions,
): StartGenerationResult {
  const validated = validateDataPlan(options.plan, { totalPoints: 100 });
  if (!validated.ok || !validated.plan) {
    const message = validated.issues
      .filter((entry) => entry.severity === 'error')
      .map((entry) => entry.message)
      .join('; ');
    throw new Error(message || 'invalid data plan');
  }
  const plan = validated.plan;
  const expanded = expandDataPlan(plan);
  const now = options.now ?? Date.now;
  const jobId = createGenerationJob(options.db, {
    problemId: options.problemId,
    planVersion: options.planVersion,
    planJson: JSON.stringify(plan),
    cases: expanded.map((item) => ({
      groupId: item.groupId,
      groupName: item.groupName,
      index: item.index,
      seed: item.seed,
    })),
    createdBy: options.createdBy ?? null,
    now: now(),
  });
  const runtime =
    options.runtime ??
    createDefaultGenerationRuntime({
      db: options.db,
      config: options.config,
      problemId: options.problemId,
    });
  const schedule = options.schedule ?? ((task: () => void) => setImmediate(task));
  schedule(() => {
    void runGenerationJob({
      db: options.db,
      config: options.config,
      problemId: options.problemId,
      jobId,
      runtime,
      now,
    }).catch((error) => {
      failJob(options.db, jobId, (error as Error).message, now());
    });
  });
  return { id: jobId, total: expanded.length };
}

export async function runGenerationJob(
  options: RunGenerationJobOptions,
): Promise<GenerationJobRow> {
  const { db, problemId, jobId } = options;
  const now = options.now ?? Date.now;
  const existing = getGenerationJob(db, jobId);
  if (!existing || existing.problem_id !== problemId) {
    throw new Error(`generation job ${jobId} not found`);
  }
  if (existing.status !== 'queued' && existing.status !== 'running') {
    return existing;
  }

  updateGenerationJob(db, jobId, {
    status: 'running',
    startedAt: existing.started_at ?? now(),
    message: '编译 generator / std / validator',
    heartbeatAt: now(),
  });

  const parsed = parseDataPlan(existing.plan_json, { totalPoints: 100 });
  if (!parsed.ok || !parsed.plan) {
    return failJob(db, jobId, '数据计划无效', now());
  }
  const plan = parsed.plan;
  const runtime =
    options.runtime ??
    createDefaultGenerationRuntime({
      db,
      config: options.config,
      problemId,
      includeDir: options.includeDir,
    });

  let generatorExe: string;
  let stdExe: string;
  let validatorExe: string | null = null;
  try {
    const generator = await runtime.compile('generator');
    if (!generator.ok || !generator.exe) {
      return failJob(db, jobId, `generator 编译失败：${generator.message}`, now());
    }
    generatorExe = generator.exe;

    const std = await runtime.compile('std');
    if (!std.ok || !std.exe) {
      return failJob(db, jobId, `std 编译失败：${std.message}`, now());
    }
    stdExe = std.exe;

    if (getAsset(db, problemId, 'validator')) {
      const validator = await runtime.compile('validator');
      if (!validator.ok || !validator.exe) {
        return failJob(
          db,
          jobId,
          `validator 编译失败：${validator.message}`,
          now(),
        );
      }
      validatorExe = validator.exe;
    }
  } catch (error) {
    return failJob(db, jobId, `编译阶段异常：${(error as Error).message}`, now());
  }

  const workdir = jobWorkdir(options.config.dataDir, problemId, jobId);
  mkdirSync(workdir, { recursive: true });
  const outputLimitBytes = plan.limits.outputMb * 1024 * 1024;
  const maxWallMs = options.maxWallMs ?? 30 * 60 * 1000;
  const startedAt = now();
  const groupById = new Map(plan.groups.map((group) => [group.id, group]));
  const cases = listGenerationCases(db, jobId);

  for (const row of cases) {
    const latest = getGenerationJob(db, jobId);
    if (latest?.status === 'canceled') {
      return latest;
    }
    if (now() - startedAt > maxWallMs) {
      return failJob(db, jobId, '生成总时长超过预算', now());
    }

    updateGenerationCase(db, row.id, { status: 'running', startedAt: now() });
    updateGenerationJob(db, jobId, {
      heartbeatAt: now(),
      message: `生成 ${row.group_id}-${row.case_index}（seed ${row.seed}）`,
    });

    const fileName = caseFileName(plan, row.group_id, row.case_index);
    const inputPath = join(workdir, fileName);
    const outputPath = join(workdir, fileName.replace(/\.in$/, '.out'));
    const inputRel = relativeDataPath(options.config.dataDir, inputPath);
    const outputRel = relativeDataPath(options.config.dataDir, outputPath);
    const group = groupById.get(row.group_id);

    let generated: ContractGeneratorResult;
    try {
      generated = await runtime.generate({
        generator: generatorExe,
        seed: row.seed,
        groupId: row.group_id,
        index: row.case_index,
        args: group?.args ?? [],
        workdir,
        timeMs: 10_000,
        maxStdoutBytes: outputLimitBytes,
      });
    } catch (error) {
      failCase(db, row.id, `generator 异常：${(error as Error).message}`, now());
      continue;
    }
    if (!generated.ok) {
      failCase(db, row.id, `generator 失败：${generated.message}`, now());
      continue;
    }

    const inputBuffer = Buffer.from(generated.stdout, 'utf8');
    if (inputBuffer.length === 0) {
      failCase(db, row.id, 'generator 输出为空', now());
      continue;
    }
    if (inputBuffer.length > outputLimitBytes) {
      failCase(
        db,
        row.id,
        `generator 输出超过限制 ${plan.limits.outputMb} MB`,
        now(),
      );
      continue;
    }
    writeFileSync(inputPath, inputBuffer);
    const inputSha256 = createHash('sha256').update(inputBuffer).digest('hex');
    const inputStats = {
      inputPath: inputRel,
      inputSha256,
      inputBytes: inputBuffer.length,
      inputLines: countLines(generated.stdout),
      inputUtf8: isUtf8(inputBuffer) ? 1 : 0,
    };

    let stdRun: StdOutcome;
    try {
      stdRun = await runtime.runStd({
        exe: stdExe,
        inputPath,
        outputPath,
        workdir,
        timeMs: plan.limits.timeMs,
        memoryMb: plan.limits.memoryMb,
        wallMs: plan.limits.timeMs + 3000,
        outputLimitBytes,
      });
    } catch (error) {
      failCase(
        db,
        row.id,
        `std 异常：${(error as Error).message}`,
        now(),
        inputStats,
      );
      continue;
    }
    if (!stdRun.ok) {
      failCase(db, row.id, `std 失败：${stdRun.message}`, now(), {
        ...inputStats,
        outputPath: outputRel,
        stdExitCode: stdRun.exitCode,
        stdTimeMs: stdRun.cpuMs,
        stdMemoryKb: stdRun.peakMemKb,
      });
      continue;
    }

    const outputText = readFileSync(outputPath, 'utf8');
    let validatorOk: number | null = null;
    let validatorMessage = '';
    if (validatorExe) {
      try {
        const validator = await runtime.validate({
          exe: validatorExe,
          inputPath,
          workdir,
          timeMs: 10_000,
        });
        validatorOk = validator.ok ? 1 : 0;
        validatorMessage = validator.message;
        if (!validator.ok) {
          failCase(db, row.id, `validator 失败：${validator.message}`, now(), {
            ...inputStats,
            outputPath: outputRel,
            outputBytes: Buffer.byteLength(outputText),
            outputLines: countLines(outputText),
            stdExitCode: stdRun.exitCode,
            stdTimeMs: stdRun.cpuMs,
            stdMemoryKb: stdRun.peakMemKb,
            validatorOk,
            validatorMessage,
          });
          continue;
        }
      } catch (error) {
        failCase(
          db,
          row.id,
          `validator 异常：${(error as Error).message}`,
          now(),
          inputStats,
        );
        continue;
      }
    }

    updateGenerationCase(db, row.id, {
      status: 'finished',
      ...inputStats,
      outputPath: outputRel,
      outputBytes: Buffer.byteLength(outputText),
      outputLines: countLines(outputText),
      stdExitCode: stdRun.exitCode,
      stdTimeMs: stdRun.cpuMs,
      stdMemoryKb: stdRun.peakMemKb,
      validatorOk,
      validatorMessage,
      message: '',
      finishedAt: now(),
    });
  }

  const refreshed = listGenerationCases(db, jobId);
  const failed = refreshed.filter(
    (row) => row.status === 'failed' || row.status === 'blocked',
  ).length;
  const completed = refreshed.filter((row) => row.status === 'finished').length;
  const stats = summarizeCases(refreshed);
  updateGenerationJob(db, jobId, {
    status: failed > 0 ? 'failed' : 'finished',
    completed,
    failed,
    statsJson: JSON.stringify(stats),
    message: failed > 0 ? `${failed} 个测试点失败` : '生成完成',
    finishedAt: now(),
    heartbeatAt: now(),
  });
  return getGenerationJob(db, jobId)!;
}

export function cancelGenerationJob(db: DatabaseSync, jobId: number): boolean {
  return requestGenerationCancel(db, jobId, Date.now());
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run apps/server/tests/generation-job.test.ts`

Expected: PASS（7 个用例通过）。

- [ ] **Step 8: Type-check the server package**

Run: `npx tsc -p apps/server/tsconfig.json --noEmit`

Expected: 无输出、退出码 0。

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/storage/authoring-migrate.ts apps/server/src/storage/repos/generation-jobs.ts apps/server/src/authoring/generator-contract.ts apps/server/src/authoring/generation-job.ts apps/server/tests/generation-job.test.ts
git commit -m "feat(authoring): run generation jobs outside the judge queue"
```

---

### Task 3: Data Plan and generation HTTP APIs

**Files:**
- Create: `apps/server/src/storage/repos/data-plans.ts`
- Create: `apps/server/src/http/admin-authoring.ts`
- Modify: `apps/server/src/app.ts`（仅 import 与注册两处）
- Test: `apps/server/tests/admin-authoring.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseDataPlan`, `validateDataPlan`, `buildDataPlanTemplate`, `DATA_PLAN_TEMPLATES`；Task 2 `startGenerationJob`, `cancelGenerationJob`, repos。
- Produces HTTP API（下表中的 `:id` 为 problemId）：
  - `GET /api/admin/problems/:id/data-plan`
  - `PUT /api/admin/problems/:id/data-plan` body `{ plan: unknown }`
  - `POST /api/admin/problems/:id/data-plan/validate` body `{ plan: unknown }`
  - `POST /api/admin/problems/:id/data-plan/template` body `{ template, outputMb? }`
  - `POST /api/admin/problems/:id/generation-jobs` body `{ plan?: unknown }`
  - `GET /api/admin/problems/:id/generation-jobs`
  - `GET /api/admin/problems/:id/generation-jobs/:jobId`
  - `POST /api/admin/problems/:id/generation-jobs/:jobId/cancel`
  - `GET /api/admin/problems/:id/generation-jobs/:jobId/cases/:caseId/preview?lines=100`
- Produces option type `AdminAuthoringRouteOptions` with injectable `startGeneration`.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/admin-authoring.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATA_PLAN_SCHEMA, type DataPlan } from '../src/authoring/data-plan.js';
import type { StartGenerationOptions } from '../src/authoring/generation-job.js';
import { registerAdminAuthoringRoutes } from '../src/http/admin-authoring.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { createProblem, getProblem } from '../src/storage/repos/problems.js';
import { migrateAuthoring } from '../src/storage/authoring-migrate.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';
import {
  createGenerationJob,
  finishGenerationCase,
  getGenerationJob,
  listGenerationCases,
  updateGenerationJob,
} from '../src/storage/repos/generation-jobs.js';

const root = mkdtempSync(join(tmpdir(), 'oij-authoring-api-'));
const db = openDatabase(join(root, 'test.db'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
let app: ReturnType<typeof Fastify>;
let problemId = 0;
let lastStart: StartGenerationOptions | null = null;

function plan(): DataPlan {
  return {
    schema: DATA_PLAN_SCHEMA,
    limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
    groups: [
      {
        id: 'sub1',
        name: '基础',
        points: 100,
        count: 2,
        seedStart: 1,
        args: ['--n=10'],
        dependsOn: [],
      },
    ],
    pointsMode: 'group',
    naming: '{group}-{index}',
  };
}

beforeAll(async () => {
  ensureDataDirs(root);
  migrate(db);
  migrateAuthoring(db);
  problemId = createProblem(db, {
    title: 'API',
    type: 'standard',
    timeMs: 1000,
    memoryMb: 256,
    testcases: [],
  });
  app = Fastify();
  registerAdminAuthoringRoutes(app, {
    db,
    config,
    adminGuard: async () => undefined,
    startGeneration: (input) => {
      lastStart = input;
      return { id: 77, total: 2 };
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('data plan APIs', () => {
  it('returns an empty plan before the first save', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/data-plan`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: { plan: null, version: 0, updatedAt: null },
    });
  });

  it('saves and reads a valid plan', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/problems/${problemId}/data-plan`,
      payload: { plan: plan() },
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json() as { data: { version: number } };
    expect(saved.data.version).toBe(1);

    const read = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/data-plan`,
    });
    const body = read.json() as { data: { plan: DataPlan; version: number } };
    expect(body.data.version).toBe(1);
    expect(body.data.plan.groups[0].count).toBe(2);
  });

  it('rejects an invalid plan with a 400', async () => {
    const invalid = plan();
    invalid.groups[0].points = 60;
    const response = await app.inject({
      method: 'PUT',
      url: `/api/admin/problems/${problemId}/data-plan`,
      payload: { plan: invalid },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      'INVALID_DATA_PLAN',
    );
  });

  it('validates a draft without saving', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/data-plan/validate`,
      payload: { plan: plan() },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: { valid: boolean; issues: unknown[]; totals: { testCount: number } };
    };
    expect(body.data.valid).toBe(true);
    expect(body.data.totals.testCount).toBe(2);
  });

  it('builds a template from problem limits', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/data-plan/template`,
      payload: { template: 'single-group' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: { plan: DataPlan } };
    expect(body.data.plan.groups[0].count).toBe(10);
    expect(body.data.plan.limits.timeMs).toBe(getProblem(db, problemId)?.time_ms);
  });
});

describe('generation job APIs', () => {
  it('starts a job through the injected starter', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/generation-jobs`,
      payload: { plan: plan() },
    });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({
      ok: true,
      data: { id: 77, status: 'queued', total: 2 },
    });
    expect(lastStart?.problemId).toBe(problemId);
    expect(lastStart?.plan.groups[0].count).toBe(2);
  });

  it('cancels a running job', async () => {
    const jobId = createGenerationJob(db, {
      problemId,
      planVersion: 1,
      planJson: JSON.stringify(plan()),
      cases: [
        { groupId: 'sub1', groupName: '基础', index: 1, seed: 1 },
        { groupId: 'sub1', groupName: '基础', index: 2, seed: 2 },
      ],
      now: Date.now(),
    });
    updateGenerationJob(db, jobId, {
      status: 'running',
      heartbeatAt: Date.now(),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/admin/problems/${problemId}/generation-jobs/${jobId}/cancel`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: { canceled: true, status: 'canceled' },
    });
    expect(getGenerationJob(db, jobId)?.status).toBe('canceled');
  });

  it('returns job detail and testcase preview', async () => {
    const jobId = createGenerationJob(db, {
      problemId,
      planVersion: 1,
      planJson: JSON.stringify(plan()),
      cases: [{ groupId: 'sub1', groupName: '基础', index: 1, seed: 1 }],
      now: Date.now(),
    });
    const caseId = listGenerationCases(db, jobId)[0].id;
    const relativeDir = `problems/${problemId}/authoring/jobs/${jobId}`;
    mkdirSync(join(config.dataDir, relativeDir), { recursive: true });
    writeFileSync(join(config.dataDir, relativeDir, 'sub1-1.in'), '1 2 3\n4 5 6\n');
    writeFileSync(join(config.dataDir, relativeDir, 'sub1-1.out'), '6\n15\n');
    finishGenerationCase(db, caseId, {
      status: 'finished',
      inputPath: `${relativeDir}/sub1-1.in`,
      outputPath: `${relativeDir}/sub1-1.out`,
      inputSha256: 'a'.repeat(64),
      inputBytes: 12,
      inputLines: 2,
      inputUtf8: 1,
      outputBytes: 6,
      outputLines: 2,
      stdExitCode: 0,
      stdTimeMs: 12,
      stdMemoryKb: 2048,
      validatorOk: 1,
      validatorMessage: 'ok',
      finishedAt: Date.now(),
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/generation-jobs/${jobId}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const body = detail.json() as {
      data: { id: number; cases: Array<{ id: number; status: string }> };
    };
    expect(body.data.id).toBe(jobId);
    expect(body.data.cases[0]).toMatchObject({ id: caseId, status: 'finished' });

    const preview = await app.inject({
      method: 'GET',
      url: `/api/admin/problems/${problemId}/generation-jobs/${jobId}/cases/${caseId}/preview?lines=1`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toMatchObject({
      ok: true,
      data: { input: '1 2 3', output: '6', inputTruncated: true, outputTruncated: false },
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/server/tests/admin-authoring.test.ts`

Expected: FAIL，报错 `Cannot find module '../src/http/admin-authoring.js'`。

- [ ] **Step 3: Implement `apps/server/src/storage/repos/data-plans.ts`**

```ts
import type { DatabaseSync } from 'node:sqlite';

export interface DataPlanRow {
  id: number;
  problem_id: number;
  schema: string;
  plan_json: string;
  version: number;
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export interface UpsertDataPlanInput {
  problemId: number;
  planJson: string;
  createdBy?: number | null;
  now?: number;
}

export function getDataPlanRow(
  db: DatabaseSync,
  problemId: number,
): DataPlanRow | null {
  return (
    (db
      .prepare('SELECT * FROM problem_data_plans WHERE problem_id = ?')
      .get(problemId) as unknown as DataPlanRow | undefined) ?? null
  );
}

export function upsertDataPlan(
  db: DatabaseSync,
  input: UpsertDataPlanInput,
): DataPlanRow {
  const now = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO problem_data_plans(
       problem_id, schema, plan_json, version, created_by, created_at, updated_at
     ) VALUES (?, 'oijudge.data-plan/1', ?, 1, ?, ?, ?)
     ON CONFLICT(problem_id) DO UPDATE SET
       plan_json = excluded.plan_json,
       version = problem_data_plans.version + 1,
       updated_at = excluded.updated_at`,
  ).run(input.problemId, input.planJson, input.createdBy ?? null, now, now);
  return getDataPlanRow(db, input.problemId)!;
}
```

- [ ] **Step 4: Implement `apps/server/src/http/admin-authoring.ts`**

```ts
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import {
  buildDataPlanTemplate,
  DATA_PLAN_TEMPLATES,
  type DataPlanTemplateId,
} from '../authoring/data-plan-templates.js';
import {
  parseDataPlan,
  type DataPlan,
  type DataPlanIssue,
} from '../authoring/data-plan.js';
import {
  cancelGenerationJob,
  startGenerationJob,
  type StartGenerationOptions,
} from '../authoring/generation-job.js';
import { migrateAuthoring } from '../storage/authoring-migrate.js';
import { getDataPlanRow, upsertDataPlan } from '../storage/repos/data-plans.js';
import {
  getActiveGenerationJob,
  getGenerationCase,
  getGenerationJob,
  listGenerationCases,
  listGenerationJobs,
  reconcileInterruptedJobs,
  type GenerationCaseRow,
  type GenerationJobRow,
} from '../storage/repos/generation-jobs.js';
import { getProblem } from '../storage/repos/problems.js';

export interface AdminAuthoringRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
  /** 测试注入点；生产默认使用 startGenerationJob。 */
  startGeneration?: (input: StartGenerationOptions) => { id: number; total: number };
}

interface PreviewResult {
  text: string;
  truncated: boolean;
}

function readPreview(path: string, maxLines: number): PreviewResult {
  const buffer = Buffer.alloc(256 * 1024);
  const fd = openSync(path, 'r');
  let bytes = 0;
  try {
    bytes = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const text = buffer.subarray(0, bytes).toString('utf8');
  const lines = text.split(/\r?\n/);
  const truncated = bytes === buffer.length || lines.length > maxLines;
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated,
  };
}

function toJobSummary(job: GenerationJobRow) {
  return {
    id: job.id,
    problemId: job.problem_id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    message: job.message,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

function toCaseDto(row: GenerationCaseRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    index: row.case_index,
    seed: row.seed,
    status: row.status,
    inputPath: row.input_path,
    outputPath: row.output_path,
    inputSha256: row.input_sha256,
    inputBytes: row.input_bytes,
    inputLines: row.input_lines,
    inputUtf8: row.input_utf8 === 1,
    outputBytes: row.output_bytes,
    outputLines: row.output_lines,
    stdExitCode: row.std_exit_code,
    stdTimeMs: row.std_time_ms,
    stdMemoryKb: row.std_memory_kb,
    validatorOk: row.validator_ok === null ? null : row.validator_ok === 1,
    validatorMessage: row.validator_message,
    message: row.message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function parsePlanBody(body: unknown, options = {}): {
  ok: boolean;
  plan: DataPlan | null;
  issues: DataPlanIssue[];
} {
  const value =
    typeof body === 'object' && body !== null && 'plan' in body
      ? (body as { plan?: unknown }).plan
      : body;
  const parsed = parseDataPlan(value, options);
  return { ok: parsed.ok, plan: parsed.plan, issues: parsed.issues };
}

export function registerAdminAuthoringRoutes(
  app: FastifyInstance,
  options: AdminAuthoringRouteOptions,
): void {
  migrateAuthoring(options.db);
  reconcileInterruptedJobs(options.db);
  const guard = options.adminGuard;
  const startGeneration = options.startGeneration ?? startGenerationJob;

  const requireProblem = (problemId: number) => getProblem(options.db, problemId);

  app.get<{ Params: { id: string } }>(
    '/api/admin/problems/:id/data-plan',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      if (!requireProblem(problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const row = getDataPlanRow(options.db, problemId);
      if (!row) {
        return {
          ok: true,
          data: { plan: null, version: 0, updatedAt: null },
        };
      }
      return {
        ok: true,
        data: {
          plan: JSON.parse(row.plan_json) as DataPlan,
          version: row.version,
          updatedAt: row.updated_at,
        },
      };
    },
  );

  app.put<{
    Params: { id: string };
    Body: { plan?: unknown };
  }>('/api/admin/problems/:id/data-plan', { preHandler: guard }, async (request, reply) => {
    const problemId = Number(request.params.id);
    if (!requireProblem(problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    const parsed = parsePlanBody(request.body, { totalPoints: 100 });
    if (!parsed.ok || !parsed.plan) {
      const message =
        parsed.issues.find((entry) => entry.severity === 'error')?.message ??
        'invalid data plan';
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_DATA_PLAN', message },
      });
    }
    const row = upsertDataPlan(options.db, {
      problemId,
      planJson: JSON.stringify(parsed.plan),
      createdBy: request.user?.id ?? null,
    });
    return {
      ok: true,
      data: { plan: parsed.plan, version: row.version },
    };
  });

  app.post<{
    Params: { id: string };
    Body: { plan?: unknown };
  }>(
    '/api/admin/problems/:id/data-plan/validate',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      if (!requireProblem(problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const parsed = parseDataPlan(
        typeof request.body === 'object' && request.body !== null
          ? request.body.plan
          : request.body,
        { totalPoints: 100 },
      );
      return {
        ok: true,
        data: { valid: parsed.ok, issues: parsed.issues, totals: parsed.totals },
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { template?: DataPlanTemplateId; outputMb?: number };
  }>(
    '/api/admin/problems/:id/data-plan/template',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const problem = requireProblem(problemId);
      if (!problem) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const template = request.body?.template;
      if (!DATA_PLAN_TEMPLATES.some((entry) => entry.id === template)) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'BAD_TEMPLATE', message: `unknown template: ${String(template)}` },
        });
      }
      const outputMb =
        typeof request.body?.outputMb === 'number' && request.body.outputMb > 0
          ? request.body.outputMb
          : 64;
      const plan = buildDataPlanTemplate({
        template: template as DataPlanTemplateId,
        limits: {
          timeMs: problem.time_ms,
          memoryMb: problem.memory_mb,
          outputMb,
        },
      });
      return { ok: true, data: { plan } };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { plan?: unknown };
  }>('/api/admin/problems/:id/generation-jobs', { preHandler: guard }, async (request, reply) => {
    const problemId = Number(request.params.id);
    if (!requireProblem(problemId)) {
      return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    }
    if (getActiveGenerationJob(options.db, problemId)) {
      return reply.code(409).send({
        ok: false,
        error: { code: 'JOB_ACTIVE', message: '已有生成任务在运行，请先等待或取消' },
      });
    }

    let plan: DataPlan;
    let planVersion = 0;
    if (request.body?.plan === undefined) {
      const row = getDataPlanRow(options.db, problemId);
      if (!row) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'NO_DATA_PLAN', message: '请先保存数据计划' },
        });
      }
      const parsed = parseDataPlan(row.plan_json, { totalPoints: 100 });
      if (!parsed.ok || !parsed.plan) {
        return reply.code(400).send({
          ok: false,
          error: { code: 'INVALID_DATA_PLAN', message: '已保存的数据计划无效' },
        });
      }
      plan = parsed.plan;
      planVersion = row.version;
    } else {
      const parsed = parsePlanBody(request.body, { totalPoints: 100 });
      if (!parsed.ok || !parsed.plan) {
        return reply.code(400).send({
          ok: false,
          error: {
            code: 'INVALID_DATA_PLAN',
            message:
              parsed.issues.find((entry) => entry.severity === 'error')?.message ??
              'invalid data plan',
          },
        });
      }
      plan = parsed.plan;
      planVersion = getDataPlanRow(options.db, problemId)?.version ?? 0;
    }

    let started: { id: number; total: number };
    try {
      started = startGeneration({
        db: options.db,
        config: options.config,
        problemId,
        plan,
        planVersion,
        createdBy: request.user?.id ?? null,
      });
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: { code: 'GENERATION_START_FAILED', message: (error as Error).message },
      });
    }
    return reply.code(202).send({
      ok: true,
      data: { id: started.id, status: 'queued', total: started.total },
    });
  });

  app.get<{ Params: { id: string } }>(
    '/api/admin/problems/:id/generation-jobs',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      if (!requireProblem(problemId)) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return {
        ok: true,
        data: listGenerationJobs(options.db, problemId, 20).map(toJobSummary),
      };
    },
  );

  app.get<{ Params: { id: string; jobId: string } }>(
    '/api/admin/problems/:id/generation-jobs/:jobId',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const job = getGenerationJob(options.db, Number(request.params.jobId));
      if (!job || job.problem_id !== problemId) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      return {
        ok: true,
        data: {
          ...toJobSummary(job),
          planVersion: job.plan_version,
          plan: JSON.parse(job.plan_json) as DataPlan,
          stats: JSON.parse(job.stats_json) as Record<string, number>,
          cases: listGenerationCases(options.db, job.id).map(toCaseDto),
        },
      };
    },
  );

  app.post<{ Params: { id: string; jobId: string } }>(
    '/api/admin/problems/:id/generation-jobs/:jobId/cancel',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const job = getGenerationJob(options.db, Number(request.params.jobId));
      if (!job || job.problem_id !== problemId) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const canceled = cancelGenerationJob(options.db, job.id);
      const current = getGenerationJob(options.db, job.id)!;
      return { ok: true, data: { canceled, status: current.status } };
    },
  );

  app.get<{
    Params: { id: string; jobId: string; caseId: string };
    Querystring: { lines?: string };
  }>(
    '/api/admin/problems/:id/generation-jobs/:jobId/cases/:caseId/preview',
    { preHandler: guard },
    async (request, reply) => {
      const problemId = Number(request.params.id);
      const job = getGenerationJob(options.db, Number(request.params.jobId));
      if (!job || job.problem_id !== problemId) {
        return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
      }
      const row = getGenerationCase(
        options.db,
        job.id,
        Number(request.params.caseId),
      );
      if (!row) {
        return reply.code(404).send({ ok: false, error: { code: 'CASE_NOT_FOUND' } });
      }
      if (!row.input_path || !row.output_path) {
        return reply.code(409).send({
          ok: false,
          error: { code: 'CASE_NOT_READY', message: '测试点文件尚未生成' },
        });
      }
      const requested = Number(request.query.lines ?? 100);
      const lines = Number.isFinite(requested)
        ? Math.max(1, Math.min(500, Math.floor(requested)))
        : 100;
      const input = readPreview(
        join(options.config.dataDir, row.input_path),
        lines,
      );
      const output = readPreview(
        join(options.config.dataDir, row.output_path),
        lines,
      );
      return {
        ok: true,
        data: {
          caseId: row.id,
          input: input.text,
          output: output.text,
          inputTruncated: input.truncated,
          outputTruncated: output.truncated,
          inputLines: row.input_lines,
          outputLines: row.output_lines,
          inputBytes: row.input_bytes,
          outputBytes: row.output_bytes,
        },
      };
    },
  );
}
```

- [ ] **Step 5: Register the routes in `apps/server/src/app.ts`**

At the import block, after `registerAdminToolRoutes`:

```ts
import { registerAdminAuthoringRoutes } from './http/admin-authoring.js';
```

Inside `buildApp`, after `registerAdminToolRoutes(...)` registration block:

```ts
  registerAdminAuthoringRoutes(app, {
    db,
    config,
    adminGuard: requireRole(['admin', 'setter'], { db, config }),
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run apps/server/tests/admin-authoring.test.ts`

Expected: PASS（8 个用例通过）。

- [ ] **Step 7: Run the existing admin/tools tests to catch regressions**

Run: `npx vitest run apps/server/tests/admin-tools.test.ts apps/server/tests/admin-problems.test.ts`

Expected: PASS（现有路由不受影响）。

- [ ] **Step 8: Type-check the server package**

Run: `npx tsc -p apps/server/tsconfig.json --noEmit`

Expected: 无输出、退出码 0。

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/storage/repos/data-plans.ts apps/server/src/http/admin-authoring.ts apps/server/src/app.ts apps/server/tests/admin-authoring.test.ts
git commit -m "feat(authoring): expose data plan and generation APIs"
```

---

### Task 4: Frontend Data Plan editor, progress and preview

**Files:**
- Create: `apps/web/src/components/data-plan-form.ts`
- Create: `apps/web/src/components/data-plan-form.test.ts`
- Create: `apps/web/src/components/AiPromptDrawer.tsx`
- Create: `apps/web/src/components/DataPlanPanel.tsx`
- Modify: `apps/web/src/api/types.ts`（末尾追加类型）
- Modify: `apps/web/src/pages/AdminProblemPage.tsx`
- Modify: `apps/web/src/styles/admin.css`（末尾追加样式）

**Interfaces:**
- Consumes: Task 3 HTTP API。
- Produces:
  - `interface PlanGroupDraft { id; name; points; count; seedStart; argsText; dependsOn }`
  - `toGroupDrafts(plan): PlanGroupDraft[]`
  - `fromGroupDrafts(base, drafts): DataPlan`
  - `sumDraftPoints(drafts): number`
  - `sumDraftCount(drafts): number`
  - `parsePlanJson(text): { ok: true; plan } | { ok: false; message }`
  - `DataPlanPanel({ problemId, problem })`
  - `AiPromptDrawer({ problem, plan })`
  - `buildAuthoringPrompt(kind, problem, plan): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/web/src/components/data-plan-form.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DataPlan } from '../api/types';
import {
  fromGroupDrafts,
  parsePlanJson,
  sumDraftCount,
  sumDraftPoints,
  toGroupDrafts,
} from './data-plan-form';

const base: DataPlan = {
  schema: 'oijudge.data-plan/1',
  limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
  groups: [
    {
      id: 'sub1',
      name: '基础',
      points: 40,
      count: 2,
      seedStart: 1,
      args: ['--n=10', '--m=20'],
      dependsOn: [],
    },
    {
      id: 'sub2',
      name: '大',
      points: 60,
      count: 3,
      seedStart: 100,
      args: ['--n=100000'],
      dependsOn: ['sub1'],
    },
  ],
  pointsMode: 'group',
  naming: '{group}-{index}',
};

describe('data plan form helpers', () => {
  it('round-trips args through the tag text field', () => {
    const drafts = toGroupDrafts(base);
    expect(drafts[0].argsText).toBe('--n=10 --m=20');
    const plan = fromGroupDrafts(base, drafts);
    expect(plan.groups[0].args).toEqual(['--n=10', '--m=20']);
    expect(plan).toMatchObject({
      schema: 'oijudge.data-plan/1',
      limits: base.limits,
      naming: '{group}-{index}',
    });
  });

  it('sums points and counts', () => {
    const drafts = toGroupDrafts(base);
    expect(sumDraftPoints(drafts)).toBe(100);
    expect(sumDraftCount(drafts)).toBe(5);
  });

  it('clamps invalid numbers when converting back', () => {
    const drafts = toGroupDrafts(base);
    drafts[0].points = -10;
    drafts[0].count = 0;
    drafts[0].seedStart = -3;
    const plan = fromGroupDrafts(base, drafts);
    expect(plan.groups[0]).toMatchObject({ points: 0, count: 1, seedStart: 0 });
  });

  it('parses valid JSON and reports invalid JSON', () => {
    const valid = parsePlanJson(JSON.stringify(base));
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.plan.groups).toHaveLength(2);

    const invalid = parsePlanJson('{oops');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.message).toContain('JSON');
  });

  it('rejects a JSON object without groups', () => {
    const result = parsePlanJson('{"schema":"oijudge.data-plan/1"}');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('groups');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/src/components/data-plan-form.test.ts`

Expected: FAIL，报错 `Cannot find module './data-plan-form'`。

- [ ] **Step 3: Implement `apps/web/src/components/data-plan-form.ts`**

```ts
import type { DataPlan } from '../api/types';

export interface PlanGroupDraft {
  id: string;
  name: string;
  points: number;
  count: number;
  seedStart: number;
  /** 以空格分隔的 generator 参数；空串表示没有额外参数。 */
  argsText: string;
  dependsOn: string[];
}

export function toGroupDrafts(plan: DataPlan): PlanGroupDraft[] {
  return plan.groups.map((group) => ({
    id: group.id,
    name: group.name,
    points: group.points,
    count: group.count,
    seedStart: group.seedStart,
    argsText: group.args.join(' '),
    dependsOn: [...group.dependsOn],
  }));
}

export function fromGroupDrafts(
  base: DataPlan,
  drafts: readonly PlanGroupDraft[],
): DataPlan {
  return {
    ...base,
    groups: drafts.map((draft) => ({
      id: draft.id.trim(),
      name: draft.name.trim(),
      points: Math.max(0, Math.round(draft.points)),
      count: Math.max(1, Math.round(draft.count)),
      seedStart: Math.max(0, Math.round(draft.seedStart)),
      args: draft.argsText
        .split(/\s+/)
        .map((arg) => arg.trim())
        .filter((arg) => arg.length > 0),
      dependsOn: [...draft.dependsOn],
    })),
  };
}

export function sumDraftPoints(drafts: readonly PlanGroupDraft[]): number {
  return drafts.reduce((sum, draft) => sum + Math.max(0, Math.round(draft.points)), 0);
}

export function sumDraftCount(drafts: readonly PlanGroupDraft[]): number {
  return drafts.reduce((sum, draft) => sum + Math.max(1, Math.round(draft.count)), 0);
}

export type ParsedPlanJson =
  | { ok: true; plan: DataPlan }
  | { ok: false; message: string };

export function parsePlanJson(text: string): ParsedPlanJson {
  try {
    const value = JSON.parse(text) as DataPlan;
    if (!value || typeof value !== 'object' || !Array.isArray(value.groups)) {
      return {
        ok: false,
        message: 'JSON 必须是包含 groups 数组的数据计划对象',
      };
    }
    return { ok: true, plan: value };
  } catch (error) {
    return {
      ok: false,
      message: `JSON 解析失败：${(error as Error).message}`,
    };
  }
}
```

- [ ] **Step 4: Append the API types to `apps/web/src/api/types.ts`**

Append at the end of the file:

```ts
/** Phase Authoring：Data Plan 与生成任务。 */
export type DataPlanPointsMode = 'group' | 'per-test' | 'auto';

export interface DataPlanLimits {
  timeMs: number;
  memoryMb: number;
  outputMb: number;
}

export interface DataPlanGroup {
  id: string;
  name: string;
  points: number;
  count: number;
  seedStart: number;
  args: string[];
  dependsOn: string[];
}

export interface DataPlan {
  schema: 'oijudge.data-plan/1';
  limits: DataPlanLimits;
  groups: DataPlanGroup[];
  pointsMode: DataPlanPointsMode;
  naming: string;
}

export interface DataPlanIssue {
  path: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface DataPlanTotals {
  testCount: number;
  points: number;
  estimatedSeconds: number;
  estimatedBytes: number;
}

export interface DataPlanValidationResponse {
  valid: boolean;
  issues: DataPlanIssue[];
  totals: DataPlanTotals;
}

export type DataPlanTemplateId =
  | '10-30-60'
  | 'subtask-ladder'
  | 'extreme-random'
  | 'single-group';

export type GenerationJobStatus =
  | 'queued'
  | 'running'
  | 'finished'
  | 'failed'
  | 'canceled';

export type GenerationCaseStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'failed'
  | 'blocked'
  | 'canceled';

export interface GenerationJobCase {
  id: number;
  groupId: string;
  groupName: string;
  index: number;
  seed: number;
  status: GenerationCaseStatus;
  inputPath: string | null;
  outputPath: string | null;
  inputSha256: string | null;
  inputBytes: number;
  inputLines: number;
  inputUtf8: boolean;
  outputBytes: number;
  outputLines: number;
  stdExitCode: number | null;
  stdTimeMs: number;
  stdMemoryKb: number;
  validatorOk: boolean | null;
  validatorMessage: string;
  message: string;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GenerationJobSummary {
  id: number;
  problemId: number;
  status: GenerationJobStatus;
  total: number;
  completed: number;
  failed: number;
  message: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface GenerationJobDetail extends GenerationJobSummary {
  planVersion: number;
  plan: DataPlan;
  stats: {
    totalCases?: number;
    maxTimeMs?: number;
    maxMemoryKb?: number;
    totalDiskBytes?: number;
    duplicateInputCount?: number;
    duplicateRate?: number;
  };
  cases: GenerationJobCase[];
}

export interface GenerationJobPreview {
  caseId: number;
  input: string;
  output: string;
  inputTruncated: boolean;
  outputTruncated: boolean;
  inputLines: number;
  outputLines: number;
  inputBytes: number;
  outputBytes: number;
}
```

- [ ] **Step 5: Implement `apps/web/src/components/AiPromptDrawer.tsx`**

```tsx
import { useState } from 'react';
import { App, Alert, Button, Drawer, Input, Select, Space } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import type { DataPlan, ProblemDetail } from '../api/types';

type PromptKind = 'std' | 'generator' | 'validator';

const KIND_OPTIONS: Array<{ value: PromptKind; label: string }> = [
  { value: 'std', label: '标准程序 std' },
  { value: 'generator', label: '数据生成器 generator' },
  { value: 'validator', label: '输入校验器 validator' },
];

export function buildAuthoringPrompt(
  kind: PromptKind,
  problem: ProblemDetail,
  plan: DataPlan | null,
): string {
  const planText = plan
    ? JSON.stringify(
        {
          limits: plan.limits,
          groups: plan.groups.map((group) => ({
            id: group.id,
            name: group.name,
            points: group.points,
            count: group.count,
            args: group.args,
            dependsOn: group.dependsOn,
          })),
        },
        null,
        2,
      )
    : '（尚未配置 Data Plan）';
  const samples = problem.samples
    .map(
      (sample, index) =>
        `样例 ${index + 1}\n输入：\n${sample.input}\n输出：\n${sample.output}`,
    )
    .join('\n\n');

  const role =
    kind === 'std'
      ? '你是一名 OI 出题人，请写一份标准程序（std）。'
      : kind === 'generator'
        ? '你是一名 OI 出题人，请写一份 testlib 数据生成器（generator）。'
        : '你是一名 OI 出题人，请写一份 testlib 输入校验器（validator）。';

  const contract =
    kind === 'generator'
      ? `必须满足：
- C++17，包含 testlib.h，调用 registerGen(argc, argv, 1)
- 支持 --seed=<int>、--group=<string>、--index=<int>
- 只使用 rnd，禁止 rand()/random_device/time()/chrono
- 只写 stdout，不写文件、不联网、不调用系统命令
- 同一 seed 必须产生完全相同的输出`
      : kind === 'std'
        ? `必须满足：
- C++17，从标准输入读、向标准输出写
- 不读写文件、不联网、不调用系统命令
- 不使用随机数、时间、未定义行为
- 使用 long long 或 __int128 防溢出
- 运行时间与内存尽量不超过限制的 50%`
        : `必须满足：
- C++17，包含 testlib.h，调用 registerValidation(argc, argv)
- 从标准输入读取数据并检查题面中的全部约束
- 失败时用 ensuref/quitf 给出可定位的错误信息
- 不写文件、不联网、不调用系统命令`;

  return `${role}

## 题目信息
标题：${problem.title}
题型：${problem.type}
时间限制：${problem.timeMs} ms
内存限制：${problem.memoryMb} MB
输入/输出模式：${problem.ioMode === 'file' ? `${problem.inputFile ?? 'input'} / ${problem.outputFile ?? 'output'} 文件` : '标准输入/标准输出'}

## 数据计划
${planText}

## 样例
${samples || '（题面暂无样例）'}

## 硬性契约
${contract}

## 输出格式
只输出一个 C++17 代码块，不要输出解释、测试代码或 Markdown 之外的文字。

## 自检清单
- [ ] 代码可以编译
- [ ] 样例通过
- [ ] 没有文件 IO / 网络 / system / popen
- [ ] 没有未定义行为
- [ ] 复杂度与限制匹配
- [ ] 已覆盖题面中的边界与子任务`;
}

export function AiPromptDrawer({
  problem,
  plan,
}: {
  problem: ProblemDetail;
  plan: DataPlan | null;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PromptKind>('generator');
  const prompt = buildAuthoringPrompt(kind, problem, plan);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      message.success('提示词已复制');
    } catch {
      message.error('复制失败，请手动选择文本');
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>AI 提示词</Button>
      <Drawer
        title="AI 提示词（仅复制，不调用外部 API）"
        open={open}
        onClose={() => setOpen(false)}
        width={760}
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Select<PromptKind>
            value={kind}
            onChange={setKind}
            options={KIND_OPTIONS}
            style={{ width: 260 }}
          />
          <Alert
            type="info"
            showIcon
            message="离线优先"
            description="这里只生成可复制的提示词。代码粘回资产编辑器后，必须编译、试跑、审核，不能自动发布。"
          />
          <Input.TextArea value={prompt} readOnly rows={20} className="mono" />
          <Button type="primary" icon={<CopyOutlined />} onClick={() => void copy()}>
            复制提示词
          </Button>
        </Space>
      </Drawer>
    </>
  );
}
```

- [ ] **Step 6: Implement `apps/web/src/components/DataPlanPanel.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  EyeOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '../api/client';
import type {
  DataPlan,
  DataPlanIssue,
  DataPlanTemplateId,
  GenerationJobCase,
  GenerationJobDetail,
  GenerationJobPreview,
  ProblemDetail,
} from '../api/types';
import { formatBytes } from '../utils/format';
import { AiPromptDrawer } from './AiPromptDrawer';
import {
  fromGroupDrafts,
  parsePlanJson,
  sumDraftCount,
  sumDraftPoints,
  toGroupDrafts,
  type PlanGroupDraft,
} from './data-plan-form';

const TEMPLATE_OPTIONS: Array<{ value: DataPlanTemplateId; label: string }> = [
  { value: '10-30-60', label: '10/30/60（常规题）' },
  { value: 'subtask-ladder', label: '子任务阶梯（部分分）' },
  { value: 'extreme-random', label: '极限 + 随机（构造题）' },
  { value: 'single-group', label: '只有一组（简单题）' },
];

const STATUS_COLOR: Record<string, string> = {
  queued: 'blue',
  running: 'processing',
  finished: 'green',
  failed: 'red',
  canceled: 'default',
  pending: 'default',
  blocked: 'orange',
};

function newGroupDraft(index: number, seedStart: number): PlanGroupDraft {
  return {
    id: `sub${index}`,
    name: `子任务 ${index}`,
    points: 0,
    count: 1,
    seedStart,
    argsText: '',
    dependsOn: [],
  };
}

export function DataPlanPanel({
  problemId,
  problem,
}: {
  problemId: number;
  problem: ProblemDetail;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [basePlan, setBasePlan] = useState<DataPlan | null>(null);
  const [drafts, setDrafts] = useState<PlanGroupDraft[]>([]);
  const [jsonText, setJsonText] = useState('');
  const [issues, setIssues] = useState<DataPlanIssue[]>([]);
  const [template, setTemplate] = useState<DataPlanTemplateId>('10-30-60');
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [preview, setPreview] = useState<
    (GenerationJobPreview & { title: string }) | null
  >(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const planQuery = useQuery({
    queryKey: ['data-plan', problemId],
    queryFn: () =>
      apiGet<{ plan: DataPlan | null; version: number; updatedAt: number | null }>(
        `/api/admin/problems/${problemId}/data-plan`,
      ),
  });

  useEffect(() => {
    const plan = planQuery.data?.plan;
    if (!plan) return;
    setBasePlan(plan);
    setDrafts(toGroupDrafts(plan));
    setJsonText(JSON.stringify(plan, null, 2));
  }, [planQuery.data]);

  const jobQuery = useQuery<GenerationJobDetail>({
    queryKey: ['generation-job', problemId, jobId],
    queryFn: () =>
      apiGet<GenerationJobDetail>(
        `/api/admin/problems/${problemId}/generation-jobs/${jobId!}`,
      ),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 1500 : false;
    },
  });
  const job = jobQuery.data ?? null;

  const draftPlan = useMemo(
    () => (basePlan ? fromGroupDrafts(basePlan, drafts) : null),
    [basePlan, drafts],
  );
  const points = sumDraftPoints(drafts);
  const count = sumDraftCount(drafts);

  const updateDraft = (index: number, patch: Partial<PlanGroupDraft>) => {
    setDrafts((previous) =>
      previous.map((draft, position) =>
        position === index ? { ...draft, ...patch } : draft,
      ),
    );
  };

  const removeDraft = (index: number) => {
    setDrafts((previous) => previous.filter((_, position) => position !== index));
  };

  const applyTemplate = async () => {
    try {
      const result = await apiPost<{ plan: DataPlan }>(
        `/api/admin/problems/${problemId}/data-plan/template`,
        { template },
      );
      setBasePlan(result.plan);
      setDrafts(toGroupDrafts(result.plan));
      setJsonText(JSON.stringify(result.plan, null, 2));
      setIssues([]);
      message.success('已生成模板，请确认分值与参数后保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '模板生成失败');
    }
  };

  const validate = async () => {
    if (!draftPlan) return;
    setValidating(true);
    try {
      const result = await apiPost<{
        valid: boolean;
        issues: DataPlanIssue[];
      }>(`/api/admin/problems/${problemId}/data-plan/validate`, {
        plan: draftPlan,
      });
      setIssues(result.issues);
      if (result.valid) message.success('数据计划通过校验');
      else message.warning('数据计划存在问题');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '校验失败');
    } finally {
      setValidating(false);
    }
  };

  const save = async () => {
    if (!draftPlan) return;
    setSaving(true);
    try {
      const saved = await apiPut<{ plan: DataPlan; version: number }>(
        `/api/admin/problems/${problemId}/data-plan`,
        { plan: draftPlan },
      );
      setBasePlan(saved.plan);
      setDrafts(toGroupDrafts(saved.plan));
      setJsonText(JSON.stringify(saved.plan, null, 2));
      setIssues([]);
      message.success(`数据计划已保存（v${saved.version}）`);
      void queryClient.invalidateQueries({ queryKey: ['data-plan', problemId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    if (!draftPlan) return;
    setStarting(true);
    try {
      const result = await apiPost<{ id: number; total: number }>(
        `/api/admin/problems/${problemId}/generation-jobs`,
        { plan: draftPlan },
      );
      setJobId(result.id);
      message.success(`已启动生成任务 #${result.id}，共 ${result.total} 个测试点`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '启动生成失败');
    } finally {
      setStarting(false);
    }
  };

  const cancelJob = async () => {
    if (!job) return;
    try {
      await apiPost(
        `/api/admin/problems/${problemId}/generation-jobs/${job.id}/cancel`,
      );
      message.success('已请求取消，当前测试点结束后生效');
      void jobQuery.refetch();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '取消失败');
    }
  };

  const openPreview = async (row: GenerationJobCase) => {
    if (!job) return;
    setPreviewLoading(true);
    try {
      const data = await apiGet<GenerationJobPreview>(
        `/api/admin/problems/${problemId}/generation-jobs/${job.id}/cases/${row.id}/preview?lines=100`,
      );
      setPreview({ ...data, title: `${row.groupId}-${row.index}` });
      setPreviewOpen(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  const applyJson = () => {
    const parsed = parsePlanJson(jsonText);
    if (!parsed.ok) {
      message.error(parsed.message);
      return;
    }
    setBasePlan(parsed.plan);
    setDrafts(toGroupDrafts(parsed.plan));
    setIssues([]);
    message.success('JSON 已应用到表单');
  };

  const groupColumns: TableColumnsType<PlanGroupDraft> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 110,
      render: (value: string, _row, index) => (
        <Input
          value={value}
          onChange={(event) => updateDraft(index, { id: event.target.value })}
        />
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 150,
      render: (value: string, _row, index) => (
        <Input
          value={value}
          onChange={(event) => updateDraft(index, { name: event.target.value })}
        />
      ),
    },
    {
      title: '测试点数',
      dataIndex: 'count',
      width: 110,
      render: (value: number, _row, index) => (
        <InputNumber
          min={1}
          max={100}
          precision={0}
          value={value}
          onChange={(next) =>
            updateDraft(index, { count: typeof next === 'number' ? next : 1 })
          }
        />
      ),
    },
    {
      title: '分值',
      dataIndex: 'points',
      width: 100,
      render: (value: number, _row, index) => (
        <InputNumber
          min={0}
          precision={0}
          value={value}
          onChange={(next) =>
            updateDraft(index, { points: typeof next === 'number' ? next : 0 })
          }
        />
      ),
    },
    {
      title: 'seed 起始',
      dataIndex: 'seedStart',
      width: 120,
      render: (value: number, _row, index) => (
        <InputNumber
          min={0}
          precision={0}
          value={value}
          onChange={(next) =>
            updateDraft(index, { seedStart: typeof next === 'number' ? next : 0 })
          }
        />
      ),
    },
    {
      title: 'generator 参数',
      dataIndex: 'argsText',
      render: (value: string, _row, index) => (
        <Select
          mode="tags"
          value={value.split(/\s+/).filter(Boolean)}
          onChange={(next: string[]) =>
            updateDraft(index, { argsText: next.join(' ') })
          }
          tokenSeparators={[' ']}
          placeholder="--n=10 --max-v=100"
          style={{ minWidth: 220 }}
        />
      ),
    },
    {
      title: '依赖',
      dataIndex: 'dependsOn',
      width: 180,
      render: (value: string[], row, index) => (
        <Select
          mode="multiple"
          value={value}
          onChange={(next: string[]) => updateDraft(index, { dependsOn: next })}
          options={drafts
            .filter((candidate) => candidate.id !== row.id)
            .map((candidate) => ({ value: candidate.id, label: candidate.id }))}
          placeholder="无"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: '',
      width: 70,
      render: (_value, _row, index) => (
        <Popconfirm
          title="删除这个子任务？"
          onConfirm={() => removeDraft(index)}
        >
          <Button danger size="small" type="text">
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const caseColumns: TableColumnsType<GenerationJobCase> = [
    { title: '子任务', dataIndex: 'groupId', width: 90 },
    { title: '#', dataIndex: 'index', width: 50 },
    {
      title: 'seed',
      dataIndex: 'seed',
      width: 80,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) => <Tag color={STATUS_COLOR[value]}>{value}</Tag>,
    },
    {
      title: '用时',
      dataIndex: 'stdTimeMs',
      width: 80,
      render: (value: number) => `${value} ms`,
    },
    {
      title: '内存',
      dataIndex: 'stdMemoryKb',
      width: 90,
      render: (value: number) => formatBytes(value * 1024),
    },
    {
      title: '输入',
      dataIndex: 'inputBytes',
      width: 90,
      render: (value: number) => formatBytes(value),
    },
    {
      title: '失败点',
      dataIndex: 'message',
      render: (value: string) =>
        value ? (
          <span className="mono data-plan-case-message">{value}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      title: '预览',
      width: 90,
      render: (_value, row) => (
        <Button
          size="small"
          icon={<EyeOutlined />}
          disabled={!row.inputPath}
          loading={previewLoading}
          onClick={() => void openPreview(row)}
        >
          查看
        </Button>
      ),
    },
  ];

  if (planQuery.isLoading) {
    return (
      <div className="inline-loading">
        <Spin />
      </div>
    );
  }

  if (planQuery.isError) {
    return <Alert type="error" showIcon message="加载数据计划失败" />;
  }

  return (
    <div className="data-plan-panel">
      <Card
        className="oij-card"
        title="数据计划"
        extra={
          <Space>
            <AiPromptDrawer problem={problem} plan={draftPlan} />
            <Button
              icon={<ReloadOutlined />}
              loading={validating}
              disabled={!draftPlan}
              onClick={() => void validate()}
            >
              校验
            </Button>
            <Button
              type="primary"
              loading={saving}
              disabled={!draftPlan}
              onClick={() => void save()}
            >
              保存计划
            </Button>
          </Space>
        }
      >
        <div className="data-plan-toolbar">
          <Space>
            <Select<DataPlanTemplateId>
              value={template}
              onChange={setTemplate}
              options={TEMPLATE_OPTIONS}
              style={{ width: 260 }}
            />
            <Button icon={<ThunderboltOutlined />} onClick={() => void applyTemplate()}>
              生成模板
            </Button>
          </Space>
          <span className="data-plan-summary">
            测试点 <strong>{count}</strong> 个 · 总分{' '}
            <strong className={points === 100 ? 'score-ok' : 'score-bad'}>
              {points}
            </strong>{' '}
            / 100
          </span>
        </div>

        {draftPlan ? (
          <>
            <Table<PlanGroupDraft>
              className="oij-table data-plan-groups"
              rowKey={(row) => `${row.id}-${row.seedStart}`}
              size="small"
              columns={groupColumns}
              dataSource={drafts}
              pagination={false}
              scroll={{ x: 1180 }}
            />
            <Button
              className="data-plan-add-group"
              icon={<PlusOutlined />}
              onClick={() =>
                setDrafts((previous) => [
                  ...previous,
                  newGroupDraft(
                    previous.length + 1,
                    previous.reduce(
                      (max, group) => Math.max(max, group.seedStart + group.count),
                      0,
                    ) + 1,
                  ),
                ])
              }
            >
              添加子任务
            </Button>
          </>
        ) : (
          <Empty description="还没有数据计划">
            <Button type="primary" onClick={() => void applyTemplate()}>
              从模板创建
            </Button>
          </Empty>
        )}

        <Collapse
          className="data-plan-json"
          items={[
            {
              key: 'json',
              label: '高级 JSON',
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input.TextArea
                    value={jsonText}
                    onChange={(event) => setJsonText(event.target.value)}
                    rows={12}
                    className="mono"
                  />
                  <Space>
                    <Button onClick={applyJson}>应用 JSON</Button>
                    <Button
                      disabled={!draftPlan}
                      onClick={() =>
                        setJsonText(JSON.stringify(draftPlan, null, 2))
                      }
                    >
                      从表单生成 JSON
                    </Button>
                  </Space>
                </Space>
              ),
            },
          ]}
        />

        {issues.length > 0 ? (
          <Alert
            className="data-plan-issues"
            type={issues.some((issue) => issue.severity === 'error') ? 'error' : 'warning'}
            showIcon
            message="数据计划校验结果"
            description={
              <ul>
                {issues.map((issue) => (
                  <li key={`${issue.path}-${issue.code}`}>
                    <span className="mono">{issue.path}</span>：{issue.message}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
      </Card>

      <Card
        className="oij-card data-plan-job-card"
        title="生成任务"
        extra={
          job ? (
            <Space>
              <Tag color={STATUS_COLOR[job.status]}>{job.status}</Tag>
              {job.status === 'queued' || job.status === 'running' ? (
                <Popconfirm title="取消当前生成任务？" onConfirm={() => void cancelJob()}>
                  <Button danger icon={<StopOutlined />}>
                    取消
                  </Button>
                </Popconfirm>
              ) : null}
            </Space>
          ) : null
        }
      >
        {!job ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Empty description="保存计划后启动生成" />
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={starting}
              disabled={!draftPlan}
              onClick={() => void start()}
            >
              启动生成
            </Button>
          </Space>
        ) : (
          <>
            <Descriptions
              size="small"
              column={4}
              items={[
                { key: 'id', label: '任务', children: `#${job.id}` },
                {
                  key: 'progress',
                  label: '进度',
                  children: `${job.completed} / ${job.total}`,
                },
                { key: 'failed', label: '失败', children: job.failed },
                { key: 'message', label: '状态', children: job.message || '—' },
              ]}
            />
            <Table<GenerationJobCase>
              className="oij-table data-plan-cases"
              rowKey="id"
              size="small"
              columns={caseColumns}
              dataSource={job.cases}
              pagination={false}
              scroll={{ x: 980, y: 360 }}
            />
          </>
        )}
      </Card>

      <Modal
        title={`测试点预览 · ${preview?.title ?? ''}`}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width={1000}
      >
        {preview ? (
          <Tabs
            items={[
              {
                key: 'input',
                label: `输入${preview.inputTruncated ? '（已截断）' : ''}`,
                children: <pre className="data-plan-preview">{preview.input}</pre>,
              },
              {
                key: 'output',
                label: `输出${preview.outputTruncated ? '（已截断）' : ''}`,
                children: <pre className="data-plan-preview">{preview.output}</pre>,
              },
            ]}
          />
        ) : null}
      </Modal>
    </div>
  );
}
```

- [ ] **Step 7: Wire the panel into `apps/web/src/pages/AdminProblemPage.tsx`**

At the import block, after `ObjectiveQuestionEditor` import:

```tsx
import { DataPlanPanel } from '../components/DataPlanPanel';
```

After `const toolsPanel = (` block ends（即 `const toolsPanel = (...);` 之后），add:

```tsx
  const dataPlanPanel = problem ? (
    <DataPlanPanel problemId={problemId} problem={problem} />
  ) : null;
```

In the `<Tabs>` non-objective `items` array, between “程序资产” and “测试数据”:

```tsx
                { key: 'plan', label: '数据计划', children: dataPlanPanel },
```

Final non-objective items should be:

```tsx
                { key: 'basic', label: '基本信息', children: basicPanel },
                { key: 'assets', label: '程序资产', children: assetsPanel },
                { key: 'plan', label: '数据计划', children: dataPlanPanel },
                { key: 'data', label: '测试数据', children: dataPanel },
                { key: 'tools', label: '生成与对拍', children: toolsPanel },
                { key: 'validation', label: '校验与自测', children: validationPanel },
```

- [ ] **Step 8: Append styles to `apps/web/src/styles/admin.css`**

```css
/* Phase Authoring：Data Plan */
.data-plan-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.data-plan-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
}

.data-plan-summary {
  color: var(--text-2);
  font-size: 12px;
}

.data-plan-summary .score-ok {
  color: var(--success, #52c41a);
}

.data-plan-summary .score-bad {
  color: var(--danger, #ff4d4f);
}

.data-plan-groups {
  margin-bottom: 10px;
}

.data-plan-add-group {
  margin-bottom: 12px;
}

.data-plan-json {
  margin-top: 8px;
}

.data-plan-issues {
  margin-top: 12px;
}

.data-plan-job-card {
  margin-top: 4px;
}

.data-plan-cases {
  margin-top: 12px;
}

.data-plan-case-message {
  display: inline-block;
  max-width: 380px;
  overflow: hidden;
  color: var(--danger, #ff4d4f);
  font-size: 12px;
  text-overflow: ellipsis;
  vertical-align: bottom;
  white-space: nowrap;
}

.data-plan-preview {
  max-height: 420px;
  margin: 0;
  padding: 12px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle, #fafafa);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
```

- [ ] **Step 9: Run the frontend helper tests**

Run: `npx vitest run apps/web/src/components/data-plan-form.test.ts`

Expected: PASS（5 个用例通过）。

- [ ] **Step 10: Type-check and build the web app**

Run: `npm run web:typecheck`

Expected: 无输出、退出码 0。

Run: `npm run web:build`

Expected: Vite build 成功，输出 `dist/`。

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/data-plan-form.ts apps/web/src/components/data-plan-form.test.ts apps/web/src/components/AiPromptDrawer.tsx apps/web/src/components/DataPlanPanel.tsx apps/web/src/api/types.ts apps/web/src/pages/AdminProblemPage.tsx apps/web/src/styles/admin.css
git commit -m "feat(authoring): add data plan editor, generation progress and preview UI"
```

---

### Task 5: Publish quality gates

**Files:**
- Create: `apps/server/src/authoring/quality-gates.ts`
- Test: `apps/server/tests/quality-gates.test.ts`

**Interfaces:**
- Consumes: `DataPlan`, `validateDataPlan` from Task 1；`GenerationCaseRow` from Task 2。
- Produces:
  - `type QualityGateName`
  - `interface GateFinding { gate; level: 'pass' | 'warn' | 'block'; message; detail? }`
  - `interface GateCaseSnapshot`
  - `interface QualityGateInput`
  - `interface QualityGateReport { pass; findings; stats }`
  - `evaluateQualityGates(input: QualityGateInput): QualityGateReport`
  - `toGateCaseSnapshot(row: GenerationCaseRow): GateCaseSnapshot`
- Later publish code calls `evaluateQualityGates(report)` and refuses publish when `report.pass === false`。

- [ ] **Step 1: Write the failing tests**

Create `apps/server/tests/quality-gates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DATA_PLAN_SCHEMA,
  type DataPlan,
} from '../src/authoring/data-plan.js';
import {
  evaluateQualityGates,
  type GateCaseSnapshot,
  type QualityGateInput,
} from '../src/authoring/quality-gates.js';

function plan(overrides: Partial<DataPlan> = {}): DataPlan {
  return {
    schema: DATA_PLAN_SCHEMA,
    limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
    groups: [
      {
        id: 'sub1',
        name: '基础',
        points: 50,
        count: 1,
        seedStart: 1,
        args: [],
        dependsOn: [],
      },
      {
        id: 'sub2',
        name: '大',
        points: 50,
        count: 2,
        seedStart: 101,
        args: [],
        dependsOn: [],
      },
    ],
    pointsMode: 'group',
    naming: '{group}-{index}',
    ...overrides,
  };
}

function gateCase(overrides: Partial<GateCaseSnapshot> = {}): GateCaseSnapshot {
  return {
    groupId: 'sub1',
    caseIndex: 1,
    seed: 1,
    inputSha256: 'a'.repeat(64),
    inputBytes: 12,
    inputLines: 2,
    inputUtf8Valid: true,
    outputBytes: 12,
    outputLines: 2,
    stdExitCode: 0,
    stdTimeMs: 100,
    stdMemoryKb: 1024,
    validatorOk: true,
    ...overrides,
  };
}

function cases(): GateCaseSnapshot[] {
  return [
    gateCase(),
    gateCase({ groupId: 'sub2', caseIndex: 1, seed: 101, inputSha256: 'b'.repeat(64) }),
    gateCase({ groupId: 'sub2', caseIndex: 2, seed: 102, inputSha256: 'c'.repeat(64) }),
  ];
}

function input(overrides: Partial<QualityGateInput> = {}): QualityGateInput {
  const rows = overrides.cases ?? cases();
  return {
    plan: plan(),
    cases: rows,
    compile: { generator: true, std: true, validator: true, checker: null },
    hasValidator: true,
    requiresValidator: true,
    samples: [
      {
        sampleIndex: 0,
        expectedOutput: '6\n',
        actualOutput: '6',
        exitCode: 0,
      },
    ],
    determinism: rows.map((row) => ({
      groupId: row.groupId,
      caseIndex: row.caseIndex,
      firstSha256: row.inputSha256 ?? '',
      secondSha256: row.inputSha256 ?? '',
    })),
    budget: {
      actualWallMs: 1000,
      maxWallMs: 60_000,
      actualDiskBytes: 1000,
      maxDiskBytes: 1024 * 1024 * 1024,
    },
    ...overrides,
  };
}

function blocked(report: ReturnType<typeof evaluateQualityGates>, gate: string): boolean {
  return report.findings.some(
    (finding) => finding.gate === gate && finding.level === 'block',
  );
}

describe('quality gates', () => {
  it('passes a complete report', () => {
    const report = evaluateQualityGates(input());
    expect(report.pass, JSON.stringify(report.findings)).toBe(true);
    expect(report.findings.some((finding) => finding.level === 'block')).toBe(false);
    expect(report.stats.totalCases).toBe(3);
  });

  it('blocks on a determinism mismatch', () => {
    const rows = cases();
    const report = evaluateQualityGates(
      input({
        determinism: rows.map((row, index) =>
          index === 0
            ? {
                groupId: row.groupId,
                caseIndex: row.caseIndex,
                firstSha256: 'a'.repeat(64),
                secondSha256: 'd'.repeat(64),
              }
            : {
                groupId: row.groupId,
                caseIndex: row.caseIndex,
                firstSha256: row.inputSha256 ?? '',
                secondSha256: row.inputSha256 ?? '',
              },
        ),
      }),
    );
    expect(blocked(report, 'determinism')).toBe(true);
  });

  it('blocks when std is over 80% of the time limit, warns between 50% and 80%', () => {
    const slow = evaluateQualityGates(
      input({
        cases: [gateCase({ stdTimeMs: 900 }), ...cases().slice(1)],
      }),
    );
    expect(blocked(slow, 'time-margin')).toBe(true);

    const warn = evaluateQualityGates(
      input({
        cases: [gateCase({ stdTimeMs: 600 }), ...cases().slice(1)],
      }),
    );
    expect(blocked(warn, 'time-margin')).toBe(false);
    expect(
      warn.findings.some(
        (finding) => finding.gate === 'time-margin' && finding.level === 'warn',
      ),
    ).toBe(true);
  });

  it('blocks when input hashes repeat more than 10%', () => {
    const rows = [
      gateCase({ inputSha256: 'x'.repeat(64) }),
      gateCase({
        groupId: 'sub2',
        caseIndex: 1,
        seed: 101,
        inputSha256: 'x'.repeat(64),
      }),
      gateCase({
        groupId: 'sub2',
        caseIndex: 2,
        seed: 102,
        inputSha256: 'y'.repeat(64),
      }),
    ];
    const report = evaluateQualityGates(input({ cases: rows }));
    expect(blocked(report, 'duplicates')).toBe(true);
  });

  it('blocks a CF-like/Hack problem without a validator, warns an ordinary problem', () => {
    const hack = evaluateQualityGates(
      input({
        hasValidator: false,
        requiresValidator: true,
        compile: { generator: true, std: true, validator: null, checker: null },
      }),
    );
    expect(blocked(hack, 'validator')).toBe(true);

    const ordinary = evaluateQualityGates(
      input({
        hasValidator: false,
        requiresValidator: false,
        compile: { generator: true, std: true, validator: null, checker: null },
      }),
    );
    expect(blocked(ordinary, 'validator')).toBe(false);
    expect(
      ordinary.findings.some(
        (finding) => finding.gate === 'validator' && finding.level === 'warn',
      ),
    ).toBe(true);
  });

  it('blocks an invalid subtask points/dependency plan', () => {
    const badPlan = plan();
    badPlan.groups[0].points = 40;
    const report = evaluateQualityGates(input({ plan: badPlan }));
    expect(blocked(report, 'subtasks')).toBe(true);
  });

  it('blocks a sample output mismatch', () => {
    const report = evaluateQualityGates(
      input({
        samples: [
          {
            sampleIndex: 0,
            expectedOutput: '6\n',
            actualOutput: '7\n',
            exitCode: 0,
          },
        ],
      }),
    );
    expect(blocked(report, 'samples')).toBe(true);
  });

  it('blocks empty input, missing validator results and budget overflow', () => {
    const empty = evaluateQualityGates(
      input({ cases: [gateCase({ inputBytes: 0, inputLines: 0 }), ...cases().slice(1)] }),
    );
    expect(blocked(empty, 'readability')).toBe(true);

    const validatorFail = evaluateQualityGates(
      input({
        cases: [gateCase({ validatorOk: false }), ...cases().slice(1)],
      }),
    );
    expect(blocked(validatorFail, 'validator')).toBe(true);

    const budget = evaluateQualityGates(
      input({
        budget: {
          actualWallMs: 60_001,
          maxWallMs: 60_000,
          actualDiskBytes: 1000,
          maxDiskBytes: 1024,
        },
      }),
    );
    expect(blocked(budget, 'budget')).toBe(true);
  });

  it('blocks when a group has no cases', () => {
    const report = evaluateQualityGates(
      input({ cases: [gateCase()] }),
    );
    expect(blocked(report, 'subtasks')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/server/tests/quality-gates.test.ts`

Expected: FAIL，报错 `Cannot find module '../src/authoring/quality-gates.js'`。

- [ ] **Step 3: Implement `apps/server/src/authoring/quality-gates.ts`**

```ts
import {
  DEFAULT_TOTAL_POINTS,
  validateDataPlan,
  type DataPlan,
} from './data-plan.js';
import type { GenerationCaseRow } from '../storage/repos/generation-jobs.js';

export type QualityGateName =
  | 'compile'
  | 'determinism'
  | 'readability'
  | 'size'
  | 'validator'
  | 'std'
  | 'time-margin'
  | 'memory-margin'
  | 'duplicates'
  | 'subtasks'
  | 'samples'
  | 'budget';

export type GateLevel = 'pass' | 'warn' | 'block';

export interface GateFinding {
  gate: QualityGateName;
  level: GateLevel;
  message: string;
  detail?: Record<string, unknown>;
}

export interface GateCaseSnapshot {
  groupId: string;
  caseIndex: number;
  seed: number;
  inputSha256: string | null;
  inputBytes: number;
  inputLines: number;
  inputUtf8Valid: boolean;
  outputBytes: number;
  outputLines: number;
  stdExitCode: number | null;
  stdTimeMs: number;
  stdMemoryKb: number;
  validatorOk: boolean | null;
}

export interface DeterminismCheck {
  groupId: string;
  caseIndex: number;
  firstSha256: string;
  secondSha256: string;
}

export interface GateSampleResult {
  sampleIndex: number;
  expectedOutput: string;
  actualOutput: string;
  exitCode: number;
}

export interface QualityGateInput {
  plan: DataPlan;
  cases: readonly GateCaseSnapshot[];
  compile: {
    generator: boolean;
    std: boolean;
    validator: boolean | null;
    checker: boolean | null;
  };
  hasValidator: boolean;
  requiresValidator: boolean;
  samples: readonly GateSampleResult[];
  determinism: readonly DeterminismCheck[];
  budget: {
    actualWallMs: number;
    maxWallMs: number;
    actualDiskBytes: number;
    maxDiskBytes: number;
  };
}

export interface QualityGateStats {
  totalCases: number;
  maxTimeMs: number;
  maxMemoryKb: number;
  duplicateInputCount: number;
  duplicateRate: number;
  totalDiskBytes: number;
}

export interface QualityGateReport {
  pass: boolean;
  findings: GateFinding[];
  stats: QualityGateStats;
}

function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function finding(
  gate: QualityGateName,
  level: GateLevel,
  message: string,
  detail?: Record<string, unknown>,
): GateFinding {
  return detail ? { gate, level, message, detail } : { gate, level, message };
}

function computeStats(cases: readonly GateCaseSnapshot[]): QualityGateStats {
  const hashes = new Map<string, number>();
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  let totalDiskBytes = 0;
  for (const row of cases) {
    maxTimeMs = Math.max(maxTimeMs, row.stdTimeMs);
    maxMemoryKb = Math.max(maxMemoryKb, row.stdMemoryKb);
    totalDiskBytes += row.inputBytes + row.outputBytes;
    if (row.inputSha256) {
      hashes.set(row.inputSha256, (hashes.get(row.inputSha256) ?? 0) + 1);
    }
  }
  const duplicateInputCount = [...hashes.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  return {
    totalCases: cases.length,
    maxTimeMs,
    maxMemoryKb,
    duplicateInputCount,
    duplicateRate: cases.length === 0 ? 0 : duplicateInputCount / cases.length,
    totalDiskBytes,
  };
}

export function toGateCaseSnapshot(row: GenerationCaseRow): GateCaseSnapshot {
  return {
    groupId: row.group_id,
    caseIndex: row.case_index,
    seed: row.seed,
    inputSha256: row.input_sha256,
    inputBytes: row.input_bytes,
    inputLines: row.input_lines,
    inputUtf8Valid: row.input_utf8 === 1,
    outputBytes: row.output_bytes,
    outputLines: row.output_lines,
    stdExitCode: row.std_exit_code,
    stdTimeMs: row.std_time_ms,
    stdMemoryKb: row.std_memory_kb,
    validatorOk: row.validator_ok === null ? null : row.validator_ok === 1,
  };
}

export function evaluateQualityGates(input: QualityGateInput): QualityGateReport {
  const findings: GateFinding[] = [];
  const { plan, cases } = input;
  const stats = computeStats(cases);

  if (!input.compile.generator) {
    findings.push(finding('compile', 'block', 'generator 未编译通过'));
  }
  if (!input.compile.std) {
    findings.push(finding('compile', 'block', 'std 未编译通过'));
  }
  if (input.hasValidator && input.compile.validator !== true) {
    findings.push(finding('compile', 'block', 'validator 未编译通过'));
  }
  if (input.compile.checker === false) {
    findings.push(finding('compile', 'block', 'checker 未编译通过'));
  }
  if (input.compile.generator && input.compile.std) {
    findings.push(finding('compile', 'pass', 'generator / std 编译通过'));
  }

  if (input.determinism.length !== cases.length) {
    findings.push(
      finding(
        'determinism',
        'block',
        `确定性复跑未覆盖全部测试点：${input.determinism.length}/${cases.length}`,
      ),
    );
  } else {
    const mismatch = input.determinism.find(
      (check) => check.firstSha256 !== check.secondSha256,
    );
    if (mismatch) {
      findings.push(
        finding(
          'determinism',
          'block',
          `同一 seed 两次生成 hash 不同：${mismatch.groupId}-${mismatch.caseIndex}`,
          { ...mismatch },
        ),
      );
    } else {
      findings.push(finding('determinism', 'pass', '所有测试点同 seed 输出一致'));
    }
  }

  const emptyCase = cases.find((row) => row.inputBytes === 0 || row.inputLines === 0);
  if (emptyCase) {
    findings.push(
      finding(
        'readability',
        'block',
        `输入为空：${emptyCase.groupId}-${emptyCase.caseIndex}`,
        { ...emptyCase },
      ),
    );
  }
  const invalidUtf8 = cases.find((row) => !row.inputUtf8Valid);
  if (invalidUtf8) {
    findings.push(
      finding(
        'readability',
        'block',
        `输入不是合法 UTF-8：${invalidUtf8.groupId}-${invalidUtf8.caseIndex}`,
      ),
    );
  }
  if (!emptyCase && !invalidUtf8) {
    findings.push(finding('readability', 'pass', '输入非空且为合法 UTF-8'));
  }

  const maxFileBytes = plan.limits.outputMb * 1024 * 1024;
  const oversized = cases.find(
    (row) => row.inputBytes > maxFileBytes || row.outputBytes > maxFileBytes,
  );
  if (oversized) {
    findings.push(
      finding(
        'size',
        'block',
        `单文件超过 ${plan.limits.outputMb} MB：${oversized.groupId}-${oversized.caseIndex}`,
      ),
    );
  } else {
    findings.push(finding('size', 'pass', '单文件大小在限制内'));
  }

  if (input.hasValidator) {
    const invalid = cases.find((row) => row.validatorOk !== true);
    if (invalid) {
      findings.push(
        finding(
          'validator',
          'block',
          `validator 未通过：${invalid.groupId}-${invalid.caseIndex}`,
        ),
      );
    } else {
      findings.push(finding('validator', 'pass', 'validator 全部通过'));
    }
  } else if (input.requiresValidator) {
    findings.push(
      finding(
        'validator',
        'block',
        'CF-like 或接受 Hack 的题目必须提供 validator',
      ),
    );
  } else {
    findings.push(
      finding(
        'validator',
        'warn',
        '未提供 validator，只能做格式/边界检查，语义约束未校验',
      ),
    );
  }

  const stdFailed = cases.find((row) => row.stdExitCode !== 0);
  if (stdFailed) {
    findings.push(
      finding(
        'std',
        'block',
        `std 非零退出：${stdFailed.groupId}-${stdFailed.caseIndex}`,
      ),
    );
  } else if (cases.length > 0) {
    findings.push(finding('std', 'pass', 'std 全部 exit 0'));
  } else {
    findings.push(finding('std', 'block', '没有测试点'));
  }

  const timeRatio = stats.maxTimeMs / plan.limits.timeMs;
  if (timeRatio > 0.8) {
    findings.push(
      finding('time-margin', 'block', `std 最大用时 ${stats.maxTimeMs}ms 超过时限 80%`, {
        ratio: timeRatio,
      }),
    );
  } else if (timeRatio > 0.5) {
    findings.push(
      finding('time-margin', 'warn', `std 最大用时 ${stats.maxTimeMs}ms 超过时限 50%`, {
        ratio: timeRatio,
      }),
    );
  } else {
    findings.push(finding('time-margin', 'pass', '时限余量充足'));
  }

  const memoryRatio = stats.maxMemoryKb / (plan.limits.memoryMb * 1024);
  if (memoryRatio > 0.8) {
    findings.push(
      finding(
        'memory-margin',
        'block',
        `std 峰值内存 ${stats.maxMemoryKb}KB 超过内存限制 80%`,
        { ratio: memoryRatio },
      ),
    );
  } else if (memoryRatio > 0.5) {
    findings.push(
      finding(
        'memory-margin',
        'warn',
        `std 峰值内存 ${stats.maxMemoryKb}KB 超过内存限制 50%`,
        { ratio: memoryRatio },
      ),
    );
  } else {
    findings.push(finding('memory-margin', 'pass', '内存余量充足'));
  }

  if (stats.duplicateRate > 0.1) {
    findings.push(
      finding(
        'duplicates',
        'block',
        `输入重复率 ${(stats.duplicateRate * 100).toFixed(1)}% 超过 10%`,
        { duplicateInputCount: stats.duplicateInputCount },
      ),
    );
  } else if (stats.duplicateRate > 0) {
    findings.push(
      finding(
        'duplicates',
        'warn',
        `存在 ${stats.duplicateInputCount} 个重复输入`,
        { duplicateInputCount: stats.duplicateInputCount },
      ),
    );
  } else {
    findings.push(finding('duplicates', 'pass', '输入无重复'));
  }

  const planValidation = validateDataPlan(plan, {
    totalPoints: DEFAULT_TOTAL_POINTS,
  });
  const coveredGroups = new Set(cases.map((row) => row.groupId));
  const missingGroup = plan.groups.find((group) => !coveredGroups.has(group.id));
  if (!planValidation.ok || missingGroup) {
    findings.push(
      finding(
        'subtasks',
        'block',
        missingGroup
          ? `子任务 ${missingGroup.id} 没有测试点`
          : planValidation.issues.find((entry) => entry.severity === 'error')?.message ??
            '子任务配置非法',
      ),
    );
  } else {
    findings.push(finding('subtasks', 'pass', '子任务分值、覆盖与依赖合法'));
  }

  if (input.samples.length === 0) {
    findings.push(finding('samples', 'warn', '题面没有样例，无法做样例门禁'));
  } else {
    const sampleFailure = input.samples.find(
      (sample) =>
        sample.exitCode !== 0 ||
        normalizeText(sample.actualOutput) !== normalizeText(sample.expectedOutput),
    );
    if (sampleFailure) {
      findings.push(
        finding(
          'samples',
          'block',
          `样例 ${sampleFailure.sampleIndex + 1} 输出不一致`,
          { ...sampleFailure },
        ),
      );
    } else {
      findings.push(finding('samples', 'pass', '样例输入/输出一致'));
    }
  }

  if (
    input.budget.actualWallMs > input.budget.maxWallMs ||
    input.budget.actualDiskBytes > input.budget.maxDiskBytes
  ) {
    findings.push(
      finding('budget', 'block', '生成总时长或磁盘占用超过预算', {
        actualWallMs: input.budget.actualWallMs,
        maxWallMs: input.budget.maxWallMs,
        actualDiskBytes: input.budget.actualDiskBytes,
        maxDiskBytes: input.budget.maxDiskBytes,
      }),
    );
  } else {
    findings.push(finding('budget', 'pass', '生成预算内'));
  }

  return {
    pass: !findings.some((entry) => entry.level === 'block'),
    findings,
    stats,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/server/tests/quality-gates.test.ts`

Expected: PASS（9 个用例通过）。

- [ ] **Step 5: Type-check the server package**

Run: `npx tsc -p apps/server/tsconfig.json --noEmit`

Expected: 无输出、退出码 0。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/authoring/quality-gates.ts apps/server/tests/quality-gates.test.ts
git commit -m "feat(authoring): add publish quality gates"
```

---

### Task 6: Minimal contextual help

**Files:**
- Create: `apps/web/src/help/authoring-help.ts`
- Create: `apps/web/src/components/HelpTip.tsx`
- Modify: `apps/web/src/components/DataPlanPanel.tsx`（加 3 个 HelpTip）
- Modify: `apps/web/src/pages/HelpPage.tsx`（加“出题人文档”卡片）
- Modify: `apps/web/src/styles/admin.css`（HelpTip 样式）
- Modify: `apps/web/src/styles/help.css`（文档卡片样式）
- Test: `apps/server/tests/authoring-help-docs.test.ts`

**Interfaces:**
- Produces:
  - `type AuthoringHelpKey = 'std-generator' | 'data-plan' | 'ai-prompts'`
  - `interface AuthoringHelpEntry { key; title; article; path; summary; bullets }`
  - `AUTHORING_HELP: Record<AuthoringHelpKey, AuthoringHelpEntry>`
  - `getAuthoringHelp(key): AuthoringHelpEntry`
  - `HelpTip({ helpKey, label? })`

- [ ] **Step 1: Write the failing test**

Create `apps/server/tests/authoring-help-docs.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORING_HELP } from '../../web/src/help/authoring-help.js';

describe('authoring help entries', () => {
  it('points at existing docs and carries a summary', () => {
    for (const entry of Object.values(AUTHORING_HELP)) {
      const absolute = join(process.cwd(), entry.path);
      expect(existsSync(absolute), entry.path).toBe(true);
      expect(entry.summary.length).toBeGreaterThan(10);
      expect(readFileSync(absolute, 'utf8')).toContain(entry.article);
    }
  });

  it('exposes the three authoring entry points', () => {
    expect(Object.keys(AUTHORING_HELP).sort()).toEqual([
      'ai-prompts',
      'data-plan',
      'std-generator',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/server/tests/authoring-help-docs.test.ts`

Expected: FAIL，报错 `Cannot find module '../../web/src/help/authoring-help.js'`。

- [ ] **Step 3: Implement `apps/web/src/help/authoring-help.ts`**

```ts
export type AuthoringHelpKey = 'std-generator' | 'data-plan' | 'ai-prompts';

export interface AuthoringHelpEntry {
  key: AuthoringHelpKey;
  title: string;
  /** 文档中必须出现的标题片段，测试用它确认路径没有指错。 */
  article: string;
  /** 相对仓库根目录的 Markdown 路径。 */
  path: string;
  summary: string;
  bullets: readonly string[];
}

export const AUTHORING_HELP: Record<AuthoringHelpKey, AuthoringHelpEntry> = {
  'std-generator': {
    key: 'std-generator',
    title: 'std / generator 契约',
    article: 'std / generator 契约',
    path: 'docs/help/authoring/std-generator-contract.md',
    summary: 'std 与 generator 的最小输入、testlib 参数、安全边界与常见错误。',
    bullets: [
      'generator 必须支持 --seed/--group/--index',
      '只使用 rnd，禁止 rand()/random_device/time()',
      'std 与 generator 都不读写文件、不联网',
    ],
  },
  'data-plan': {
    key: 'data-plan',
    title: '数据计划（Data Plan）',
    article: '数据计划',
    path: 'docs/help/authoring/data-plan.md',
    summary: '子任务、测试点数、seed、generator 参数、分值与依赖的配置方式。',
    bullets: [
      '所有子任务分值之和必须等于 100',
      '依赖必须无环',
      'args 按 argv 传递，不做 shell 拼接',
    ],
  },
  'ai-prompts': {
    key: 'ai-prompts',
    title: 'AI 提示词库',
    article: 'AI 提示词库',
    path: 'docs/help/authoring/ai-prompts.md',
    summary: '可复制的 std/generator/validator/checker 提示词；AI 代码必须人工审核。',
    bullets: [
      '只复制提示词，不默认调用外部 API',
      'AI 生成代码必须编译、试跑、审核',
      '不把学生代码或个人信息发给外部 AI',
    ],
  },
};

export function getAuthoringHelp(key: AuthoringHelpKey): AuthoringHelpEntry {
  return AUTHORING_HELP[key];
}
```

- [ ] **Step 4: Implement `apps/web/src/components/HelpTip.tsx`**

```tsx
import { Button, Popover } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import {
  getAuthoringHelp,
  type AuthoringHelpKey,
} from '../help/authoring-help';

export function HelpTip({
  helpKey,
  label,
}: {
  helpKey: AuthoringHelpKey;
  label?: string;
}) {
  const entry = getAuthoringHelp(helpKey);
  return (
    <Popover
      trigger="click"
      title={entry.title}
      content={
        <div className="help-tip-content">
          <p>{entry.summary}</p>
          <ul>
            {entry.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
          <p className="muted">
            文档：<code>{entry.path}</code>
          </p>
          <Link to="/help">打开帮助中心</Link>
        </div>
      }
    >
      <Button
        type="text"
        size="small"
        icon={<QuestionCircleOutlined />}
        aria-label={label ?? entry.title}
        title={label ?? entry.title}
      />
    </Popover>
  );
}
```

- [ ] **Step 5: Add HelpTips to `apps/web/src/components/DataPlanPanel.tsx`**

Add import:

```tsx
import { HelpTip } from './HelpTip';
```

Change the “数据计划” Card title to:

```tsx
        title={
          <Space size={4}>
            数据计划
            <HelpTip helpKey="data-plan" label="数据计划帮助" />
          </Space>
        }
```

Change the “生成任务” Card title to:

```tsx
        title={
          <Space size={4}>
            生成任务
            <HelpTip helpKey="std-generator" label="生成任务帮助" />
          </Space>
        }
```

In the “generator 参数” column title, use:

```tsx
      title: (
        <Space size={2}>
          generator 参数
          <HelpTip helpKey="std-generator" label="generator 参数帮助" />
        </Space>
      ),
```

- [ ] **Step 6: Add the authoring docs card to `apps/web/src/pages/HelpPage.tsx`**

Add import at the top:

```tsx
import { AUTHORING_HELP } from '../help/authoring-help';
```

Inside `<div className="help-sections">`, before the existing “1. 赛制与排序” Card, add:

```tsx
        <Card className="oij-card help-card" title="0. 出题与数据计划">
          <p>
            出题相关文档随安装包分发，位于仓库 <code>docs/help/authoring/</code>。
            下面的摘要对应已有 Markdown 文章；页面内暂不渲染 Markdown 全文。
          </p>
          <div className="help-authoring-list">
            {Object.values(AUTHORING_HELP).map((entry) => (
              <div className="help-authoring-row" key={entry.key}>
                <div>
                  <strong>{entry.title}</strong>
                  <span className="help-authoring-path mono">{entry.path}</span>
                </div>
                <p>{entry.summary}</p>
              </div>
            ))}
          </div>
        </Card>
```

- [ ] **Step 7: Append styles**

Append to `apps/web/src/styles/admin.css`:

```css
.help-tip-content {
  max-width: 320px;
  font-size: 12px;
}

.help-tip-content p {
  margin: 0 0 6px;
}

.help-tip-content ul {
  margin: 0 0 8px;
  padding-left: 18px;
}
```

Append to `apps/web/src/styles/help.css`:

```css
.help-authoring-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.help-authoring-row {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.help-authoring-row p {
  margin: 4px 0 0;
  color: var(--text-2);
}

.help-authoring-path {
  margin-left: 8px;
  color: var(--text-2);
  font-size: 11px;
}
```

- [ ] **Step 8: Run the help test**

Run: `npx vitest run apps/server/tests/authoring-help-docs.test.ts`

Expected: PASS（2 个用例通过）。

- [ ] **Step 9: Type-check the web app**

Run: `npm run web:typecheck`

Expected: 无输出、退出码 0。

- [ ] **Step 10: Run the full authoring test set**

Run:

```bash
npx vitest run apps/server/tests/data-plan.test.ts apps/server/tests/generation-job.test.ts apps/server/tests/admin-authoring.test.ts apps/server/tests/quality-gates.test.ts apps/server/tests/authoring-help-docs.test.ts apps/web/src/components/data-plan-form.test.ts
```

Expected: PASS（全部新增测试通过）。

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/help/authoring-help.ts apps/web/src/components/HelpTip.tsx apps/web/src/components/DataPlanPanel.tsx apps/web/src/pages/HelpPage.tsx apps/web/src/styles/admin.css apps/web/src/styles/help.css apps/server/tests/authoring-help-docs.test.ts
git commit -m "feat(help): link authoring fields to existing help articles"
```

---

## Self-Review Checklist（计划写完后复核）

- **Spec coverage:**
  - 3.2 步骤 3/4/5/6：Task 1/2/3/4 覆盖 Data Plan、生成、进度、取消、预览、失败点。
  - 3.3 Data Plan 模型：Task 1 覆盖 schema、points、dependsOn、seed、args、naming。
  - 3.4 generator 契约：Task 2 `generator-contract.ts` 覆盖 `--seed/--group/--index`。
  - 3.5 质量门禁：Task 5 覆盖编译、确定性、可读、大小、validator、std、时限/内存余量、重复、子任务、样例、预算。
  - 3.6 限制由出题人填写：Task 3 的模板只读取 `problem.time_ms` / `memory_mb`，不自动改写。
  - 3.7 AI 提示词：Task 4 只做复制抽屉，不调用外部 API。
  - 6.1 FR-AUT-010/011/012/013/014/015：分别落在 Task 3/4、Task 1/4、Task 2/3、Task 2、Task 5、Task 4。
  - 7.1 1.1 P0：Data Plan + 生成校验 + 质量门禁 + AI 提示词复制 + 帮助上下文最小接入。
  - 8.1 “独立后台任务”：Task 2 使用新表与独立 runtime，不触碰 `judge_tasks`。
- **Placeholder scan:** 没有 `TBD` / `TODO` / “后续补充”；每个代码步骤都有实际代码或完整骨架。
- **Type consistency:** `DataPlan` / `GenerationJobRow` / `GateCaseSnapshot` 在 Task 1/2/5 之间字段名一致；前端类型与 Task 3 DTO 的 camelCase 一致；`caseFileName`、`expandDataPlan`、`startGenerationJob` 名称在各 Task 中一致。
