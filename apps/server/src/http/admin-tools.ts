import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { outputMatches } from '../judge/pipeline.js';
import { runGenerator } from '../judge/generator.js';
import { runSandboxed } from '../judge/runner.js';
import { ensureCompiledProgram } from '../judge/compile-cache.js';
import { getAsset } from '../storage/repos/assets.js';
import {
  getProblem,
  listAllTestcases,
  replaceTestcases,
  type ProblemRow,
} from '../storage/repos/problems.js';

export interface AdminToolRouteOptions {
  db: DatabaseSync;
  config: Config;
  adminGuard: preHandlerHookHandler;
}

async function compileAsset(
  options: AdminToolRouteOptions,
  problemId: number,
  kind: 'generator' | 'std' | 'brute',
) {
  const asset = getAsset(options.db, problemId, kind);
  if (!asset || !asset.language) {
    return { ok: false as const, message: `missing compiled ${kind} source` };
  }
  const result = await ensureCompiledProgram({
    gxx: options.config.gxx,
    dataDir: options.config.dataDir,
    sourcePath: join(options.config.dataDir, asset.path),
    language: asset.language,
    includeDir: join(process.cwd(), 'vendor'),
    timeoutMs: 60_000,
  });
  if (!result.ok || !result.exe) {
    return { ok: false as const, message: result.message };
  }
  return { ok: true as const, exe: result.exe };
}

async function runProgram(
  options: AdminToolRouteOptions,
  problem: ProblemRow,
  exe: string,
  inputPath: string,
  workdir: string,
) {
  const stdoutFile = join(workdir, 'stdout.txt');
  const stderrFile = join(workdir, 'stderr.txt');
  const run = await runSandboxed({
    runner: options.config.runnerPath,
    exe,
    workdir,
    timeMs: problem.time_ms,
    wallMs: problem.time_ms + 3000,
    memoryMb: problem.memory_mb,
    processLimit: 1,
    stdinFile: inputPath,
    stdoutFile,
    stderrFile,
  });
  const output = readFileSync(stdoutFile, 'utf8');
  return { run, output, stderr: readFileSync(stderrFile, 'utf8') };
}

