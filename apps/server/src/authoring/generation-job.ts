import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.js';
import { getAsset } from '../storage/repos/assets.js';
import { ensureCompiledProgram } from '../judge/compile-cache.js';
import { runSandboxed } from '../judge/runner.js';
import { runValidator } from '../judge/validator.js';
import {
  caseFileName,
  expandDataPlan,
  parseDataPlan,
  validateDataPlan,
  type DataPlan,
} from './data-plan.js';
import {
  runContractGenerator,
  type ContractGeneratorInput,
} from './generator-contract.js';
import {
  blockGenerationCases,
  createGenerationJob,
  getGenerationJob,
  listGenerationCases,
  requestGenerationCancel,
  updateGenerationCase,
  updateGenerationJob,
  type GenerationCaseRow,
  type GenerationJobRow,
} from '../storage/repos/generation-jobs.js';

export type GenerationAssetKind = 'generator' | 'std' | 'validator';

export interface CompileOutcome {
  ok: boolean;
  exe?: string;
  message: string;
}

export interface GenerateOutcome {
  ok: boolean;
  stdout: string;
  stderr: string;
  message: string;
}

export interface StdRunInput {
  exe: string;
  inputPath: string;
  outputPath: string;
  workdir: string;
  timeMs: number;
  memoryMb: number;
  wallMs: number;
  outputLimitBytes: number;
}

export interface StdOutcome {
  ok: boolean;
  exitCode: number;
  cpuMs: number;
  peakMemKb: number;
  timedOut: boolean;
  message: string;
}

export interface ValidatorOutcome {
  ok: boolean;
  message: string;
}

export interface GenerationRuntime {
  compile(kind: GenerationAssetKind): Promise<CompileOutcome>;
  generate(input: ContractGeneratorInput): Promise<GenerateOutcome>;
  runStd(input: StdRunInput): Promise<StdOutcome>;
  validate(input: {
    exe: string;
    inputPath: string;
    workdir: string;
    timeMs?: number;
  }): Promise<ValidatorOutcome>;
}

export interface DefaultRuntimeOptions {
  db: DatabaseSync;
  config: Config;
  problemId: number;
  includeDir?: string;
}

export function createDefaultGenerationRuntime(
  options: DefaultRuntimeOptions,
): GenerationRuntime {
  const includeDir = options.includeDir ?? join(process.cwd(), 'vendor');
  return {
    async compile(kind) {
      const asset = getAsset(options.db, options.problemId, kind);
      if (!asset || !asset.language) {
        return { ok: false, message: `missing compiled ${kind} source` };
      }
      const result = await ensureCompiledProgram({
        gxx: options.config.gxx,
        dataDir: options.config.dataDir,
        sourcePath: join(options.config.dataDir, asset.path),
        language: asset.language,
        includeDir,
        timeoutMs: 60_000,
      });
      return { ok: result.ok, exe: result.exe, message: result.message };
    },
    async generate(input) {
      const result = await runContractGenerator(input);
      return {
        ok: result.ok,
        stdout: result.stdout,
        stderr: result.stderr,
        message: result.message,
      };
    },
    async runStd(input) {
      const stderrFile = join(input.workdir, 'std.stderr.txt');
      try {
        const run = await runSandboxed({
          runner: options.config.runnerPath,
          exe: input.exe,
          workdir: input.workdir,
          timeMs: input.timeMs,
          wallMs: input.wallMs,
          memoryMb: input.memoryMb,
          processLimit: 1,
          stdinFile: input.inputPath,
          stdoutFile: input.outputPath,
          stderrFile,
        });
        const ok =
          run.exitCode === 0 &&
          !run.timedOut &&
          !run.oom &&
          run.stdoutBytes <= input.outputLimitBytes;
        const reason = run.oom
          ? 'std 超出内存限制'
          : run.timedOut
            ? 'std 超时'
            : run.exitCode !== 0
              ? `std 退出码 ${run.exitCode}`
              : run.stdoutBytes > input.outputLimitBytes
                ? 'std 输出超过限制'
                : 'ok';
        return {
          ok,
          exitCode: run.exitCode,
          cpuMs: run.cpuMs,
          peakMemKb: run.peakMemKb,
          timedOut: run.timedOut || run.oom,
          message: reason,
        };
      } catch (error) {
        return {
          ok: false,
          exitCode: -1,
          cpuMs: 0,
          peakMemKb: 0,
          timedOut: false,
          message: (error as Error).message,
        };
      }
    },
    async validate(input) {
      const result = await runValidator({
        validator: input.exe,
        input: input.inputPath,
        workdir: input.workdir,
        timeMs: input.timeMs,
      });
      return { ok: result.ok, message: result.message };
    },
  };
}

