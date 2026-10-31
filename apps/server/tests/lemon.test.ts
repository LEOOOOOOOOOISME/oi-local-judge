import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { buildCdf, importLemonProblem, parseCdf } from '../src/services/lemon.js';
import { getProblemDetail } from '../src/services/problems.js';
import { getTestcases } from '../src/storage/repos/problems.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'lemon-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
ensureDataDirs(root);
const db = openDatabase(join(root, 'test.db'));
migrate(db);

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Lemon CDF adapter', () => {
  it('parses cdf metadata and imports test data', () => {
    const source = join(root, 'lemon-source');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'data', '1.in'), '1 2\n');
    writeFileSync(join(source, 'data', '1.out'), '3\n');
    writeFileSync(join(source, 'data', '2.in'), '2 2\n');
    writeFileSync(join(source, 'data', '2.out'), '4\n');
    writeFileSync(join(source, 'std.cpp'), '#include <iostream>\nint main(){}');
    writeFileSync(
      join(source, 'problem.cdf'),
      '<?xml version="1.0"?><cdf><name>Lemon A+B</name><time_limit>2</time_limit><memory_limit>128</memory_limit><test_points>40 60</test_points></cdf>',
    );

    const info = parseCdf(
      '<cdf><name>X</name><time_limit>1.5</time_limit><memory_limit>64</memory_limit></cdf>',
    );
    expect(info.timeLimit).toBe(1500);
    expect(info.memoryLimit).toBe(64);

    const id = importLemonProblem({ db, config, sourceDir: source });
    const detail = getProblemDetail(db, id)!;
    expect(detail.title).toBe('Lemon A+B');
    expect(detail.timeMs).toBe(2000);
    expect(detail.memoryMb).toBe(128);
    const testcases = getTestcases(db, id);
    expect(testcases.map((row) => row.points)).toEqual([40, 60]);

    const cdf = buildCdf({ name: 'A&B', timeMs: 1500, memoryMb: 256, points: [50, 50] });
    expect(cdf).toContain('<name>A&amp;B</name>');
    expect(cdf).toContain('<time_limit>1.5</time_limit>');
  });
});
