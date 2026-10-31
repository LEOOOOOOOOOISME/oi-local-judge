import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import type { ProblemDetailDto, ProblemSummaryDto } from '@oij/shared';
import {
  createProblem,
  getProblem,
  getTestcases,
  listProblems,
  type ProblemRow,
} from '../storage/repos/problems.js';

const markdown = new MarkdownIt({ html: false, linkify: true });

interface ProblemJson {
  title: string;
  type: string;
  difficulty?: number | null;
  tags?: string[];
  timeMs: number;
  memoryMb: number;
  ioMode?: 'stdio' | 'file';
  inputFile?: string | null;
  outputFile?: string | null;
  statement?: string;
  statementHtml?: string;
  samples?: Array<{ input: string; output: string; explanation?: string }>;
  checker?: {
    mode?: 'builtin' | 'testlib' | 'lemon';
    source?: string;
    compare?: string;
  };
  testcases: Array<{ input: string; output: string; points: number; subtaskId?: number }>;
}

export function problemToSummary(row: ProblemRow): ProblemSummaryDto {
  return {
    id: row.id,
    title: row.title,
    type: row.type as ProblemSummaryDto['type'],
    difficulty: row.difficulty,
    tags: JSON.parse(row.tags_json) as string[],
    timeMs: row.time_ms,
    memoryMb: row.memory_mb,
  };
}

export function listProblemDtos(db: DatabaseSync): ProblemSummaryDto[] {
  return listProblems(db).map(problemToSummary);
}

export function getProblemDetail(db: DatabaseSync, id: number): ProblemDetailDto | null {
  const row = getProblem(db, id);
  if (!row) return null;
  return {
    ...problemToSummary(row),
    ioMode: row.io_mode as 'stdio' | 'file',
    inputFile: row.input_file,
    outputFile: row.output_file,
    checkerMode: row.checker_mode as 'builtin' | 'testlib' | 'lemon',
    compareMode: row.compare_mode,
    statementHtml: row.statement_html,
    samples: JSON.parse(row.samples_json) as ProblemDetailDto['samples'],
  };
}

export function importProblemDirectory(options: {
  db: DatabaseSync;
  config: Config;
  sourceDir: string;
}): number {
  const sourceDir = resolve(options.sourceDir);
  const manifestPath = join(sourceDir, 'problem.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`problem.json not found in ${sourceDir}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProblemJson;
  if (!manifest.title || !Array.isArray(manifest.testcases) || manifest.testcases.length === 0) {
    throw new Error('problem.json must contain title and at least one testcase');
  }
  for (const testcase of manifest.testcases) {
    if (!existsSync(join(sourceDir, testcase.input))) {
      throw new Error(`missing input file: ${testcase.input}`);
    }
    if (!existsSync(join(sourceDir, testcase.output))) {
      throw new Error(`missing answer file: ${testcase.output}`);
    }
  }
  const streamFile = (name: string | null | undefined): string | null => {
    if (!name) return null;
    if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
      throw new Error(`invalid file IO name: ${name}`);
    }
    return name;
  };
  const inputFile = streamFile(manifest.inputFile);
  const outputFile = streamFile(manifest.outputFile);
  if (manifest.ioMode === 'file' && (!inputFile || !outputFile)) {
    throw new Error('file IO problems require inputFile and outputFile');
  }
  const checkerMode = manifest.checker?.mode ?? 'builtin';
  if (checkerMode !== 'builtin') {
    if (!manifest.checker?.source || !existsSync(join(sourceDir, manifest.checker.source))) {
      throw new Error(`checker source not found: ${manifest.checker?.source ?? '(missing)'}`);
    }
  }

  const statementHtml =
    manifest.statementHtml ?? markdown.render(manifest.statement ?? `# ${manifest.title}\n`);

  const problemId = createProblem(options.db, {
    title: manifest.title,
    type: manifest.type,
    difficulty: manifest.difficulty ?? null,
    tags: manifest.tags ?? [],
    timeMs: manifest.timeMs,
    memoryMb: manifest.memoryMb,
    ioMode: manifest.ioMode ?? 'stdio',
    inputFile,
    outputFile,
    statementHtml,
    samples: manifest.samples ?? [],
    checkerMode,
    compareMode: manifest.checker?.compare ?? 'ignore-trailing',
    testcases: manifest.testcases.map((testcase) => ({
      inputPath: testcase.input,
      outputPath: testcase.output,
      points: testcase.points,
      subtaskId: testcase.subtaskId ?? null,
    })),
  });

  const destRoot = join(options.config.dataDir, 'problems', String(problemId), 'data');
  mkdirSync(destRoot, { recursive: true });
  const rows = getTestcases(options.db, problemId);
  const update = options.db.prepare(
    'UPDATE problem_testcases SET input_path = ?, output_path = ? WHERE id = ?',
  );
  rows.forEach((row, index) => {
    const testcase = manifest.testcases[index];
    const inputName = basename(testcase.input);
    const outputName = basename(testcase.output);
    copyFileSync(join(sourceDir, testcase.input), join(destRoot, inputName));
    copyFileSync(join(sourceDir, testcase.output), join(destRoot, outputName));
    update.run(
      `problems/${problemId}/data/${inputName}`,
      `problems/${problemId}/data/${outputName}`,
      row.id,
    );
  });

  if (checkerMode !== 'builtin' && manifest.checker?.source) {
    const srcDir = join(options.config.dataDir, 'problems', String(problemId), 'src');
    mkdirSync(srcDir, { recursive: true });
    const fileName = basename(manifest.checker.source);
    copyFileSync(join(sourceDir, manifest.checker.source), join(srcDir, fileName));
    options.db
      .prepare('UPDATE problems SET checker_path = ? WHERE id = ?')
      .run(`problems/${problemId}/src/${fileName}`, problemId);
  }

  return problemId;
}
