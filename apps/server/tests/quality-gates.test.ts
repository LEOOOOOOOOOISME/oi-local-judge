import { describe, expect, it } from 'vitest';
import {
  DATA_PLAN_SCHEMA,
  type DataPlan,
} from '../src/authoring/data-plan.js';
import {
  evaluateQualityGates,
  type GateCaseSnapshot,
  type QualityGateInput,
} from '../src/authoring/quality-gates.js';

function plan(overrides: Partial<DataPlan> = {}): DataPlan {
  return {
    schema: DATA_PLAN_SCHEMA,
    limits: { timeMs: 1000, memoryMb: 256, outputMb: 64 },
    groups: [
      {
        id: 'sub1',
        name: '基础',
        points: 50,
        count: 1,
        seedStart: 1,
        args: [],
        dependsOn: [],
      },
      {
        id: 'sub2',
        name: '大',
        points: 50,
        count: 2,
        seedStart: 101,
        args: [],
        dependsOn: [],
      },
    ],
    pointsMode: 'group',
    naming: '{group}-{index}',
    ...overrides,
  };
}

function gateCase(overrides: Partial<GateCaseSnapshot> = {}): GateCaseSnapshot {
  return {
    groupId: 'sub1',
    caseIndex: 1,
    seed: 1,
    inputSha256: 'a'.repeat(64),
    inputBytes: 12,
    inputLines: 2,
    inputUtf8Valid: true,
    outputBytes: 12,
    outputLines: 2,
    stdExitCode: 0,
    stdTimeMs: 100,
    stdMemoryKb: 1024,
    validatorOk: true,
    ...overrides,
  };
}

function cases(): GateCaseSnapshot[] {
  return [
    gateCase(),
    gateCase({ groupId: 'sub2', caseIndex: 1, seed: 101, inputSha256: 'b'.repeat(64) }),
    gateCase({ groupId: 'sub2', caseIndex: 2, seed: 102, inputSha256: 'c'.repeat(64) }),
  ];
}

function input(overrides: Partial<QualityGateInput> = {}): QualityGateInput {
  const rows = overrides.cases ?? cases();
  return {
    plan: plan(),
    cases: rows,
    compile: { generator: true, std: true, validator: true, checker: null },
    hasValidator: true,
    requiresValidator: true,
    samples: [
      {
        sampleIndex: 0,
        expectedOutput: '6\n',
        actualOutput: '6',
        exitCode: 0,
      },
    ],
    determinism: rows.map((row) => ({
      groupId: row.groupId,
      caseIndex: row.caseIndex,
      firstSha256: row.inputSha256 ?? '',
      secondSha256: row.inputSha256 ?? '',
    })),
    budget: {
      actualWallMs: 1000,
      maxWallMs: 60_000,
      actualDiskBytes: 1000,
      maxDiskBytes: 1024 * 1024 * 1024,
    },
    ...overrides,
  };
}

function blocked(report: ReturnType<typeof evaluateQualityGates>, gate: string): boolean {
  return report.findings.some(
    (finding) => finding.gate === gate && finding.level === 'block',
  );
}

