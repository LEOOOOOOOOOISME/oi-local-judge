import {
  DEFAULT_TOTAL_POINTS,
  validateDataPlan,
  type DataPlan,
} from './data-plan.js';
import type { GenerationCaseRow } from '../storage/repos/generation-jobs.js';

export type QualityGateName =
  | 'compile'
  | 'determinism'
  | 'readability'
  | 'size'
  | 'validator'
  | 'std'
  | 'time-margin'
  | 'memory-margin'
  | 'duplicates'
  | 'subtasks'
  | 'samples'
  | 'budget';

export type GateLevel = 'pass' | 'warn' | 'block';

export interface GateFinding {
  gate: QualityGateName;
  level: GateLevel;
  message: string;
  detail?: Record<string, unknown>;
}

export interface GateCaseSnapshot {
  groupId: string;
  caseIndex: number;
  seed: number;
  inputSha256: string | null;
  inputBytes: number;
  inputLines: number;
  inputUtf8Valid: boolean;
  outputBytes: number;
  outputLines: number;
  stdExitCode: number | null;
  stdTimeMs: number;
  stdMemoryKb: number;
  validatorOk: boolean | null;
}

export interface DeterminismCheck {
  groupId: string;
  caseIndex: number;
  firstSha256: string;
  secondSha256: string;
}

export interface GateSampleResult {
  sampleIndex: number;
  expectedOutput: string;
  actualOutput: string;
  exitCode: number;
}

export interface QualityGateInput {
  plan: DataPlan;
  cases: readonly GateCaseSnapshot[];
  compile: {
    generator: boolean;
    std: boolean;
    validator: boolean | null;
    checker: boolean | null;
  };
  hasValidator: boolean;
  requiresValidator: boolean;
  samples: readonly GateSampleResult[];
  determinism: readonly DeterminismCheck[];
  budget: {
    actualWallMs: number;
    maxWallMs: number;
    actualDiskBytes: number;
    maxDiskBytes: number;
  };
}

export interface QualityGateStats {
  totalCases: number;
  maxTimeMs: number;
  maxMemoryKb: number;
  duplicateInputCount: number;
  duplicateRate: number;
  totalDiskBytes: number;
}

export interface QualityGateReport {
  pass: boolean;
  findings: GateFinding[];
  stats: QualityGateStats;
}

function normalizeText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

function finding(
  gate: QualityGateName,
  level: GateLevel,
  message: string,
  detail?: Record<string, unknown>,
): GateFinding {
  return detail ? { gate, level, message, detail } : { gate, level, message };
}

