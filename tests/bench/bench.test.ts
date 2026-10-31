import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('bench scripts', () => {
  it('sqlite bench emits valid json', () => {
    const out = execFileSync(process.execPath, ['tools/bench/sqlite-bench.mjs'], {
      encoding: 'utf8',
    });
    const data = JSON.parse(out) as { insert20Ms: number; rows: number };
    expect(typeof data.insert20Ms).toBe('number');
    expect(data.rows).toBe(4000);
  }, 60000);

  it('ranking bench emits valid json', () => {
    const out = execFileSync(process.execPath, ['tools/bench/ranking-bench.mjs'], {
      encoding: 'utf8',
    });
    const data = JSON.parse(out) as { computeMs: number; rows: number };
    expect(typeof data.computeMs).toBe('number');
    expect(data.rows).toBe(500);
  }, 60000);
});
