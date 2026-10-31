import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { outputMatches } from '../src/judge/pipeline.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function files(expected: string, actual: string): { expectedPath: string; actualPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'oij-compare-'));
  dirs.push(dir);
  const expectedPath = join(dir, 'expected.txt');
  const actualPath = join(dir, 'actual.txt');
  writeFileSync(expectedPath, expected);
  writeFileSync(actualPath, actual);
  return { expectedPath, actualPath };
}

describe('output comparison modes', () => {
  it('ignores trailing spaces and a final newline by default', () => {
    const { expectedPath, actualPath } = files('1 2\n3\n', '1 2  \r\n3\r\n');
    expect(outputMatches(expectedPath, actualPath)).toBe(true);
  });

  it('supports exact, ignore-all and case-insensitive modes', () => {
    const spaced = files('a b\n', 'a  b\n');
    expect(outputMatches(spaced.expectedPath, spaced.actualPath, 'exact')).toBe(false);
    expect(outputMatches(spaced.expectedPath, spaced.actualPath, 'ignore-all')).toBe(true);

    const cased = files('YES\n', 'yes\n');
    expect(outputMatches(cased.expectedPath, cased.actualPath, 'case-insensitive')).toBe(true);
  });

  it('compares floating point tokens with tolerance', () => {
    const { expectedPath, actualPath } = files('1.0 2.5\n', '1.0000001 2.4999999\n');
    expect(outputMatches(expectedPath, actualPath, 'float')).toBe(true);
    const different = files('1.0\n', '1.1\n');
    expect(outputMatches(different.expectedPath, different.actualPath, 'float')).toBe(false);
  });

  it('treats a differing token count as wrong', () => {
    const { expectedPath, actualPath } = files('1 2 3\n', '1 2\n');
    expect(outputMatches(expectedPath, actualPath, 'ignore-all')).toBe(false);
  });
});
