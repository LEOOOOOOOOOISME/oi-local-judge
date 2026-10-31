import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { importProblemDirectory } from './problems.js';

export interface LemonImportOptions {
  db: DatabaseSync;
  config: Config;
  sourceDir: string;
}

interface CdfInfo {
  name?: string;
  timeLimit?: number;
  memoryLimit?: number;
  inputFile?: string;
  outputFile?: string;
  testPoints?: number[];
}

function findCdf(sourceDir: string): string | null {
  const direct = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.cdf')
    .map((entry) => entry.name);
  if (direct.length > 0) return join(sourceDir, direct[0]);
  const nested = readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(sourceDir, entry.name))
    .find((dir) => readdirSync(dir).some((name) => name.toLowerCase().endsWith('.cdf')));
  if (!nested) return null;
  const name = readdirSync(nested).find((entry) => entry.toLowerCase().endsWith('.cdf'))!;
  return join(nested, name);
}

function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!match) return undefined;
  return match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

export function parseCdf(xml: string): CdfInfo {
  const time = Number(tag(xml, 'time_limit') ?? '1');
  const memory = Number(tag(xml, 'memory_limit') ?? '256');
  const points = (tag(xml, 'test_points') ?? '')
    .split(/\s+/)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    name: tag(xml, 'name') || tag(xml, 'title') || undefined,
    timeLimit: Number.isFinite(time) ? (time > 100 ? time : Math.round(time * 1000)) : 1000,
    memoryLimit: Number.isFinite(memory) ? memory : 256,
    inputFile: tag(xml, 'input_file') || undefined,
    outputFile: tag(xml, 'output_file') || undefined,
    testPoints: points.length > 0 ? points : undefined,
  };
}

function collectTestcases(sourceDir: string) {
  const dataDir = join(sourceDir, 'data');
  const root = existsSync(dataDir) ? dataDir : sourceDir;
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath ?? root, entry.name)));
  const inputs = new Map<string, string>();
  const outputs = new Map<string, string>();
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    const key = file.slice(0, -extension.length);
    if (extension === '.in') inputs.set(key, join(relative(sourceDir, root), file));
    if (extension === '.out' || extension === '.ans') {
      outputs.set(key, join(relative(sourceDir, root), file));
    }
  }
  return [...inputs.entries()]
    .filter(([key]) => outputs.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, input]) => ({ input, output: outputs.get(key)! }));
}

function detectAssets(sourceDir: string): Record<string, string> {
  const assets: Record<string, string> = {};
  for (const [kind, names] of [
    ['std', ['std.cpp', 'std.cc']],
    ['checker', ['checker.cpp', 'checker.cc']],
    ['generator', ['maker.cpp', 'gen.cpp']],
  ] as const) {
    const found = names.find((name) => existsSync(join(sourceDir, name)));
    if (found) assets[kind] = found;
  }
  return assets;
}

/** Imports a Lemon-style package: a .cdf plus data/*.in|out. */
export function importLemonProblem(options: LemonImportOptions): number {
  const cdfPath = findCdf(options.sourceDir);
  if (!cdfPath) throw new Error('no .cdf file found for Lemon import');
  const info = parseCdf(readFileSync(cdfPath, 'utf8'));
  const testcases = collectTestcases(options.sourceDir);
  if (testcases.length === 0) throw new Error('no .in/.out pairs found for Lemon import');

  const staged = mkdtempSync(join(options.config.dataDir, 'tmp', 'lemon-'));
  try {
    cpSync(options.sourceDir, staged, { recursive: true });
    const weights = testcases.map((_, index) => info.testPoints?.[index] ?? Math.round(100 / testcases.length));
    const manifest = {
      title: info.name ?? basename(options.sourceDir),
      type: 'standard',
      timeMs: info.timeLimit ?? 1000,
      memoryMb: info.memoryLimit ?? 256,
      ioMode: info.inputFile && info.outputFile ? 'file' : 'stdio',
      ...(info.inputFile && info.outputFile
        ? { inputFile: info.inputFile, outputFile: info.outputFile }
        : {}),
      testcases: testcases.map((testcase, index) => ({
        input: testcase.input.replace(/\\/g, '/'),
        output: testcase.output.replace(/\\/g, '/'),
        points: weights[index] ?? 0,
      })),
      assets: detectAssets(options.sourceDir),
    };
    writeFileSync(join(staged, 'problem.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return importProblemDirectory({ db: options.db, config: options.config, sourceDir: staged });
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

export function buildCdf(input: {
  name: string;
  timeMs: number;
  memoryMb: number;
  inputFile?: string | null;
  outputFile?: string | null;
  points: number[];
}): string {
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<cdf>
  <name>${escape(input.name)}</name>
  <time_limit>${input.timeMs / 1000}</time_limit>
  <memory_limit>${input.memoryMb}</memory_limit>
  <input_file>${escape(input.inputFile ?? '')}</input_file>
  <output_file>${escape(input.outputFile ?? '')}</output_file>
  <test_count>${input.points.length}</test_count>
  <test_points>${input.points.join(' ')}</test_points>
</cdf>
`;
}
