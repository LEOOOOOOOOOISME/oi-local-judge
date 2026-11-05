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
