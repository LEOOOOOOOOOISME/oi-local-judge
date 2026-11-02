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
