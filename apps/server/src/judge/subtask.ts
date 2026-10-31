// Subtask scoring for OI-style problems.
//
// Phase 1A rules:
//  - no subtasks          -> total score is the sum of testcase scores
//  - aggregation "min"    -> all testcases in the subtask must be AC, then the
//                            subtask awards its own points; otherwise 0
//  - aggregation "sum"    -> sum of the subtask's testcase scores
//  - testcases without a subtask always contribute their own score directly
import type { TestResultDto } from '@oij/shared';

import type { SubtaskRow } from '../storage/repos/problems.js';

export interface SubtaskWithTestcases extends SubtaskRow {
  /** Ids of the enabled testcases that belong to this subtask. */
  testcaseIds: number[];
}

export function aggregateSubtask(
  results: readonly TestResultDto[],
  subtasks: readonly SubtaskWithTestcases[],
): number {
  const byTestcase = new Map<number, TestResultDto>();
  for (const result of results) byTestcase.set(result.testcaseId, result);

  if (subtasks.length === 0) {
    return Math.round(results.reduce((sum, result) => sum + result.score, 0));
  }

  let total = 0;
  const grouped = new Set<number>();

  for (const subtask of subtasks) {
    const members = subtask.testcaseIds
      .map((id) => byTestcase.get(id))
      .filter((result): result is TestResultDto => result !== undefined);
    if (members.length === 0) continue;
    for (const member of members) grouped.add(member.testcaseId);

    if (subtask.aggregation === 'min') {
      total += members.every((member) => member.verdict === 'AC') ? subtask.points : 0;
    } else {
      total += members.reduce((sum, member) => sum + member.score, 0);
    }
  }

  // Testcases that are not part of any subtask still score individually.
  for (const result of results) {
    if (!grouped.has(result.testcaseId)) total += result.score;
  }

  return Math.round(total);
}
