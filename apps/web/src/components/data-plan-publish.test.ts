import { describe, expect, it } from 'vitest';
import type { PublishGenerationResult, QualityGateReport } from '../api/types';
import {
  publishErrorText,
  publishSuccessText,
  selectGateFindings,
} from './data-plan-publish';

const report: QualityGateReport = {
  pass: false,
  findings: [
    { gate: 'compile', level: 'pass', message: 'generator / std 编译通过' },
    { gate: 'determinism', level: 'warn', message: '未做确定性复跑' },
    { gate: 'std', level: 'block', message: 'std 非零退出' },
  ],
  stats: {
    totalCases: 3,
    maxTimeMs: 10,
    maxMemoryKb: 1024,
    duplicateInputCount: 0,
    duplicateRate: 0,
    totalDiskBytes: 100,
  },
};

describe('data plan publish helpers', () => {
  it('selects block and warn findings and ignores pass', () => {
    expect(selectGateFindings(report).map((finding) => finding.level)).toEqual([
      'warn',
      'block',
    ]);
  });

  it('can select only warnings for the confirm dialog', () => {
    expect(selectGateFindings(report, ['warn'])).toEqual([
      { gate: 'determinism', level: 'warn', message: '未做确定性复跑' },
    ]);
  });

  it('returns no findings when the report is missing or empty', () => {
    expect(selectGateFindings(undefined)).toEqual([]);
  });

  it('formats success counts', () => {
    const result = { testcases: 12, subtasks: 3 } as PublishGenerationResult;
    expect(publishSuccessText(result)).toBe('已发布 12 个测试点、3 个子任务');
  });

  it('formats error code and message', () => {
    expect(
      publishErrorText({ code: 'QUALITY_GATE_BLOCKED', message: '质量门禁未通过' }),
    ).toBe('QUALITY_GATE_BLOCKED：质量门禁未通过');
    expect(publishErrorText({ message: '网络错误' })).toBe('网络错误');
  });
});