export function registerAdminToolRoutes(
  app: FastifyInstance,
  options: AdminToolRouteOptions,
): void {
  app.post<{
    Params: { id: string };
    Body: { count?: number; seedStart?: number; points?: number };
  }>('/api/admin/problems/:id/generate', { preHandler: options.adminGuard }, async (request, reply) => {
    const problemId = Number(request.params.id);
    const problem = getProblem(options.db, problemId);
    if (!problem) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });
    const count = Math.max(1, Math.min(Number(request.body?.count ?? 1), 100));
    const seedStart = Number(request.body?.seedStart ?? 1);
    const points = Math.max(1, Number(request.body?.points ?? 100));

    const generator = await compileAsset(options, problemId, 'generator');
    if (!generator.ok) {
      return reply.code(400).send({ ok: false, error: { code: 'GENERATOR', message: generator.message } });
    }
    const std = await compileAsset(options, problemId, 'std');
    if (!std.ok) {
      return reply.code(400).send({ ok: false, error: { code: 'STD', message: std.message } });
    }

    const tmpRoot = join(options.config.dataDir, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const workdir = mkdtempSync(join(tmpRoot, 'gen-'));
    const dataDir = join(options.config.dataDir, 'problems', String(problemId), 'data');
    mkdirSync(dataDir, { recursive: true });
    const generated: Array<{ seed: number; input: string; output: string }> = [];
    try {
      for (let i = 0; i < count; i++) {
        const seed = seedStart + i;
        const gen = await runGenerator({
          generator: generator.exe,
          seed,
          workdir: tmpRoot,
          timeMs: 10_000,
        });
        if (!gen.ok) {
          return reply.code(400).send({ ok: false, error: { code: 'GENERATE_FAILED', message: gen.message } });
        }
        const inputPath = join(dataDir, `generated-${seed}.in`);
        const outputPath = join(dataDir, `generated-${seed}.out`);
        writeFileSync(inputPath, gen.stdout);
        const run = await runProgram(options, problem, std.exe, inputPath, workdir);
        if (run.run.exitCode !== 0 || run.run.timedOut) {
          return reply.code(400).send({
            ok: false,
            error: { code: 'STD_FAILED', message: `std failed on seed ${seed}` },
          });
        }
        writeFileSync(outputPath, run.output);
        generated.push({
          seed,
          input: `problems/${problemId}/data/generated-${seed}.in`,
          output: `problems/${problemId}/data/generated-${seed}.out`,
        });
      }
      const existing = listAllTestcases(options.db, problemId)
        .filter((row) => !generated.some((item) => item.input === row.input_path))
        .map((row) => ({
          inputPath: row.input_path,
          outputPath: row.output_path,
          points: row.points,
          subtaskId: row.subtask_id,
          dependsOn: row.depends_on,
        }));
      replaceTestcases(options.db, problemId, [
        ...existing,
        ...generated.map((item) => ({
          inputPath: item.input,
          outputPath: item.output,
          points,
        })),
      ]);
      return reply.code(201).send({ ok: true, data: { generated, total: existing.length + generated.length } });
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  app.post<{
    Params: { id: string };
    Body: { rounds?: number; seedStart?: number };
  }>('/api/admin/problems/:id/stress', { preHandler: options.adminGuard }, async (request, reply) => {
    const problemId = Number(request.params.id);
    const problem = getProblem(options.db, problemId);
    if (!problem) return reply.code(404).send({ ok: false, error: { code: 'NOT_FOUND' } });

    const rounds = Math.max(1, Math.min(Number(request.body?.rounds ?? 20), 1000));
    const seedStart = Number(request.body?.seedStart ?? 1);
    const generator = await compileAsset(options, problemId, 'generator');
    const std = await compileAsset(options, problemId, 'std');
    const brute = await compileAsset(options, problemId, 'brute');
    if (!generator.ok) {
      return reply.code(400).send({ ok: false, error: { code: 'GENERATOR', message: generator.message } });
    }
    if (!std.ok) {
      return reply.code(400).send({ ok: false, error: { code: 'STD', message: std.message } });
    }
    if (!brute.ok) {
      return reply.code(400).send({ ok: false, error: { code: 'BRUTE', message: brute.message } });
    }
    const generatorExe = generator.exe;
    const stdExe = std.exe;
    const bruteExe = brute.exe;

    const tmpRoot = join(options.config.dataDir, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    try {
      let matched = 0;
      let skipped = 0;
      for (let i = 0; i < rounds; i++) {
        const seed = seedStart + i;
        const workdir = mkdtempSync(join(tmpRoot, 'stress-'));
        try {
          const gen = await runGenerator({ generator: generatorExe, seed, workdir, timeMs: 10_000 });
          if (!gen.ok) {
            return reply.code(400).send({ ok: false, error: { code: 'GENERATE_FAILED', message: gen.message } });
          }
          const inputPath = join(workdir, 'input.txt');
          writeFileSync(inputPath, gen.stdout);
          const stdRun = await runProgram(options, problem, stdExe, inputPath, workdir);
          const bruteRun = await runProgram(options, problem, bruteExe, inputPath, workdir);
          if (stdRun.run.exitCode !== 0 || bruteRun.run.exitCode !== 0) {
            skipped += 1;
            continue;
          }
          const stdPath = join(workdir, 'std.out');
          const brutePath = join(workdir, 'brute.out');
          writeFileSync(stdPath, stdRun.output);
          writeFileSync(brutePath, bruteRun.output);
          if (!outputMatches(stdPath, brutePath)) {
            const counterDir = join(
              options.config.dataDir,
              'problems',
              String(problemId),
              'stress',
              `seed-${seed}`,
            );
            mkdirSync(counterDir, { recursive: true });
            writeFileSync(join(counterDir, 'input.txt'), gen.stdout);
            writeFileSync(join(counterDir, 'std.out'), stdRun.output);
            writeFileSync(join(counterDir, 'brute.out'), bruteRun.output);
            return {
              ok: true,
              data: {
                passed: matched,
                skipped,
                total: rounds,
                mismatch: {
                  seed,
                  input: gen.stdout.slice(0, 4096),
                  stdOutput: stdRun.output.slice(0, 4096),
                  bruteOutput: bruteRun.output.slice(0, 4096),
                  path: `problems/${problemId}/stress/seed-${seed}`,
                },
              },
            };
          }
          matched += 1;
        } finally {
          rmSync(workdir, { recursive: true, force: true });
        }
      }
      return { ok: true, data: { passed: matched, skipped, total: rounds, mismatch: null } };
    } catch (err) {
      return reply.code(500).send({
        ok: false,
        error: { code: 'STRESS_FAILED', message: (err as Error).message },
      });
    }
  });
}
