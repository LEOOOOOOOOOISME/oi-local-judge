import type { ProblemSummary } from '../api/types';

/**
 * 团队题目筛选：GET /api/problems 已按题目 ACL 过滤，这里只取该团队拥有的题目。
 *
 * 非团队成员看不到团队题，因此上层列表可能为空；ownerType/ownerId 缺失
 * （旧后端）时不计入，避免把归属不明的题目算作团队题。
 */
export function filterTeamProblems(
  problems: ProblemSummary[],
  teamId: number,
): ProblemSummary[] {
  if (!Number.isInteger(teamId) || teamId <= 0) return [];
  return problems.filter(
    (problem) => problem.ownerType === 'team' && problem.ownerId === teamId,
  );
}
