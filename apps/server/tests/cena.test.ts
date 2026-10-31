import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import { importCenaProblem } from '../src/services/cena.js';
import { getProblemDetail } from '../src/services/problems.js';
import { listAssets } from '../src/storage/repos/assets.js';
import { getTestcases } from '../src/storage/repos/problems.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'cena-'));
const config = { ...loadConfig({ ...process.env, OIJ_DATA_DIR: root }), dataDir: root };
ensureDataDirs(root);
const db = openDatabase(join(root, 'test.db'));
migrate(db);

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Cena package import', () => {
  it('imports data pairs and std.cpp', () => {
    const source = join(root, 'cena-source');
    mkdirSync(join(source, 'data'), { recursive: true });
    writeFileSync(join(source, 'data', '1.in'), '1 2\n');
    writeFileSync(join(source, 'data', '1.out'), '3\n');
    writeFileSync(join(source, 'data', '2.in'), '2 3\n');
    writeFileSync(join(source, 'data', '2.out'), '5\n');
    writeFileSync(join(source, 'std.cpp'), '#include <iostream>\nint main(){}');
    writeFileSync(join(source, 'problem.md'), '# Cena A+B');

    const id = importCenaProblem({ db, config, sourceDir: source, title: 'Cena A+B' });
    const detail = getProblemDetail(db, id)!;
    expect(detail.title).toBe('Cena A+B');
    expect(detail.statementHtml).toContain('Cena A+B');
    expect(getTestcases(db, id)).toHaveLength(2);
    expect(listAssets(db, id).find((asset) => asset.kind === 'std')?.language).toBe('cpp17');
  });
});
