import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import type { ProblemDetailDto, ProblemSummaryDto } from '@oij/shared';
import {
  ASSET_KINDS,
  upsertAsset,
} from '../storage/repos/assets.js';
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
  objective?: { questions?: unknown[] };
  assets?: Record<string, string>;
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

/**
 * Older seed/import versions stored `data/1.in` instead of
 * `problems/<id>/data/1.in` in problem_testcases. The files were copied to the
 * problem folder, so rewrite the DB paths to the canonical location when the
 * target file exists. Safe to run on every startup.
 */
export function repairLegacyTestcasePaths(db: DatabaseSync, dataDir: string): number {
  const rows = db
    .prepare('SELECT id, problem_id, input_path, output_path FROM problem_testcases')
    .all() as unknown as Array<{
    id: number;
    problem_id: number;
    input_path: string;
    output_path: string;
  }>;
  const update = db.prepare(
    'UPDATE problem_testcases SET input_path = ?, output_path = ? WHERE id = ?',
  );
  let repaired = 0;
  for (const row of rows) {
    const prefix = `problems/${row.problem_id}/`;
    const canonical = (value: string): string => {
      if (value.startsWith(prefix)) return value;
      const candidate = `${prefix}data/${basename(value)}`;
      return existsSync(join(dataDir, candidate)) ? candidate : value;
    };
    const inputPath = canonical(row.input_path);
    const outputPath = canonical(row.output_path);
    if (inputPath !== row.input_path || outputPath !== row.output_path) {
      update.run(inputPath, outputPath, row.id);
      repaired += 1;
    }
  }
  return repaired;
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
    visibility: row.visibility,
    statementHtml: row.statement_html,
    samples: JSON.parse(row.samples_json) as ProblemDetailDto['samples'],
    objective: (() => {
      const parsed = JSON.parse(row.objective_json) as ProblemDetailDto['objective'];
      return parsed && Array.isArray(parsed.questions) ? parsed : undefined;
    })(),
  };
}

/** Removes correct answers before exposing a problem to contestants. */
export function stripObjectiveAnswers(
  problem: ProblemDetailDto,
): ProblemDetailDto {
  if (!problem.objective || !Array.isArray(problem.objective.questions)) {
    return problem;
  }
  return {
    ...problem,
    objective: {
      questions: problem.objective.questions.map((question) => {
        const { answers: _answers, ...rest } = question;
        return rest;
      }),
    },
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
  const isObjective = manifest.type === 'objective';
  if (!manifest.title || (isObjective
    ? !Array.isArray(manifest.objective?.questions) || (manifest.objective?.questions?.length ?? 0) === 0
    : !Array.isArray(manifest.testcases) || manifest.testcases.length === 0)) {
    throw new Error(
      isObjective
        ? 'objective problem.json must contain objective.questions'
        : 'problem.json must contain title and at least one testcase',
    );
  }
  for (const testcase of manifest.testcases ?? []) {    if (!existsSync(join(sourceDir, testcase.input))) {
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
    objective: manifest.objective,
    testcases: (manifest.testcases ?? []).map((testcase) => ({
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

  const assetsRoot = join(options.config.dataDir, 'problems', String(problemId), 'src');
  for (const [kind, relative] of Object.entries(manifest.assets ?? {})) {
    if (!(ASSET_KINDS as readonly string[]).includes(kind)) continue;
    const sourcePath = join(sourceDir, relative);
    if (!existsSync(sourcePath)) continue;
    mkdirSync(assetsRoot, { recursive: true });
    const fileName = `${kind}-${basename(relative)}`;
    const destination = join(assetsRoot, fileName);
    copyFileSync(sourcePath, destination);
    const extension = basename(relative).slice(basename(relative).lastIndexOf('.'));
    const language =
      extension === '.cpp' || extension === '.cc' || extension === '.cxx'
        ? 'cpp17'
        : extension === '.c'
          ? 'c11'
          : extension === '.py'
            ? 'python'
            : null;
    upsertAsset(options.db, {
      problemId,
      kind: kind as (typeof ASSET_KINDS)[number],
      name: basename(relative),
      path: `problems/${problemId}/src/${fileName}`,
      language,
      sha256: createHash('sha256').update(readFileSync(destination)).digest('hex'),
      size: statSync(destination).size,
    });
    if (kind === 'checker') {
      options.db
        .prepare('UPDATE problems SET checker_path = ?, checker_mode = ? WHERE id = ?')
        .run(`problems/${problemId}/src/${fileName}`, checkerMode === 'builtin' ? 'testlib' : checkerMode, problemId);
    }
  }

  return problemId;
}
