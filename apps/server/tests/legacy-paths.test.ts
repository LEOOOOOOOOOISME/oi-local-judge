import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repairLegacyTestcasePaths } from '../src/services/problems.js';
import { createProblem, getTestcases } from '../src/storage/repos/problems.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'legacy-paths-'));
const db = openDatabase(join(root, 'test.db'));
migrate(db);

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('legacy testcase path repair', () => {
  it('rewrites data/ paths to problems/<id>/data when the file exists', () => {
    const problemId = createProblem(db, {
      title: 'Legacy',
      type: 'standard',
      timeMs: 1000,
      memoryMb: 64,
      testcases: [{ inputPath: 'data/1.in', outputPath: 'data/1.out', points: 100 }],
    });
    const dataDir = join(root, 'problems', String(problemId), 'data');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, '1.in'), '1 2\n');
    writeFileSync(join(dataDir, '1.out'), '3\n');

    expect(repairLegacyTestcasePaths(db, root)).toBe(1);
    expect(getTestcases(db, problemId)[0].input_path).toBe(
      `problems/${problemId}/data/1.in`,
    );
    expect(repairLegacyTestcasePaths(db, root)).toBe(0);
  });
});
