import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ObjectiveQuestion } from '../api/types';
import { ObjectiveAnswerForm } from './ObjectiveAnswerForm';
import {
  buildObjectiveNavItems,
  countAnsweredObjective,
  isObjectiveAnswerAnswered,
  toObjectiveAnswerPayload,
} from './ObjectiveAnswerModel';

const questions: ObjectiveQuestion[] = [
  {
    id: 1,
    kind: 'single',
    stem: '1+1=?',
    options: [
      { key: 'A', text: '1' },
      { key: 'B', text: '2' },
    ],
    points: 20,
  },
  {
    id: 2,
    kind: 'multiple',
    stem: '哪些是偶数？',
    options: [
      { key: 'A', text: '2' },
      { key: 'B', text: '3' },
      { key: 'C', text: '4' },
    ],
    points: 30,
    partial: true,
  },
  {
    id: 3,
    kind: 'judge',
    stem: '地球是圆的。',
    points: 10,
  },
  {
    id: 4,
    kind: 'fill',
    stem: '填写圆周率。',
    points: 40,
  },
];

describe('objective answer model', () => {
  it('recognizes single / multiple / judge / fill answers and counts them', () => {
    const answers = { 1: 'B', 2: ['A', 'C'], 3: 'true', 4: ' 3.14 ' };
    expect(isObjectiveAnswerAnswered('B')).toBe(true);
    expect(isObjectiveAnswerAnswered(['A', 'C'])).toBe(true);
    expect(isObjectiveAnswerAnswered('true')).toBe(true);
    expect(isObjectiveAnswerAnswered(' 3.14 ')).toBe(true);
    expect(isObjectiveAnswerAnswered('')).toBe(false);
    expect(isObjectiveAnswerAnswered('   ')).toBe(false);
    expect(isObjectiveAnswerAnswered([])).toBe(false);
    expect(isObjectiveAnswerAnswered(undefined)).toBe(false);
    expect(countAnsweredObjective(questions, answers)).toBe(4);
    expect(countAnsweredObjective(questions, { 1: 'B', 2: [], 3: '   ' })).toBe(1);
  });

  it('builds the original { questionId, value } payload and drops blanks', () => {
    const payload = toObjectiveAnswerPayload(questions, {
      1: 'B',
      2: [],
      3: 'false',
      4: '   ',
    });
    expect(payload).toEqual([
      { questionId: 1, value: 'B' },
      { questionId: 3, value: 'false' },
    ]);
  });

  it('marks the current question, answered questions and blanks for the nav', () => {
    const items = buildObjectiveNavItems(questions, { 1: 'B', 2: ['A'] }, 2);
    expect(items.map((item) => item.status)).toEqual([
      'answered',
      'current',
      'blank',
      'blank',
    ]);
    expect(items.map((item) => item.index)).toEqual([1, 2, 3, 4]);
  });
});

describe('ObjectiveAnswerForm', () => {
  it('renders question cards, row options, points and nav states', () => {
    const html = renderToStaticMarkup(
      createElement(ObjectiveAnswerForm, {
        questions,
        answers: { 1: 'B', 2: ['A'] },
        onChange: () => {},
        showNav: true,
        activeQuestionId: 2,
      }),
    );

    expect(html).toContain('第 1 题');
    expect(html).toContain('本题共 20 分');
    expect(html).toContain('答题卡');
    expect(html).toContain('已答 2 / 4');
    expect(html).toContain('objective-nav-item is-answered');
    expect(html).toContain('objective-nav-item is-current');
    expect(html).toContain('objective-option');
    expect(html).toContain('多选');
    expect(html).toContain('正确');
    expect(html).toContain('填写答案');
    expect(html).not.toContain('答案：');
  });
});
