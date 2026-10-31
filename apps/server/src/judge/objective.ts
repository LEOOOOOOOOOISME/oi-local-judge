import type { ObjectiveConfig, ObjectiveQuestion, Verdict } from '@oij/shared';

export interface ObjectiveAnswerInput {
  questionId: number;
  value: string | string[];
}

export interface ObjectiveGradeResult {
  testcaseId: number;
  verdict: Verdict;
  timeMs: number;
  memoryKb: number;
  score: number;
  message: string;
}

export interface ObjectiveGradeSummary {
  results: ObjectiveGradeResult[];
  score: number;
}

export function parseObjectiveConfig(json: string): ObjectiveConfig {
  try {
    const parsed = JSON.parse(json) as ObjectiveConfig;
    if (!parsed || !Array.isArray(parsed.questions)) return { questions: [] };
    return parsed;
  } catch {
    return { questions: [] };
  }
}

function normalizeText(value: string, question: ObjectiveQuestion): string {
  let result = question.ignoreWhitespace === false ? value.trim() : value.replace(/\s+/g, '');
  if (question.ignoreCase !== false) result = result.toLowerCase();
  return result;
}

function gradeQuestion(
  question: ObjectiveQuestion,
  value: string | string[] | undefined,
): { verdict: Verdict; score: number; message: string } {
  const answers = question.answers ?? [];
  if (value === undefined) {
    return { verdict: 'WA', score: 0, message: '未作答' };
  }
  if (question.kind === 'fill') {
    const expected = answers.map((answer) => normalizeText(answer, question));
    const actual = (Array.isArray(value) ? value : [value]).map((answer) =>
      normalizeText(String(answer), question),
    );
    const ok = actual.length > 0 && actual.every((answer) => expected.includes(answer));
    return ok
      ? { verdict: 'AC', score: question.points, message: '' }
      : { verdict: 'WA', score: 0, message: '答案不正确' };
  }

  const selected = (Array.isArray(value) ? value : [value]).map(String);
  if (question.kind === 'multiple') {
    const correct = new Set(answers);
    const chosen = new Set(selected);
    let correctChosen = 0;
    let wrongChosen = false;
    for (const key of chosen) {
      if (correct.has(key)) correctChosen += 1;
      else wrongChosen = true;
    }
    if (wrongChosen) return { verdict: 'WA', score: 0, message: '包含错误选项' };
    if (correctChosen === correct.size) {
      return { verdict: 'AC', score: question.points, message: '' };
    }
    if (question.partial) {
      const score = Math.round((question.points * correctChosen) / Math.max(1, correct.size));
      return { verdict: score > 0 ? 'PC' : 'WA', score, message: '部分正确' };
    }
    return { verdict: 'WA', score: 0, message: '答案不完整' };
  }

  // single / judge: exactly one value must match.
  const ok = selected.length === 1 && answers.includes(selected[0]);
  return ok
    ? { verdict: 'AC', score: question.points, message: '' }
    : { verdict: 'WA', score: 0, message: '答案不正确' };
}

export function gradeObjective(
  config: ObjectiveConfig,
  answers: ObjectiveAnswerInput[],
): ObjectiveGradeSummary {
  const byId = new Map<number, string | string[]>();
  for (const answer of answers) {
    if (answer && Number.isInteger(answer.questionId)) {
      byId.set(answer.questionId, answer.value);
    }
  }
  const results: ObjectiveGradeResult[] = config.questions.map((question) => {
    const graded = gradeQuestion(question, byId.get(question.id));
    return {
      testcaseId: question.id,
      verdict: graded.verdict,
      timeMs: 0,
      memoryKb: 0,
      score: graded.score,
      message: graded.message,
    };
  });
  return {
    results,
    score: results.reduce((sum, result) => sum + result.score, 0),
  };
}

export function parseObjectiveAnswers(code: string): ObjectiveAnswerInput[] {
  const parsed = JSON.parse(code) as { answers?: ObjectiveAnswerInput[] } | ObjectiveAnswerInput[];
  const answers = Array.isArray(parsed) ? parsed : parsed.answers;
  if (!Array.isArray(answers)) throw new Error('objective answers must be an array');
  return answers;
}
