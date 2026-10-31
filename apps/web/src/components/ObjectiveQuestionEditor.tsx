import {
  Button,
  Checkbox,
  Empty,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
} from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type {
  ObjectiveQuestion,
  ObjectiveQuestionKind,
} from '../api/types';
import '../styles/objective.css';

const KIND_OPTIONS: Array<{ value: ObjectiveQuestionKind; label: string }> = [
  { value: 'single', label: '单选' },
  { value: 'multiple', label: '多选' },
  { value: 'judge', label: '判断' },
  { value: 'fill', label: '填空' },
];

function nextOptionKey(options: Array<{ key: string }>): string {
  const used = new Set(options.map((option) => option.key));
  for (let index = 0; index < 26; index += 1) {
    const key = String.fromCharCode(65 + index);
    if (!used.has(key)) return key;
  }
  return `K${options.length + 1}`;
}

function withKind(question: ObjectiveQuestion, kind: ObjectiveQuestionKind): ObjectiveQuestion {
  const options =
    kind === 'single' || kind === 'multiple'
      ? question.options && question.options.length > 0
        ? question.options
        : [
            { key: 'A', text: '' },
            { key: 'B', text: '' },
          ]
      : question.options;
  const optionKeys = new Set((options ?? []).map((option) => option.key));
  let answers = question.answers ?? [];
  if (kind === 'judge') {
    answers = answers.filter((answer) => answer === 'true' || answer === 'false').slice(0, 1);
  } else if (kind === 'single') {
    answers = answers.filter((answer) => optionKeys.has(answer)).slice(0, 1);
  } else if (kind === 'multiple') {
    answers = answers.filter((answer) => optionKeys.has(answer));
  } else {
    answers = answers.length > 0 ? answers : [''];
  }
  return {
    ...question,
    kind,
    options,
    answers,
    ...(kind === 'fill'
      ? {
          ignoreCase: question.ignoreCase !== false,
          ignoreWhitespace: question.ignoreWhitespace !== false,
        }
      : {}),
  };
}

export function validateObjectiveQuestions(questions: ObjectiveQuestion[]): string | null {
  if (questions.length === 0) return '至少添加 1 道题';
  const ids = new Set<number>();
  for (let index = 0; index < questions.length; index += 1) {
    const question = questions[index];
    const label = `第 ${index + 1} 题`;
    if (!Number.isInteger(question.id) || question.id <= 0) return `${label}缺少有效 ID`;
    if (ids.has(question.id)) return `${label}的 ID 重复`;
    ids.add(question.id);
    if (!question.stem.trim()) return `${label}题干不能为空`;
    if (!Number.isFinite(question.points) || question.points < 0) {
      return `${label}分值无效`;
    }
    if (question.kind === 'single' || question.kind === 'multiple') {
      const options = question.options ?? [];
      if (options.length < 2) return `${label}至少需要 2 个选项`;
      const keys: string[] = [];
      for (const option of options) {
        const key = option.key.trim();
        if (!key) return `${label}选项 key 不能为空`;
        if (keys.includes(key)) return `${label}选项 key 重复`;
        if (!option.text.trim()) return `${label}选项内容不能为空`;
        keys.push(key);
      }
      const answers = question.answers ?? [];
      if (question.kind === 'single' && answers.length !== 1) {
        return `${label}请选择 1 个正确答案`;
      }
      if (question.kind === 'multiple' && answers.length === 0) {
        return `${label}请至少选择 1 个正确答案`;
      }
      if (answers.some((answer) => !keys.includes(answer))) {
        return `${label}正确答案不在选项中`;
      }
    } else if (question.kind === 'judge') {
      const answers = question.answers ?? [];
      if (answers.length !== 1 || (answers[0] !== 'true' && answers[0] !== 'false')) {
        return `${label}请选择正确或错误`;
      }
    } else {
      const answers = (question.answers ?? []).filter((answer) => answer.trim().length > 0);
      if (answers.length === 0) return `${label}请填写至少一个答案`;
    }
  }
  return null;
}

