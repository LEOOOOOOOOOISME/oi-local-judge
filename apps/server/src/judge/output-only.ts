import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestcaseRow } from '../storage/repos/problems.js';

export interface OutputAnswer {
  testcaseId: number;
  value: string;
}

export function parseOutputAnswers(code: string, testcases: TestcaseRow[]): Map<number, string> {
  const trimmed = code.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return new Map(testcases.length === 1 ? [[testcases[0].id, code]] : []);
  }
  const parsed = JSON.parse(trimmed) as
    | { answers?: Array<{ testcaseId?: number; value?: unknown }> }
    | Array<{ testcaseId?: number; value?: unknown }>;
  const entries = Array.isArray(parsed) ? parsed : parsed.answers;
  if (!Array.isArray(entries)) throw new Error('answer payload must contain an answers array');
  const result = new Map<number, string>();
  for (const entry of entries) {
    if (Number.isInteger(entry.testcaseId) && typeof entry.value === 'string') {
      result.set(entry.testcaseId!, entry.value);
    }
  }
  return result;
}

export function writeAnswerFiles(
  answerRoot: string,
  testcases: TestcaseRow[],
  answers: Map<number, string>,
): Map<number, string> {
  mkdirSync(answerRoot, { recursive: true });
  const paths = new Map<number, string>();
  for (const testcase of testcases) {
    const path = join(answerRoot, `answer-${testcase.id}.txt`);
    writeFileSync(path, answers.get(testcase.id) ?? '', 'utf8');
    paths.set(testcase.id, path);
  }
  return paths;
}
