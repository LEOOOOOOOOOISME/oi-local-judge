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

  const pointsModeRaw = value.pointsMode;
  let pointsMode: DataPlanPointsMode = 'group';
  if (pointsModeRaw === 'per-test' || pointsModeRaw === 'auto') {
    pointsMode = pointsModeRaw;
  } else if (pointsModeRaw !== undefined && pointsModeRaw !== 'group') {
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
