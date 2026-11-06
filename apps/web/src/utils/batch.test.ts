import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { AdminProblemSummary } from '../api/types';
import {
  applyOrderedMapping,
  autoProblemId,
  batchStatusLabel,
  describeBatchError,
  estimateSubmissions,
  filterProblems,
  isBatchActive,
  levelExample,
  MAX_BATCH_ZIP_BYTES,
  problemScope,
  treeSampleRows,
  validateFolderMapping,
  validateZipFile,
} from './batch';

function makeProblem(overrides: Partial<AdminProblemSummary>): AdminProblemSummary {
  return {
    id: 1,
    title: 'A + B',
    type: 'standard',
    difficulty: 1,
    tags: [],
    timeMs: 1000,
    memoryMb: 256,
    visibility: 'public',
    ownerType: 'system',
    ownerId: null,
    ...overrides,
  };
}

const problems: AdminProblemSummary[] = [
  makeProblem({ id: 101, title: 'Crystal', tags: ['dp', 'graph'], ownerType: 'user', ownerId: 7 }),
  makeProblem({ id: 102, title: 'Hub', tags: ['greedy'], ownerType: 'team', ownerId: 3 }),
  makeProblem({ id: 103, title: 'Migrate', tags: ['math'], ownerType: 'system', ownerId: null }),
  makeProblem({ id: 104, title: 'Subway', tags: ['DP'], ownerType: 'user', ownerId: 9 }),
];

describe('problemScope', () => {
  it('maps owner types to picker scopes', () => {
    expect(problemScope({ ownerType: 'user' })).toBe('personal');
    expect(problemScope({ ownerType: 'team' })).toBe('team');
    expect(problemScope({ ownerType: 'system' })).toBe('public');
  });
});

describe('filterProblems', () => {
  it('filters by scope', () => {
    expect(filterProblems(problems, { scope: 'personal' }).map((p) => p.id)).toEqual([101, 104]);
    expect(filterProblems(problems, { scope: 'team' }).map((p) => p.id)).toEqual([102]);
    expect(filterProblems(problems, { scope: 'public' }).map((p) => p.id)).toEqual([103]);
    expect(filterProblems(problems, { scope: 'all' })).toHaveLength(4);
  });

  it('searches id, title and tags case-insensitively', () => {
    expect(filterProblems(problems, { query: '101' }).map((p) => p.id)).toEqual([101]);
    expect(filterProblems(problems, { query: '#102' }).map((p) => p.id)).toEqual([102]);
    expect(filterProblems(problems, { query: 'cryst' }).map((p) => p.id)).toEqual([101]);
    expect(filterProblems(problems, { query: 'dp' }).map((p) => p.id)).toEqual([101, 104]);
  });

  it('combines scope and query and honours the limit', () => {
    expect(filterProblems(problems, { scope: 'personal', query: 'dp' }).map((p) => p.id)).toEqual([
      101, 104,
    ]);
    expect(filterProblems(problems, { query: 'e', limit: 2 })).toHaveLength(2);
    expect(filterProblems(problems, { query: 'missing' })).toEqual([]);
  });

  it('trims whitespace-only queries', () => {
    expect(filterProblems(problems, { query: '   ' })).toHaveLength(4);
  });
});

describe('autoProblemId', () => {
  const known = new Set([101, 102]);

  it('matches numeric folder names to existing problem ids', () => {
    expect(autoProblemId('101', known)).toBe(101);
    expect(autoProblemId(' 102 ', known)).toBe(102);
  });

  it('returns null for non-numeric or unknown folders', () => {
    expect(autoProblemId('crystal', known)).toBeNull();
    expect(autoProblemId('999', known)).toBeNull();
    expect(autoProblemId('101.5', known)).toBeNull();
    expect(autoProblemId('', known)).toBeNull();
  });
});