function computeStats(cases: readonly GateCaseSnapshot[]): QualityGateStats {
  const hashes = new Map<string, number>();
  let maxTimeMs = 0;
  let maxMemoryKb = 0;
  let totalDiskBytes = 0;
  for (const row of cases) {
    maxTimeMs = Math.max(maxTimeMs, row.stdTimeMs);
    maxMemoryKb = Math.max(maxMemoryKb, row.stdMemoryKb);
    totalDiskBytes += row.inputBytes + row.outputBytes;
    if (row.inputSha256) {
      hashes.set(row.inputSha256, (hashes.get(row.inputSha256) ?? 0) + 1);
    }
  }
  const duplicateInputCount = [...hashes.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  return {
    totalCases: cases.length,
    maxTimeMs,
    maxMemoryKb,
    duplicateInputCount,
    duplicateRate: cases.length === 0 ? 0 : duplicateInputCount / cases.length,
    totalDiskBytes,
  };
}

export function toGateCaseSnapshot(row: GenerationCaseRow): GateCaseSnapshot {
  return {
    groupId: row.group_id,
    caseIndex: row.case_index,
    seed: row.seed,
    inputSha256: row.input_sha256,
    inputBytes: row.input_bytes,
    inputLines: row.input_lines,
    inputUtf8Valid: row.input_utf8 === 1,
    outputBytes: row.output_bytes,
    outputLines: row.output_lines,
    stdExitCode: row.std_exit_code,
    stdTimeMs: row.std_time_ms,
    stdMemoryKb: row.std_memory_kb,
    validatorOk: row.validator_ok === null ? null : row.validator_ok === 1,
  };
}

export function evaluateQualityGates(input: QualityGateInput): QualityGateReport {
  const findings: GateFinding[] = [];
  const { plan, cases } = input;
  const stats = computeStats(cases);

  if (!input.compile.generator) {
    findings.push(finding('compile', 'block', 'generator 未编译通过'));
  }
  if (!input.compile.std) {
    findings.push(finding('compile', 'block', 'std 未编译通过'));
  }
  if (input.hasValidator && input.compile.validator !== true) {
    findings.push(finding('compile', 'block', 'validator 未编译通过'));
  }
  if (input.compile.checker === false) {
    findings.push(finding('compile', 'block', 'checker 未编译通过'));
  }
  if (input.compile.generator && input.compile.std) {
    findings.push(finding('compile', 'pass', 'generator / std 编译通过'));
  }

  if (input.determinism.length !== cases.length) {
    findings.push(
      finding(
        'determinism',
        'block',
        `确定性复跑未覆盖全部测试点：${input.determinism.length}/${cases.length}`,
      ),
    );
  } else {
    const mismatch = input.determinism.find(
      (check) => check.firstSha256 !== check.secondSha256,
    );
    if (mismatch) {
      findings.push(
        finding(
          'determinism',
          'block',
          `同一 seed 两次生成 hash 不同：${mismatch.groupId}-${mismatch.caseIndex}`,
          { ...mismatch },
        ),
      );
    } else {
      findings.push(finding('determinism', 'pass', '所有测试点同 seed 输出一致'));
    }
  }

  const emptyCase = cases.find((row) => row.inputBytes === 0 || row.inputLines === 0);
  if (emptyCase) {
    findings.push(
      finding(
        'readability',
        'block',
        `输入为空：${emptyCase.groupId}-${emptyCase.caseIndex}`,
        { ...emptyCase },
      ),
    );
  }
  const invalidUtf8 = cases.find((row) => !row.inputUtf8Valid);
  if (invalidUtf8) {
    findings.push(
      finding(
        'readability',
        'block',
        `输入不是合法 UTF-8：${invalidUtf8.groupId}-${invalidUtf8.caseIndex}`,
      ),
    );
  }
  if (!emptyCase && !invalidUtf8) {
    findings.push(finding('readability', 'pass', '输入非空且为合法 UTF-8'));
  }

  const maxFileBytes = plan.limits.outputMb * 1024 * 1024;
  const oversized = cases.find(
    (row) => row.inputBytes > maxFileBytes || row.outputBytes > maxFileBytes,
  );
  if (oversized) {
    findings.push(
      finding(
        'size',
        'block',
        `单文件超过 ${plan.limits.outputMb} MB：${oversized.groupId}-${oversized.caseIndex}`,
      ),
    );
  } else {
    findings.push(finding('size', 'pass', '单文件大小在限制内'));
  }

  if (input.hasValidator) {
    const invalid = cases.find((row) => row.validatorOk !== true);
    if (invalid) {
      findings.push(
        finding(
          'validator',
          'block',
          `validator 未通过：${invalid.groupId}-${invalid.caseIndex}`,
        ),
      );
    } else {
      findings.push(finding('validator', 'pass', 'validator 全部通过'));
    }
  } else if (input.requiresValidator) {
    findings.push(
      finding(
        'validator',
        'block',
        'CF-like 或接受 Hack 的题目必须提供 validator',
      ),
    );
  } else {
    findings.push(
      finding(
        'validator',
        'warn',
        '未提供 validator，只能做格式/边界检查，语义约束未校验',
      ),
    );
  }

  const stdFailed = cases.find((row) => row.stdExitCode !== 0);
  if (stdFailed) {
    findings.push(
      finding(
        'std',
        'block',
        `std 非零退出：${stdFailed.groupId}-${stdFailed.caseIndex}`,
      ),
    );
  } else if (cases.length > 0) {
    findings.push(finding('std', 'pass', 'std 全部 exit 0'));
  } else {
    findings.push(finding('std', 'block', '没有测试点'));
  }

  const timeRatio = stats.maxTimeMs / plan.limits.timeMs;
  if (timeRatio > 0.8) {
    findings.push(
      finding('time-margin', 'block', `std 最大用时 ${stats.maxTimeMs}ms 超过时限 80%`, {
        ratio: timeRatio,
      }),
    );
  } else if (timeRatio > 0.5) {
    findings.push(
      finding('time-margin', 'warn', `std 最大用时 ${stats.maxTimeMs}ms 超过时限 50%`, {
        ratio: timeRatio,
      }),
    );
  } else {
    findings.push(finding('time-margin', 'pass', '时限余量充足'));
  }

  const memoryRatio = stats.maxMemoryKb / (plan.limits.memoryMb * 1024);
  if (memoryRatio > 0.8) {
    findings.push(
      finding(
        'memory-margin',
        'block',
        `std 峰值内存 ${stats.maxMemoryKb}KB 超过内存限制 80%`,
        { ratio: memoryRatio },
      ),
    );
  } else if (memoryRatio > 0.5) {
    findings.push(
      finding(
        'memory-margin',
        'warn',
        `std 峰值内存 ${stats.maxMemoryKb}KB 超过内存限制 50%`,
        { ratio: memoryRatio },
      ),
    );
  } else {
    findings.push(finding('memory-margin', 'pass', '内存余量充足'));
  }

  if (stats.duplicateRate > 0.1) {
    findings.push(
      finding(
        'duplicates',
        'block',
        `输入重复率 ${(stats.duplicateRate * 100).toFixed(1)}% 超过 10%`,
        { duplicateInputCount: stats.duplicateInputCount },
      ),
    );
  } else if (stats.duplicateRate > 0) {
    findings.push(
      finding(
        'duplicates',
        'warn',
        `存在 ${stats.duplicateInputCount} 个重复输入`,
        { duplicateInputCount: stats.duplicateInputCount },
      ),
    );
  } else {
    findings.push(finding('duplicates', 'pass', '输入无重复'));
  }

  const planValidation = validateDataPlan(plan, {
    totalPoints: DEFAULT_TOTAL_POINTS,
  });
  const coveredGroups = new Set(cases.map((row) => row.groupId));
  const missingGroup = plan.groups.find((group) => !coveredGroups.has(group.id));
  if (!planValidation.ok || missingGroup) {
    findings.push(
      finding(
        'subtasks',
        'block',
        missingGroup
          ? `子任务 ${missingGroup.id} 没有测试点`
          : planValidation.issues.find((entry) => entry.severity === 'error')?.message ??
            '子任务配置非法',
      ),
    );
  } else {
    findings.push(finding('subtasks', 'pass', '子任务分值、覆盖与依赖合法'));
  }

  if (input.samples.length === 0) {
    findings.push(finding('samples', 'warn', '题面没有样例，无法做样例门禁'));
  } else {
    const sampleFailure = input.samples.find(
      (sample) =>
        sample.exitCode !== 0 ||
        normalizeText(sample.actualOutput) !== normalizeText(sample.expectedOutput),
    );
    if (sampleFailure) {
      findings.push(
        finding(
          'samples',
          'block',
          `样例 ${sampleFailure.sampleIndex + 1} 输出不一致`,
          { ...sampleFailure },
        ),
      );
    } else {
      findings.push(finding('samples', 'pass', '样例输入/输出一致'));
    }
  }

  if (
    input.budget.actualWallMs > input.budget.maxWallMs ||
    input.budget.actualDiskBytes > input.budget.maxDiskBytes
  ) {
    findings.push(
      finding('budget', 'block', '生成总时长或磁盘占用超过预算', {
        actualWallMs: input.budget.actualWallMs,
        maxWallMs: input.budget.maxWallMs,
        actualDiskBytes: input.budget.actualDiskBytes,
        maxDiskBytes: input.budget.maxDiskBytes,
      }),
    );
  } else {
    findings.push(finding('budget', 'pass', '生成预算内'));
  }

  return {
    pass: !findings.some((entry) => entry.level === 'block'),
    findings,
    stats,
  };
}
