import { describe, expect, it } from 'vitest';
import type { ProblemSummary } from '../api/types';
import { filterTeamProblems } from './teamProblems';

function makeProblem(overrides: Partial<ProblemSummary>): ProblemSummary {
  return {
    id: 1,
    title: 'P1',
    type: 'standard',
    difficulty: null,
    tags: [],
    timeMs: 1000,
    memoryMb: 256,
    ownerType: 'system',
    ownerId: null,
    ...overrides,
  };
}

const problems: ProblemSummary[] = [
  makeProblem({ id: 1, title: 'system', ownerType: 'system', ownerId: null }),
  makeProblem({ id: 2, title: 'alice', ownerType: 'user', ownerId: 11 }),
  makeProblem({ id: 3, title: 'team-9-a', ownerType: 'team', ownerId: 9 }),
  makeProblem({ id: 4, title: 'team-9-b', ownerType: 'team', ownerId: 9 }),
  makeProblem({ id: 5, title: 'team-10', ownerType: 'team', ownerId: 10 }),
  makeProblem({ id: 6, title: 'legacy' }),
];

describe('filterTeamProblems', () => {
  it('keeps only problems owned by the given team', () => {
    expect(filterTeamProblems(problems, 9).map((problem) => problem.id)).toEqual([3, 4]);
  });

  it('ignores system-owned, user-owned and other-team problems', () => {
    const ids = filterTeamProblems(problems, 9).map((problem) => problem.id);
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(5);
  });

  it('drops problems without owner information (old servers)', () => {
    const legacy = [makeProblem({ id: 6, ownerType: undefined, ownerId: undefined })];
    expect(filterTeamProblems(legacy, 9)).toEqual([]);
  });

  it('returns an empty list for an invalid team id', () => {
    expect(filterTeamProblems(problems, 0)).toEqual([]);
    expect(filterTeamProblems(problems, -3)).toEqual([]);
    expect(filterTeamProblems(problems, Number.NaN)).toEqual([]);
  });

  it('returns a new array without mutating the input', () => {
    const input = problems.slice();
    const result = filterTeamProblems(input, 9);
    expect(result).not.toBe(input);
    expect(input).toEqual(problems);
  });
});
