import { useRef, useState } from 'react';
import { Checkbox, Empty, Input, Radio, Tag } from 'antd';
import type {
  ObjectiveAnswerValue,
  ObjectiveQuestion,
  ObjectiveQuestionKind,
} from '../api/types';
import {
  OBJECTIVE_KIND_LABEL,
  buildObjectiveNavItems,
  countAnsweredObjective,
  isObjectiveAnswerAnswered,
  objectiveQuestionOptions,
} from './ObjectiveAnswerModel';

const KIND_TAG_COLOR: Record<ObjectiveQuestionKind, string> = {
  single: 'blue',
  multiple: 'purple',
  judge: 'cyan',
  fill: 'green',
};

interface ObjectiveAnswerFormProps {
  questions: ObjectiveQuestion[];
  answers: Record<number, ObjectiveAnswerValue>;
  onChange: (questionId: number, value: ObjectiveAnswerValue) => void;
  disabled?: boolean;
  /**
   * 是否显示题号导航。默认题目多于 1 道时显示；父组件可显式关闭。
   */
  showNav?: boolean;
  /** 当前题；由父组件控制，配合 onActiveQuestionChange 使用。 */
  activeQuestionId?: number | null;
  onActiveQuestionChange?: (questionId: number) => void;
}

export function ObjectiveAnswerForm({
  questions,
  answers,
  onChange,
  disabled = false,
  showNav = questions.length > 1,
  activeQuestionId,
  onActiveQuestionChange,
}: ObjectiveAnswerFormProps) {
  const [innerActiveId, setInnerActiveId] = useState<number | null>(null);
  const cardRefs = useRef(new Map<number, HTMLElement>());

  if (questions.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="本客观题尚未配置题目，请联系管理员。"
      />
    );
  }

  const resolvedActiveId =
    activeQuestionId ?? innerActiveId ?? questions[0]?.id ?? null;
  const navItems = buildObjectiveNavItems(questions, answers, resolvedActiveId);
  const answeredCount = countAnsweredObjective(questions, answers);

  const markActive = (questionId: number) => {
    if (resolvedActiveId === questionId) return;
    setInnerActiveId(questionId);
    onActiveQuestionChange?.(questionId);
  };

  const goToQuestion = (questionId: number) => {
    markActive(questionId);
    const card = cardRefs.current.get(questionId);
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div
      className={`objective-answer-layout${
        showNav ? ' objective-answer-layout-with-nav' : ''
      }`}
    >
      {showNav ? (
        <nav className="objective-nav" aria-label="题目导航">
          <div className="objective-nav-head">
            <span className="objective-nav-title">答题卡</span>
            <span className="objective-nav-progress">
              已答 {answeredCount} / {questions.length}
            </span>
          </div>
          <div className="objective-nav-grid">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`objective-nav-item is-${item.status}`}
                aria-current={item.status === 'current' ? 'true' : undefined}
                aria-label={`第 ${item.index} 题，${
                  item.status === 'current'
                    ? '当前题'
                    : item.answered
                      ? '已作答'
                      : '未作答'
                }`}
                onClick={() => goToQuestion(item.id)}
              >
                {item.index}
              </button>
            ))}
          </div>
          <div className="objective-nav-legend" aria-hidden="true">
            <span className="objective-nav-legend-item">
              <i className="objective-nav-dot is-current" />
              当前
            </span>
            <span className="objective-nav-legend-item">
              <i className="objective-nav-dot is-answered" />
              已答
            </span>
            <span className="objective-nav-legend-item">
              <i className="objective-nav-dot is-blank" />
              未答
            </span>
          </div>
        </nav>
      ) : null}

      <div className="objective-question-list">
        {questions.map((question, index) => {
          const value = answers[question.id];
          const selected = Array.isArray(value) ? value : [];
          const answered = isObjectiveAnswerAnswered(value);
          const options = objectiveQuestionOptions(question);
          return (
            <section
              key={question.id}
              ref={(node) => {
                if (node) cardRefs.current.set(question.id, node);
                else cardRefs.current.delete(question.id);
              }}
              className={`objective-question${
                resolvedActiveId === question.id ? ' is-active' : ''
              }`}
              data-question-id={question.id}
              aria-label={`第 ${index + 1} 题`}
              onFocusCapture={() => markActive(question.id)}
            >
              <div className="objective-question-head">
                <span className="objective-question-index">第 {index + 1} 题</span>
                <Tag color={KIND_TAG_COLOR[question.kind]}>
                  {OBJECTIVE_KIND_LABEL[question.kind]}
                </Tag>
                {question.kind === 'multiple' && question.partial ? (
                  <Tag color="gold">部分给分</Tag>
                ) : null}
                {answered ? (
                  <span className="objective-question-status">已作答</span>
                ) : null}
                <span className="objective-question-points">
                  本题共 {question.points} 分
                </span>
              </div>
              <div className="objective-question-stem">{question.stem}</div>

              {question.kind === 'single' ? (
                <Radio.Group
                  className="objective-option-list"
                  value={typeof value === 'string' ? value : undefined}
                  onChange={(event) => onChange(question.id, String(event.target.value))}
                  disabled={disabled}
                >
                  {options.map((option) => (
                    <Radio
                      key={option.key}
                      value={option.key}
                      className="objective-option"
                    >
                      <span className="objective-option-key">{option.key}</span>
                      <span className="objective-option-text">{option.text}</span>
                    </Radio>
                  ))}
                </Radio.Group>
              ) : null}

              {question.kind === 'multiple' ? (
                <Checkbox.Group
                  className="objective-option-list"
                  value={selected}
                  onChange={(values) => onChange(question.id, values.map(String))}
                  disabled={disabled}
                >
                  {options.map((option) => (
                    <Checkbox
                      key={option.key}
                      value={option.key}
                      className="objective-option"
                    >
                      <span className="objective-option-key">{option.key}</span>
                      <span className="objective-option-text">{option.text}</span>
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              ) : null}

              {question.kind === 'judge' ? (
                <Radio.Group
                  className="objective-option-list"
                  value={typeof value === 'string' ? value : undefined}
                  onChange={(event) => onChange(question.id, String(event.target.value))}
                  disabled={disabled}
                >
                  {options.map((option, optionIndex) => (
                    <Radio
                      key={option.key}
                      value={option.key}
                      className="objective-option"
                    >
                      <span className="objective-option-key">
                        {String.fromCharCode(65 + optionIndex)}
                      </span>
                      <span className="objective-option-text">{option.text}</span>
                    </Radio>
                  ))}
                </Radio.Group>
              ) : null}

              {question.kind === 'fill' ? (
                <Input
                  className="objective-fill-input"
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => onChange(question.id, event.target.value)}
                  placeholder="填写答案"
                  allowClear
                  disabled={disabled}
                />
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
