import { useEffect, useRef, useState } from 'react';
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
  pickScrollActiveObjectiveId,
} from './ObjectiveAnswerModel';
import { ObjectiveRichText } from './ObjectiveRichText';

const KIND_TAG_COLOR: Record<ObjectiveQuestionKind, string> = {
  single: 'blue',
  multiple: 'purple',
  judge: 'cyan',
  fill: 'green',
};

/**
 * 只把视口顶部 96px（OiJudge sticky 顶栏 + 间距）以下的内容算作“可阅读区域”，
 * 避免卡片刚被顶栏遮住就被判定为当前题。
 */
const SCROLL_SPY_ROOT_MARGIN = '-96px 0px 0px 0px';
/** 点击题号后平滑滚动的保护时间，避免 observer 在滚动中途抢状态。 */
const NAV_SCROLL_LOCK_MS = 700;
/** 聚焦某个选项/输入框后短暂保护，避免 observer 立即覆盖聚焦题。 */
const FOCUS_LOCK_MS = 250;

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
  const scrollSpyLockUntilRef = useRef(0);
  const visibleQuestionTopsRef = useRef(new Map<number, number>());

  const resolvedActiveId =
    activeQuestionId ?? innerActiveId ?? questions[0]?.id ?? null;
  const activeQuestionIdRef = useRef(resolvedActiveId);
  activeQuestionIdRef.current = resolvedActiveId;

  const navItems = buildObjectiveNavItems(questions, answers, resolvedActiveId);
  const answeredCount = countAnsweredObjective(questions, answers);

  const activateQuestion = (questionId: number, lockMs: number) => {
    if (lockMs > 0) scrollSpyLockUntilRef.current = Date.now() + lockMs;
    if (resolvedActiveId === questionId) return;
    setInnerActiveId(questionId);
    onActiveQuestionChange?.(questionId);
  };
  const activateQuestionRef = useRef(activateQuestion);
  activateQuestionRef.current = activateQuestion;

  const questionIdsKey = questions.map((question) => question.id).join(',');

  useEffect(() => {
    if (questions.length === 0) return undefined;
    if (
      typeof window === 'undefined' ||
      typeof window.IntersectionObserver === 'undefined'
    ) {
      // SSR / 测试环境：没有 IntersectionObserver 时保持点击与聚焦驱动。
      return undefined;
    }

    const elements: HTMLElement[] = [];
    for (const question of questions) {
      const element = cardRefs.current.get(question.id);
      if (element) elements.push(element);
    }
    if (elements.length === 0) return undefined;

    const visibleTops = visibleQuestionTopsRef.current;
    visibleTops.clear();

    const observer = new window.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.questionId);
          if (!Number.isInteger(id)) continue;
          if (entry.isIntersecting) visibleTops.set(id, entry.boundingClientRect.top);
          else visibleTops.delete(id);
        }
        // 点击题号平滑滚动期间，点击得到的状态优先。
        if (Date.now() < scrollSpyLockUntilRef.current) return;
        const nextId = pickScrollActiveObjectiveId(
          Array.from(visibleTops, ([id, top]) => ({ id, top })),
        );
        if (nextId === null || nextId === activeQuestionIdRef.current) return;
        activeQuestionIdRef.current = nextId;
        activateQuestionRef.current(nextId, 0);
      },
      {
        root: null,
        rootMargin: SCROLL_SPY_ROOT_MARGIN,
        threshold: [0, 0.01, 0.5, 1],
      },
    );

    elements.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      visibleTops.clear();
    };
    // questions 只通过 id 顺序参与观察；题目内容变化不需要重建 observer。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionIdsKey]);

  if (questions.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="本客观题尚未配置题目，请联系管理员。"
      />
    );
  }

  const markActive = (questionId: number) => {
    activateQuestion(questionId, FOCUS_LOCK_MS);
  };

  const goToQuestion = (questionId: number) => {
    activateQuestion(questionId, NAV_SCROLL_LOCK_MS);
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
              <ObjectiveRichText
                className="objective-question-stem"
                text={question.stem}
              />

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
                      <span className="objective-option-text">
                        <ObjectiveRichText inline text={option.text} />
                      </span>
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
                      <span className="objective-option-text">
                        <ObjectiveRichText inline text={option.text} />
                      </span>
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
                      <span className="objective-option-text">
                        <ObjectiveRichText inline text={option.text} />
                      </span>
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