describe('applyOrderedMapping', () => {
  it('binds folders to problems in selection order', () => {
    expect(
      applyOrderedMapping(['crystal', 'hub', 'migrate'], [103, 101, 102]),
    ).toEqual({ crystal: 103, hub: 101, migrate: 102 });
  });

  it('keeps untouched manual mappings and ignores extra selections', () => {
    expect(
      applyOrderedMapping(['a', 'b', 'c'], [1, 2, 3, 4], { c: 9 }),
    ).toEqual({ a: 1, b: 2, c: 3 });
    expect(applyOrderedMapping(['a', 'b'], [1], { b: 7 })).toEqual({ a: 1, b: 7 });
  });

  it('handles empty selections', () => {
    expect(applyOrderedMapping(['a'], [])).toEqual({});
  });
});

describe('validateFolderMapping', () => {
  const folders = ['crystal', 'hub', 'migrate'];
  const known = new Set([101, 102, 103, 104]);

  it('reports unmapped folders', () => {
    const result = validateFolderMapping(folders, { crystal: 101 }, known);
    expect(result.unmapped).toEqual(['hub', 'migrate']);
    expect(result.complete).toBe(false);
  });

  it('reports ids missing from the catalog', () => {
    const result = validateFolderMapping(folders, { crystal: 101, hub: 999, migrate: 103 }, known);
    expect(result.unknown).toEqual(['hub']);
    expect(result.complete).toBe(false);
  });

  it('accepts a complete unique mapping', () => {
    const result = validateFolderMapping(
      folders,
      { crystal: 101, hub: 102, migrate: 103 },
      known,
    );
    expect(result).toEqual({
      unmapped: [],
      unknown: [],
      duplicateProblems: [],
      complete: true,
    });
  });

  it('flags duplicate problem bindings without blocking completion', () => {
    const result = validateFolderMapping(
      folders,
      { crystal: 101, hub: 101, migrate: 103 },
      known,
    );
    expect(result.duplicateProblems).toEqual([101]);
    expect(result.complete).toBe(true);
  });

  it('treats an empty folder list as complete', () => {
    expect(validateFolderMapping([], {}, known).complete).toBe(true);
  });
});

describe('estimateSubmissions', () => {
  it('uses validCount for the single-problem mode', () => {
    expect(
      estimateSubmissions({ validCount: 120, multiProblem: false, folders: [], problemMap: {} }),
    ).toEqual({ submissions: 120, exact: true, collisions: [] });
  });

  it('is exact when every folder maps to a distinct problem', () => {
    expect(
      estimateSubmissions({
        validCount: 5438,
        multiProblem: true,
        folders: ['crystal', 'hub', 'migrate', 'subway'],
        problemMap: { crystal: 101, hub: 102, migrate: 103, subway: 104 },
      }),
    ).toEqual({ submissions: 5438, exact: true, collisions: [] });
  });

  it('marks the estimate inexact when mappings collide', () => {
    const result = estimateSubmissions({
      validCount: 5438,
      multiProblem: true,
      folders: ['crystal', 'hub'],
      problemMap: { crystal: 101, hub: 101 },
    });
    expect(result.submissions).toBe(5438);
    expect(result.exact).toBe(false);
    expect(result.collisions).toEqual([101]);
  });

  it('marks the estimate inexact while folders are unmapped', () => {
    const result = estimateSubmissions({
      validCount: 10,
      multiProblem: true,
      folders: ['a', 'b'],
      problemMap: { a: 1 },
    });
    expect(result).toEqual({ submissions: 10, exact: false, collisions: [] });
  });

  it('returns zero when there are no problem folders', () => {
    expect(
      estimateSubmissions({ validCount: 500, multiProblem: true, folders: [], problemMap: {} }),
    ).toEqual({ submissions: 0, exact: true, collisions: [] });
  });
});

describe('treeSampleRows', () => {
  it('computes depth from slashes and skips duplicates/empties', () => {
    expect(treeSampleRows(['Sdata/Alice', 'Sdata/Alice/crystal.cpp', 'Sdata/Alice', ''])).toEqual([
      { path: 'Sdata/Alice', depth: 1, name: 'Alice' },
      { path: 'Sdata/Alice/crystal.cpp', depth: 2, name: 'crystal.cpp' },
    ]);
  });

  it('treats backslashes as separators and honours the limit', () => {
    expect(treeSampleRows(['a\\b\\c'], 5)).toEqual([{ path: 'a/b/c', depth: 2, name: 'c' }]);
    expect(treeSampleRows(['a', 'b', 'c'], 2)).toHaveLength(2);
  });
});