describe('quality gates', () => {
  it('passes a complete report', () => {
    const report = evaluateQualityGates(input());
    expect(report.pass, JSON.stringify(report.findings)).toBe(true);
    expect(report.findings.some((finding) => finding.level === 'block')).toBe(false);
    expect(report.stats.totalCases).toBe(3);
  });

  it('blocks on a determinism mismatch', () => {
    const rows = cases();
    const report = evaluateQualityGates(
      input({
        determinism: rows.map((row, index) =>
          index === 0
            ? {
                groupId: row.groupId,
                caseIndex: row.caseIndex,
                firstSha256: 'a'.repeat(64),
                secondSha256: 'd'.repeat(64),
              }
            : {
                groupId: row.groupId,
                caseIndex: row.caseIndex,
                firstSha256: row.inputSha256 ?? '',
                secondSha256: row.inputSha256 ?? '',
              },
        ),
      }),
    );
    expect(blocked(report, 'determinism')).toBe(true);
  });

  it('blocks when std is over 80% of the time limit, warns between 50% and 80%', () => {
    const slow = evaluateQualityGates(
      input({
        cases: [gateCase({ stdTimeMs: 900 }), ...cases().slice(1)],
      }),
    );
    expect(blocked(slow, 'time-margin')).toBe(true);

    const warn = evaluateQualityGates(
      input({
        cases: [gateCase({ stdTimeMs: 600 }), ...cases().slice(1)],
      }),
    );
    expect(blocked(warn, 'time-margin')).toBe(false);
    expect(
      warn.findings.some(
        (finding) => finding.gate === 'time-margin' && finding.level === 'warn',
      ),
    ).toBe(true);
  });

  it('blocks when input hashes repeat more than 10%', () => {
    const rows = [
      gateCase({ inputSha256: 'x'.repeat(64) }),
      gateCase({
        groupId: 'sub2',
        caseIndex: 1,
        seed: 101,
        inputSha256: 'x'.repeat(64),
      }),
      gateCase({
        groupId: 'sub2',
        caseIndex: 2,
        seed: 102,
        inputSha256: 'y'.repeat(64),
      }),
    ];
    const report = evaluateQualityGates(input({ cases: rows }));
    expect(blocked(report, 'duplicates')).toBe(true);
  });

  it('blocks a CF-like/Hack problem without a validator, warns an ordinary problem', () => {
    const hack = evaluateQualityGates(
      input({
        hasValidator: false,
        requiresValidator: true,
        compile: { generator: true, std: true, validator: null, checker: null },
      }),
    );
    expect(blocked(hack, 'validator')).toBe(true);

    const ordinary = evaluateQualityGates(
      input({
        hasValidator: false,
        requiresValidator: false,
        compile: { generator: true, std: true, validator: null, checker: null },
      }),
    );
    expect(blocked(ordinary, 'validator')).toBe(false);
    expect(
      ordinary.findings.some(
        (finding) => finding.gate === 'validator' && finding.level === 'warn',
      ),
    ).toBe(true);
  });

  it('blocks an invalid subtask points/dependency plan', () => {
    const badPlan = plan();
    badPlan.groups[0].points = 40;
    const report = evaluateQualityGates(input({ plan: badPlan }));
    expect(blocked(report, 'subtasks')).toBe(true);
  });

  it('blocks a sample output mismatch', () => {
    const report = evaluateQualityGates(
      input({
        samples: [
          {
            sampleIndex: 0,
            expectedOutput: '6\n',
            actualOutput: '7\n',
            exitCode: 0,
          },
        ],
      }),
    );
    expect(blocked(report, 'samples')).toBe(true);
  });

  it('blocks empty input, missing validator results and budget overflow', () => {
    const empty = evaluateQualityGates(
      input({ cases: [gateCase({ inputBytes: 0, inputLines: 0 }), ...cases().slice(1)] }),
    );
    expect(blocked(empty, 'readability')).toBe(true);

    const validatorFail = evaluateQualityGates(
      input({
        cases: [gateCase({ validatorOk: false }), ...cases().slice(1)],
      }),
    );
    expect(blocked(validatorFail, 'validator')).toBe(true);

    const budget = evaluateQualityGates(
      input({
        budget: {
          actualWallMs: 60_001,
          maxWallMs: 60_000,
          actualDiskBytes: 1000,
          maxDiskBytes: 1024,
        },
      }),
    );
    expect(blocked(budget, 'budget')).toBe(true);
  });

  it('blocks when a group has no cases', () => {
    const report = evaluateQualityGates(
      input({ cases: [gateCase()] }),
    );
    expect(blocked(report, 'subtasks')).toBe(true);
  });
});