export interface StartGenerationOptions {
  db: DatabaseSync;
  config: Config;
  problemId: number;
  plan: DataPlan;
  planVersion: number;
  createdBy?: number | null;
  runtime?: GenerationRuntime;
  now?: () => number;
  schedule?: (task: () => void) => void;
}

export interface StartGenerationResult {
  id: number;
  total: number;
}

export interface RunGenerationJobOptions {
  db: DatabaseSync;
  config: Config;
  problemId: number;
  jobId: number;
  runtime?: GenerationRuntime;
  now?: () => number;
  maxWallMs?: number;
  includeDir?: string;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split(/\r?\n/);
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

function isUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

function relativeDataPath(dataDir: string, absolute: string): string {
  return relative(dataDir, absolute).replace(/\\/g, '/');
}

function jobWorkdir(dataDir: string, problemId: number, jobId: number): string {
  return join(dataDir, 'problems', String(problemId), 'authoring', 'jobs', String(jobId));
}

function summarizeCases(cases: readonly GenerationCaseRow[]) {
  const hashes = new Map<string, number>();
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  let totalDiskBytes = 0;
  for (const row of cases) {
    maxTimeMs = Math.max(maxTimeMs, row.std_time_ms);
    maxMemoryKb = Math.max(maxMemoryKb, row.std_memory_kb);
    totalDiskBytes += row.input_bytes + row.output_bytes;
    if (row.input_sha256) {
      hashes.set(row.input_sha256, (hashes.get(row.input_sha256) ?? 0) + 1);
    }
  }
  const duplicateInputCount = [...hashes.values()].filter((count) => count > 1).reduce(
    (sum, count) => sum + count,
    0,
  );
  return {
    totalCases: cases.length,
    maxTimeMs,
    maxMemoryKb,
    totalDiskBytes,
    duplicateInputCount,
    duplicateRate: cases.length === 0 ? 0 : duplicateInputCount / cases.length,
  };
}

function failJob(
  db: DatabaseSync,
  jobId: number,
  message: string,
  now: number,
): GenerationJobRow {
  blockGenerationCases(db, jobId, message, now);
  updateGenerationJob(db, jobId, {
    status: 'failed',
    message,
    finishedAt: now,
    heartbeatAt: now,
  });
  return getGenerationJob(db, jobId)!;
}

function failCase(
  db: DatabaseSync,
  caseId: number,
  message: string,
  now: number,
  extra: Parameters<typeof updateGenerationCase>[2] = {},
): void {
  updateGenerationCase(db, caseId, {
    status: 'failed',
    message,
    finishedAt: now,
    ...extra,
  });
}

export function startGenerationJob(
  options: StartGenerationOptions,
): StartGenerationResult {
  const validated = validateDataPlan(options.plan, { totalPoints: 100 });
  if (!validated.ok || !validated.plan) {
    const message = validated.issues
      .filter((entry) => entry.severity === 'error')
      .map((entry) => entry.message)
      .join('; ');
    throw new Error(message || 'invalid data plan');
  }
  const plan = validated.plan;
  const expanded = expandDataPlan(plan);
  const now = options.now ?? Date.now;
  const jobId = createGenerationJob(options.db, {
    problemId: options.problemId,
    planVersion: options.planVersion,
    planJson: JSON.stringify(plan),
    cases: expanded.map((item) => ({
      groupId: item.groupId,
      groupName: item.groupName,
      index: item.index,
      seed: item.seed,
    })),
    createdBy: options.createdBy ?? null,
    now: now(),
  });
  const runtime =
    options.runtime ??
    createDefaultGenerationRuntime({
      db: options.db,
      config: options.config,
      problemId: options.problemId,
    });
  const schedule = options.schedule ?? ((task: () => void) => setImmediate(task));
  schedule(() => {
    void runGenerationJob({
      db: options.db,
      config: options.config,
      problemId: options.problemId,
      jobId,
      runtime,
      now,
    }).catch((error) => {
      failJob(options.db, jobId, (error as Error).message, now());
    });
  });
  return { id: jobId, total: expanded.length };
}

export async function runGenerationJob(
  options: RunGenerationJobOptions,
): Promise<GenerationJobRow> {
  const { db, problemId, jobId } = options;
  const now = options.now ?? Date.now;
  const existing = getGenerationJob(db, jobId);
  if (!existing || existing.problem_id !== problemId) {
    throw new Error(`generation job ${jobId} not found`);
  }
  if (existing.status !== 'queued' && existing.status !== 'running') {
    return existing;
  }

  updateGenerationJob(db, jobId, {
    status: 'running',
    startedAt: existing.started_at ?? now(),
    message: '编译 generator / std / validator',
    heartbeatAt: now(),
  });

  const parsed = parseDataPlan(existing.plan_json, { totalPoints: 100 });
  if (!parsed.ok || !parsed.plan) {
    return failJob(db, jobId, '数据计划无效', now());
  }
  const plan = parsed.plan;
  const runtime =
    options.runtime ??
    createDefaultGenerationRuntime({
      db,
      config: options.config,
      problemId,
      includeDir: options.includeDir,
    });

  let generatorExe = '';
  let stdExe = '';
  let validatorExe: string | null = null;
  try {
    const generator = await runtime.compile('generator');
    if (!generator.ok || !generator.exe) {
      return failJob(db, jobId, `generator 编译失败：${generator.message}`, now());
    }
    generatorExe = generator.exe;

    const std = await runtime.compile('std');
    if (!std.ok || !std.exe) {
      return failJob(db, jobId, `std 编译失败：${std.message}`, now());
    }
    stdExe = std.exe;

    if (getAsset(db, problemId, 'validator')) {
      const validator = await runtime.compile('validator');
      if (!validator.ok || !validator.exe) {
        return failJob(
          db,
          jobId,
          `validator 编译失败：${validator.message}`,
          now(),
        );
      }
      validatorExe = validator.exe;
    }
  } catch (error) {
    return failJob(db, jobId, `编译阶段异常：${(error as Error).message}`, now());
  }

  const workdir = jobWorkdir(options.config.dataDir, problemId, jobId);
  mkdirSync(workdir, { recursive: true });
  const outputLimitBytes = plan.limits.outputMb * 1024 * 1024;
  const maxWallMs = options.maxWallMs ?? 30 * 60 * 1000;
  const startedAt = now();
  const groupById = new Map(plan.groups.map((group) => [group.id, group]));
  const cases = listGenerationCases(db, jobId);

  for (const row of cases) {
    const latest = getGenerationJob(db, jobId);
    if (latest?.status === 'canceled') {
      return latest;
    }
    if (now() - startedAt > maxWallMs) {
      return failJob(db, jobId, '生成总时长超过预算', now());
    }

    updateGenerationCase(db, row.id, { status: 'running', startedAt: now() });
    updateGenerationJob(db, jobId, {
      heartbeatAt: now(),
      message: `生成 ${row.group_id}-${row.case_index}（seed ${row.seed}）`,
    });

    const fileName = caseFileName(plan, row.group_id, row.case_index);
    const inputPath = join(workdir, fileName);
    const outputPath = join(workdir, fileName.replace(/\.in$/, '.out'));
    const inputRel = relativeDataPath(options.config.dataDir, inputPath);
    const outputRel = relativeDataPath(options.config.dataDir, outputPath);
    const group = groupById.get(row.group_id);

    let generated: GenerateOutcome;
    try {
      generated = await runtime.generate({
        generator: generatorExe,
        seed: row.seed,
        groupId: row.group_id,
        index: row.case_index,
        args: group?.args ?? [],
        workdir,
        timeMs: 10_000,
        maxStdoutBytes: outputLimitBytes,
      });
    } catch (error) {
      failCase(db, row.id, `generator 异常：${(error as Error).message}`, now());
      continue;
    }
    if (!generated.ok) {
      failCase(db, row.id, `generator 失败：${generated.message}`, now());
      continue;
    }

    const inputBuffer = Buffer.from(generated.stdout, 'utf8');
    if (inputBuffer.length === 0) {
      failCase(db, row.id, 'generator 输出为空', now());
      continue;
    }
    if (inputBuffer.length > outputLimitBytes) {
      failCase(
        db,
        row.id,
        `generator 输出超过限制 ${plan.limits.outputMb} MB`,
        now(),
      );
      continue;
    }
    writeFileSync(inputPath, inputBuffer);
    const inputSha256 = createHash('sha256').update(inputBuffer).digest('hex');
    const inputStats = {
      inputPath: inputRel,
      inputSha256,
      inputBytes: inputBuffer.length,
      inputLines: countLines(generated.stdout),
      inputUtf8: isUtf8(inputBuffer) ? 1 : 0,
    };

    let stdRun: StdOutcome;
    try {
      stdRun = await runtime.runStd({
        exe: stdExe,
        inputPath,
        outputPath,
        workdir,
        timeMs: plan.limits.timeMs,
        memoryMb: plan.limits.memoryMb,
        wallMs: plan.limits.timeMs + 3000,
        outputLimitBytes,
      });
    } catch (error) {
      failCase(
        db,
        row.id,
        `std 异常：${(error as Error).message}`,
        now(),
        inputStats,
      );
      continue;
    }
    if (!stdRun.ok) {
      failCase(db, row.id, `std 失败：${stdRun.message}`, now(), {
        ...inputStats,
        outputPath: outputRel,
        stdExitCode: stdRun.exitCode,
        stdTimeMs: stdRun.cpuMs,
        stdMemoryKb: stdRun.peakMemKb,
      });
      continue;
    }

    const outputText = readFileSync(outputPath, 'utf8');
    let validatorOk: number | null = null;
    let validatorMessage = '';
    if (validatorExe) {
      try {
        const validator = await runtime.validate({
          exe: validatorExe,
          inputPath,
          workdir,
          timeMs: 10_000,
        });
        validatorOk = validator.ok ? 1 : 0;
        validatorMessage = validator.message;
        if (!validator.ok) {
          failCase(db, row.id, `validator 失败：${validator.message}`, now(), {
            ...inputStats,
            outputPath: outputRel,
            outputBytes: Buffer.byteLength(outputText),
            outputLines: countLines(outputText),
            stdExitCode: stdRun.exitCode,
            stdTimeMs: stdRun.cpuMs,
            stdMemoryKb: stdRun.peakMemKb,
            validatorOk,
            validatorMessage,
          });
          continue;
        }
      } catch (error) {
        failCase(
          db,
          row.id,
          `validator 异常：${(error as Error).message}`,
          now(),
          inputStats,
        );
        continue;
      }
    }

    updateGenerationCase(db, row.id, {
      status: 'finished',
      ...inputStats,
      outputPath: outputRel,
      outputBytes: Buffer.byteLength(outputText),
      outputLines: countLines(outputText),
      stdExitCode: stdRun.exitCode,
      stdTimeMs: stdRun.cpuMs,
      stdMemoryKb: stdRun.peakMemKb,
      validatorOk,
      validatorMessage,
      message: '',
      finishedAt: now(),
    });
  }

  const refreshed = listGenerationCases(db, jobId);
  const latest = getGenerationJob(db, jobId);
  if (latest?.status === 'canceled') {
    return latest;
  }
  const failed = refreshed.filter(
    (row) => row.status === 'failed' || row.status === 'blocked',
  ).length;
  const completed = refreshed.filter((row) => row.status === 'finished').length;
  const stats = summarizeCases(refreshed);
  updateGenerationJob(db, jobId, {
    status: failed > 0 ? 'failed' : 'finished',
    completed,
    failed,
    statsJson: JSON.stringify(stats),
    message: failed > 0 ? `${failed} 个测试点失败` : '生成完成',
    finishedAt: now(),
    heartbeatAt: now(),
  });
  return getGenerationJob(db, jobId)!;
}

export function cancelGenerationJob(db: DatabaseSync, jobId: number): boolean {
  return requestGenerationCancel(db, jobId, Date.now());
}
