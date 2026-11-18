import type {
  ObjectiveAnswer,
  ObjectiveAnswerValue,
  ObjectiveOption,
  ObjectiveQuestion,
  ObjectiveQuestionKind,
} from '../api/types';

export const OBJECTIVE_KIND_LABEL: Record<ObjectiveQuestionKind, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  fill: '填空',
};

/** 判断题没有 options，固定用 true / false 作为答案值。 */
const JUDGE_OPTIONS: ObjectiveOption[] = [
  { key: 'true', text: '正确' },
  { key: 'false', text: '错误' },
];

export function objectiveQuestionOptions(question: ObjectiveQuestion): ObjectiveOption[] {
  if (question.kind === 'judge') return JUDGE_OPTIONS;
  return question.options ?? [];
}

/** 空字符串、纯空白、空数组都视为“未作答”。 */
export function isObjectiveAnswerAnswered(
  value: ObjectiveAnswerValue | undefined | null,
): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) {
    return value.some((item) => String(item).trim().length > 0);
  }
  return String(value).trim().length > 0;
}

export function countAnsweredObjective(
  questions: ObjectiveQuestion[],
  answers: Record<number, ObjectiveAnswerValue>,
): number {
  return questions.reduce(
    (count, question) => count + (isObjectiveAnswerAnswered(answers[question.id]) ? 1 : 0),
    0,
  );
}

/**
 * 提交 payload 只包含真正作答的题目，保持原来的 `{ answers: [{ questionId, value }] }`
 * 结构（序列化由调用方负责），空答案不会被送到后端。
 */
export function toObjectiveAnswerPayload(
  questions: ObjectiveQuestion[],
  answers: Record<number, ObjectiveAnswerValue>,
): ObjectiveAnswer[] {
  const payload: ObjectiveAnswer[] = [];
  for (const question of questions) {
    const value = answers[question.id];
    if (!isObjectiveAnswerAnswered(value)) continue;
    payload.push({
      questionId: question.id,
      value: Array.isArray(value)
        ? value.filter((item) => String(item).trim().length > 0)
        : value,
    });
  }
  return payload;
}

export interface ObjectiveQuestionVisibility {
  id: number;
  /** 卡片顶部相对视口的位置；滚动到视口上方的卡片为负值。 */
  top: number;
}

/**
 * 从当前可见的题目中选出“最接近视口顶部”的一题，用于滚动时同步答题卡当前题。
 *
 * 传入的应是 IntersectionObserver 判定为可见的卡片（已经按阅读区域裁剪过），
 * 这里按 top 最小者选取：即当前占据阅读线的那道题。没有可见题时返回 null，
 * 调用方应保持现有当前题不变。
 */
export function pickScrollActiveObjectiveId(
  visibleQuestions: readonly ObjectiveQuestionVisibility[],
): number | null {
  let best: ObjectiveQuestionVisibility | null = null;
  for (const item of visibleQuestions) {
    if (!Number.isFinite(item.top)) continue;
    if (best === null || item.top < best.top) best = item;
  }
  return best?.id ?? null;
}

export type ObjectiveNavStatus = 'current' | 'answered' | 'blank';

export interface ObjectiveNavItem {
  id: number;
  /** 题号，从 1 开始。 */
  index: number;
  answered: boolean;
  status: ObjectiveNavStatus;
}

export function buildObjectiveNavItems(
  questions: ObjectiveQuestion[],
  answers: Record<number, ObjectiveAnswerValue>,
  activeQuestionId: number | null,
): ObjectiveNavItem[] {
  return questions.map((question, index) => {
    const answered = isObjectiveAnswerAnswered(answers[question.id]);
    return {
      id: question.id,
      index: index + 1,
      answered,
      status:
        activeQuestionId === question.id ? 'current' : answered ? 'answered' : 'blank',
    };
  });
}