interface ObjectiveQuestionEditorProps {
  questions: ObjectiveQuestion[];
  onChange: (questions: ObjectiveQuestion[]) => void;
  disabled?: boolean;
}

export function ObjectiveQuestionEditor({
  questions,
  onChange,
  disabled = false,
}: ObjectiveQuestionEditorProps) {
  const patchQuestion = (id: number, patch: Partial<ObjectiveQuestion>) => {
    onChange(questions.map((question) => (question.id === id ? { ...question, ...patch } : question)));
  };

  const addQuestion = () => {
    const nextId = Math.max(0, ...questions.map((question) => question.id)) + 1;
    onChange([
      ...questions,
      {
        id: nextId,
        kind: 'single',
        stem: '',
        options: [
          { key: 'A', text: '' },
          { key: 'B', text: '' },
        ],
        answers: [],
        points: 10,
      },
    ]);
  };

  const updateOption = (
    question: ObjectiveQuestion,
    optionIndex: number,
    patch: { key?: string; text?: string },
  ) => {
    const options = (question.options ?? []).map((option, index) =>
      index === optionIndex ? { ...option, ...patch } : option,
    );
    let answers = question.answers;
    const oldKey = question.options?.[optionIndex]?.key;
    if (patch.key !== undefined && oldKey !== undefined && patch.key !== oldKey && answers) {
      answers = answers.map((answer) => (answer === oldKey ? patch.key! : answer));
    }
    patchQuestion(question.id, { options, answers });
  };

  const addOption = (question: ObjectiveQuestion) => {
    const options = question.options ?? [];
    patchQuestion(question.id, {
      options: [...options, { key: nextOptionKey(options), text: '' }],
    });
  };

  const removeOption = (question: ObjectiveQuestion, optionIndex: number) => {
    const removedKey = question.options?.[optionIndex]?.key;
    const options = (question.options ?? []).filter((_option, index) => index !== optionIndex);
    const answers = (question.answers ?? []).filter((answer) => answer !== removedKey);
    patchQuestion(question.id, { options, answers });
  };

  return (
    <div className="objective-editor">
      {questions.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="还没有题目，点击下方“添加题目”开始。"
        />
      ) : null}
      {questions.map((question, index) => (
        <div className="objective-editor-question" key={question.id}>
          <div className="objective-editor-head">
            <span className="objective-editor-index">第 {index + 1} 题</span>
            <Select
              className="objective-kind"
              size="small"
              value={question.kind}
              options={KIND_OPTIONS}
              onChange={(kind: ObjectiveQuestionKind) =>
                patchQuestion(question.id, withKind(question, kind))
              }
              disabled={disabled}
              style={{ width: 88 }}
            />
            <span className="objective-points-field">
              <span className="muted">分值</span>
              <InputNumber
                size="small"
                min={0}
                max={10000}
                precision={0}
                value={question.points}
                onChange={(value) =>
                  patchQuestion(question.id, { points: typeof value === 'number' ? value : 0 })
                }
                disabled={disabled}
                style={{ width: 84 }}
              />
            </span>
            <Popconfirm
              title={`删除第 ${index + 1} 题？`}
              okText="删除"
              cancelText="取消"
              onConfirm={() =>
                onChange(questions.filter((item) => item.id !== question.id))
              }
              disabled={disabled}
            >
              <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={disabled}>
                删除
              </Button>
            </Popconfirm>
          </div>

          <Input.TextArea
            className="objective-stem-input"
            value={question.stem}
            onChange={(event) => patchQuestion(question.id, { stem: event.target.value })}
            placeholder="题干"
            autoSize={{ minRows: 2, maxRows: 5 }}
            disabled={disabled}
          />

          {question.kind === 'single' || question.kind === 'multiple' ? (
            <div className="objective-editor-options">
              <div className="objective-editor-label">选项</div>
              {(question.options ?? []).map((option, optionIndex) => (
                <div className="objective-option-row" key={`${question.id}-${optionIndex}`}>
                  <Input
                    className="objective-option-key"
                    value={option.key}
                    onChange={(event) => updateOption(question, optionIndex, { key: event.target.value })}
                    maxLength={8}
                    placeholder="key"
                    disabled={disabled}
                  />
                  <Input
                    value={option.text}
                    onChange={(event) => updateOption(question, optionIndex, { text: event.target.value })}
                    placeholder="选项内容"
                    disabled={disabled}
                  />
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={() => removeOption(question, optionIndex)}
                    disabled={disabled}
                  />
                </div>
              ))}
              <Button
                size="small"
                icon={<PlusOutlined />}
                onClick={() => addOption(question)}
                disabled={disabled}
              >
                添加选项
              </Button>
            </div>
          ) : null}

          <div className="objective-editor-answer">
            <div className="objective-editor-label">正确答案</div>
            {question.kind === 'single' ? (
              <Radio.Group
                className="objective-answer-control"
                value={question.answers?.[0]}
                onChange={(event) =>
                  patchQuestion(question.id, { answers: [String(event.target.value)] })
                }
                disabled={disabled}
              >
                {(question.options ?? []).map((option) => (
                  <Radio key={option.key} value={option.key}>
                    {`${option.key}. ${option.text || '（未填写）'}`}
                  </Radio>
                ))}
              </Radio.Group>
            ) : null}
            {question.kind === 'multiple' ? (
              <>
                <Checkbox.Group
                  className="objective-answer-control"
                  value={question.answers ?? []}
                  onChange={(values) =>
                    patchQuestion(question.id, { answers: values.map(String) })
                  }
                  disabled={disabled}
                  options={(question.options ?? []).map((option) => ({
                    value: option.key,
                    label: `${option.key}. ${option.text || '（未填写）'}`,
                  }))}
                />
                <span className="objective-flag">
                  <Switch
                    size="small"
                    checked={question.partial === true}
                    onChange={(checked) => patchQuestion(question.id, { partial: checked })}
                    disabled={disabled}
                  />
                  部分给分
                </span>
              </>
            ) : null}
            {question.kind === 'judge' ? (
              <Radio.Group
                className="objective-answer-control"
                value={question.answers?.[0]}
                onChange={(event) =>
                  patchQuestion(question.id, { answers: [String(event.target.value)] })
                }
                disabled={disabled}
              >
                <Radio value="true">正确</Radio>
                <Radio value="false">错误</Radio>
              </Radio.Group>
            ) : null}
            {question.kind === 'fill' ? (
              <>
                <Input.TextArea
                  value={(question.answers ?? []).join('\n')}
                  onChange={(event) =>
                    patchQuestion(question.id, { answers: event.target.value.split('\n') })
                  }
                  placeholder={'每行一个可接受答案\n例如：北京'}
                  autoSize={{ minRows: 2, maxRows: 5 }}
                  disabled={disabled}
                />
                <Space className="objective-flag" size={16} wrap>
                  <span>
                    <Switch
                      size="small"
                      checked={question.ignoreCase !== false}
                      onChange={(checked) => patchQuestion(question.id, { ignoreCase: checked })}
                      disabled={disabled}
                    />{' '}
                    忽略大小写
                  </span>
                  <span>
                    <Switch
                      size="small"
                      checked={question.ignoreWhitespace !== false}
                      onChange={(checked) =>
                        patchQuestion(question.id, { ignoreWhitespace: checked })
                      }
                      disabled={disabled}
                    />{' '}
                    忽略空白
                  </span>
                </Space>
              </>
            ) : null}
          </div>
        </div>
      ))}

      <Button type="dashed" block icon={<PlusOutlined />} onClick={addQuestion} disabled={disabled}>
        添加题目
      </Button>
    </div>
  );
}
