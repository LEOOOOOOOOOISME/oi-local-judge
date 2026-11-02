import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORING_HELP } from '../../web/src/help/authoring-help.js';

describe('authoring help entries', () => {
  it('points at existing docs and carries a summary', () => {
    for (const entry of Object.values(AUTHORING_HELP)) {
      const absolute = join(process.cwd(), entry.path);
      expect(existsSync(absolute), entry.path).toBe(true);
      expect(entry.summary.length).toBeGreaterThan(10);
      expect(readFileSync(absolute, 'utf8')).toContain(entry.article);
    }
  });

  it('exposes the three authoring entry points', () => {
    expect(Object.keys(AUTHORING_HELP).sort()).toEqual([
      'ai-prompts',
      'data-plan',
      'std-generator',
    ]);
  });
});
