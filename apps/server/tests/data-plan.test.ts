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
