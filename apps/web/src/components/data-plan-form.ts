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
