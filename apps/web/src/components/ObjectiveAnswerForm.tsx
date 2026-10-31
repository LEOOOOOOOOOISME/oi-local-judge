import { Checkbox, Empty, Input, Radio, Tag } from 'antd';
import type {
  ObjectiveAnswerValue,
  ObjectiveQuestion,
  ObjectiveQuestionKind,
} from '../api/types';

const KIND_LABEL: Record<ObjectiveQuestionKind, string> = {
  single: '单选',
  multiple: '多选',
  judge: '判断',
  fill: '填空',
};

interface ObjectiveAnswerFormProps {
  questions: ObjectiveQuestion[];
  answers: Record<number, ObjectiveAnswerValue>;
  onChange: (questionId: number, value: ObjectiveAnswerValue) => void;
  disabled?: boolean;
}

export function ObjectiveAnswerForm({
  questions,
  answers,
  onChange,
  disabled = false,
}: ObjectiveAnswerFormProps) {
  if (questions.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="本客观题尚未配置题目，请联系管理员。"
      />
    );
  }

  return (
    <div className="objective-answer-list">
      {questions.map((question, index) => {
        const value = answers[question.id];
        const selected = Array.isArray(value) ? value : [];
        return (
          <div className="objective-question" key={question.id} data-question-id={question.id}>
            <div className="objective-question-head">
              <span className="objective-question-index">第 {index + 1} 题</span>
              <Tag>{KIND_LABEL[question.kind]}</Tag>
              <span className="objective-question-points">{question.points} 分</span>
              {question.kind === 'multiple' && question.partial ? (
                <Tag color="gold">部分给分</Tag>
              ) : null}
            </div>
            <div className="objective-question-stem">{question.stem}</div>

            {question.kind === 'single' ? (
              <Radio.Group
                className="objective-answer-control"
                value={typeof value === 'string' ? value : undefined}
                onChange={(event) => onChange(question.id, String(event.target.value))}
                disabled={disabled}
              >
                {(question.options ?? []).map((option) => (
                  <Radio key={option.key} value={option.key}>
                    {`${option.key}. ${option.text}`}
                  </Radio>
                ))}
              </Radio.Group>
            ) : null}

            {question.kind === 'multiple' ? (
              <Checkbox.Group
                className="objective-answer-control"
                value={selected}
                options={(question.options ?? []).map((option) => ({
                  value: option.key,
                  label: `${option.key}. ${option.text}`,
                }))}
                onChange={(values) => onChange(question.id, values.map(String))}
                disabled={disabled}
              />
            ) : null}

            {question.kind === 'judge' ? (
              <Radio.Group
                className="objective-answer-control"
                value={typeof value === 'string' ? value : undefined}
                onChange={(event) => onChange(question.id, String(event.target.value))}
                disabled={disabled}
              >
                <Radio value="true">正确</Radio>
                <Radio value="false">错误</Radio>
              </Radio.Group>
            ) : null}

            {question.kind === 'fill' ? (
              <Input.TextArea
                className="objective-fill-input"
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => onChange(question.id, event.target.value)}
                placeholder="填写答案"
                autoSize={{ minRows: 1, maxRows: 4 }}
                disabled={disabled}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
