import { describe, expect, it } from 'vitest';
import type { ProblemRow } from '../src/storage/repos/problems.js';
import { problemToSummary } from '../src/services/problems.js';

function makeRow(overrides: Partial<ProblemRow> = {}): ProblemRow {
  return {
    id: 7,
    title: 'A+B Problem',
    type: 'standard',
    difficulty: 3,
    tags_json: '["math"]',
    time_ms: 1000,
    memory_mb: 256,
    output_mb: 64,
    io_mode: 'stdio',
    input_file: null,
    output_file: null,
    statement_html: '',
    samples_json: '[]',
    checker_mode: 'builtin',
    checker_path: null,
    compare_mode: 'ignore-trailing',
    objective_json: '{}',
    visibility: 'public',
    owner_type: 'system',
    owner_id: null,
    version: 1,
    created_at: 0,
    ...overrides,
  };
}

describe('problemToSummary owner fields', () => {
  it('keeps system-owned problems ownerless', () => {
    const summary = problemToSummary(makeRow());
    expect(summary.ownerType).toBe('system');
    expect(summary.ownerId).toBeNull();
  });

  it('exposes the owning team', () => {
    const summary = problemToSummary(makeRow({ owner_type: 'team', owner_id: 42 }));
    expect(summary.ownerType).toBe('team');
    expect(summary.ownerId).toBe(42);
  });

  it('exposes the owning user', () => {
    const summary = problemToSummary(makeRow({ owner_type: 'user', owner_id: 5 }));
    expect(summary.ownerType).toBe('user');
    expect(summary.ownerId).toBe(5);
  });

  it('keeps the existing summary fields unchanged', () => {
    expect(problemToSummary(makeRow())).toEqual({
      id: 7,
      title: 'A+B Problem',
      type: 'standard',
      difficulty: 3,
      tags: ['math'],
      timeMs: 1000,
      memoryMb: 256,
      ownerType: 'system',
      ownerId: null,
    });
  });
});