describe('levelExample', () => {
  const sample = [
    'Sdata',
    'Sdata/Alice',
    'Sdata/Alice/crystal.cpp',
    'Sdata/Alice/crystal/main.cpp',
  ];

  it('shows the student and problem folder at the selected levels', () => {
    expect(levelExample(sample, 1, 2)).toEqual({
      path: 'Sdata/Alice/crystal.cpp',
      student: 'Sdata',
      problemFolder: 'Alice',
    });
    expect(levelExample(sample, 2, 3)).toEqual({
      path: 'Sdata/Alice/crystal/main.cpp',
      student: 'Alice',
      problemFolder: 'crystal',
    });
  });

  it('omits the problem folder in single-problem mode', () => {
    expect(levelExample(sample, 2, 0)).toEqual({
      path: 'Sdata/Alice/crystal.cpp',
      student: 'Alice',
      problemFolder: null,
    });
  });

  it('returns null when no path is deeper than the selected levels', () => {
    expect(levelExample(['Sdata/Alice'], 1, 2)).toBeNull();
    expect(levelExample([], 1, 0)).toBeNull();
    expect(levelExample(sample, 0, 0)).toBeNull();
  });
});

describe('validateZipFile', () => {
  it('rejects non-zip, empty and oversized files', () => {
    expect(validateZipFile({ name: 'A.rar', size: 10 })).toBe('请选择 .zip 文件');
    expect(validateZipFile({ name: 'A.zip', size: 0 })).toBe('zip 文件为空');
    expect(validateZipFile({ name: 'A.ZIP', size: MAX_BATCH_ZIP_BYTES + 1 })).toBe(
      'zip 超过 5 GB 限制',
    );
  });

  it('accepts a normal zip', () => {
    expect(validateZipFile({ name: 'A.ZIP', size: MAX_BATCH_ZIP_BYTES })).toBeNull();
  });
});

describe('batch status helpers', () => {
  it('treats in-flight statuses as active', () => {
    for (const status of ['importing', 'queued', 'judging', 'running']) {
      expect(isBatchActive(status)).toBe(true);
    }
    for (const status of ['finished', 'failed', 'canceled', null, undefined]) {
      expect(isBatchActive(status)).toBe(false);
    }
  });

  it('labels known statuses and falls back to the raw value', () => {
    expect(batchStatusLabel('importing')).toBe('导入中');
    expect(batchStatusLabel('judging')).toBe('评测中');
    expect(batchStatusLabel('finished')).toBe('已完成');
    expect(batchStatusLabel('canceled')).toBe('已取消');
    expect(batchStatusLabel('mystery')).toBe('mystery');
  });
});

describe('describeBatchError', () => {
  it('maps known API error codes to Chinese guidance', () => {
    expect(describeBatchError(new ApiError(413, 'too big', 'BATCH_ZIP_TOO_LARGE'))).toBe(
      'zip 超过 5 GB 上限：too big',
    );
    expect(describeBatchError(new ApiError(404, 'gone', 'UPLOAD_NOT_FOUND'))).toBe(
      '上传记录不存在或已过期，请重新上传：gone',
    );
    expect(describeBatchError(new ApiError(409, 'busy', 'BATCH_ALREADY_RUNNING'))).toBe(
      '该上传已有未完成的批次，请等待完成或先取消：busy',
    );
    // 后端只返回 { code } 时，不把默认 HTTP 文案拼进中文提示。
    expect(
      describeBatchError(new ApiError(409, '请求失败（HTTP 409）', 'BATCH_ALREADY_RUNNING')),
    ).toBe('该上传已有未完成的批次，请等待完成或先取消');
  });

  it('falls back to the server message for unknown codes', () => {
    expect(describeBatchError(new ApiError(500, 'boom', 'SOMETHING'))).toBe('boom');
    expect(describeBatchError(new Error('oops'))).toBe('oops');
    expect(describeBatchError(null)).toBe('批量评测请求失败');
  });
});
