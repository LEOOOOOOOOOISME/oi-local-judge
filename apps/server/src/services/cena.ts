import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { importProblemDirectory } from './problems.js';

export interface CenaImportOptions {
  db: DatabaseSync;
  config: Config;
  sourceDir: string;
  title?: string;
}

interface CenaAssets {
  std?: string;
  checker?: string;
  generator?: string;
}

function findDataRoot(sourceDir: string): string {
  const dataDir = join(sourceDir, 'data');
  return existsSync(dataDir) ? dataDir : sourceDir;
}

function collectTestcases(sourceDir: string) {
  const dataRoot = findDataRoot(sourceDir);
  const files = readdirSync(dataRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dataRoot, join(entry.parentPath ?? dataRoot, entry.name)));
  const inputs = new Map<string, string>();
  const outputs = new Map<string, string>();
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    const key = file.slice(0, -extension.length);
    if (extension === '.in') inputs.set(key, join(relative(sourceDir, dataRoot), file));
    if (extension === '.out' || extension === '.ans') {
      outputs.set(key, join(relative(sourceDir, dataRoot), file));
    }
  }
  const pairs = [...inputs.entries()]
    .filter(([key]) => outputs.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, input]) => ({ input, output: outputs.get(key)! }));
  return pairs;
}

function detectAssets(sourceDir: string): CenaAssets {
  const assets: CenaAssets = {};
  const candidates: Array<[keyof CenaAssets, string[]]> = [
    ['std', ['std.cpp', 'std.cc', 'std.cxx']],
    ['checker', ['checker.cpp', 'checker.cc', 'checker.cxx']],
    ['generator', ['maker.cpp', 'gen.cpp', 'generator.cpp']],
  ];
  for (const [kind, names] of candidates) {
    for (const name of names) {
      if (existsSync(join(sourceDir, name))) {
        assets[kind] = name;
        break;
      }
    }
  }
  return assets;
}

function readStatement(sourceDir: string): string | undefined {
  for (const name of ['problem.md', 'statement.md', 'problem.txt', 'statement.txt', 'README.md']) {
    const path = join(sourceDir, name);
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8').slice(0, 200_000);
      if (name.endsWith('.md')) return `<pre class="cena-statement">${text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`;
      return `<pre class="cena-statement">${text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</pre>`;
    }
  }
  return undefined;
}

/**
 * Imports a Cena-style folder (data/*.in + data/*.out, std.cpp/checker.cpp/...)
 * by staging a temporary copy with a generated problem.json.
 */
export function importCenaProblem(options: CenaImportOptions): number {
  const testcases = collectTestcases(options.sourceDir);
  if (testcases.length === 0) {
    throw new Error('no .in/.out pairs found for Cena import');
  }
  const assets = detectAssets(options.sourceDir);
  const title = options.title?.trim() || basename(options.sourceDir);
  const statementHtml = readStatement(options.sourceDir);

  const tmpRoot = join(options.config.dataDir, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const staged = mkdtempSync(join(tmpRoot, 'cena-'));
  try {
    cpSync(options.sourceDir, staged, { recursive: true });
    const manifest = {
      title,
      type: 'standard',
      timeMs: 1000,
      memoryMb: 256,
      ioMode: 'stdio',
      ...(statementHtml ? { statementHtml } : {}),
      testcases: testcases.map((testcase) => ({
        input: testcase.input.replace(/\\/g, '/'),
        output: testcase.output.replace(/\\/g, '/'),
        points: Math.max(1, Math.round(100 / testcases.length)),
      })),
      assets,
    };
    writeFileSync(join(staged, 'problem.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return importProblemDirectory({ db: options.db, config: options.config, sourceDir: staged });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}
