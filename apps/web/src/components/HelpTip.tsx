import { Button, Popover } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import {
  getAuthoringHelp,
  type AuthoringHelpKey,
} from '../help/authoring-help';

export function HelpTip({
  helpKey,
  label,
}: {
  helpKey: AuthoringHelpKey;
  label?: string;
}) {
  const entry = getAuthoringHelp(helpKey);
  return (
    <Popover
      trigger="click"
      title={entry.title}
      content={
        <div className="help-tip-content">
          <p>{entry.summary}</p>
          <ul>
            {entry.bullets.map((bullet) => (
              <li key={bullet}>{bullet}</li>
            ))}
          </ul>
          <p className="muted">
            文档：<code>{entry.path}</code>
          </p>
          <Link to={`/help?doc=${entry.docSlug}`}>在帮助中心查看</Link>
        </div>
      }
    >
      <Button
        type="text"
        size="small"
        icon={<QuestionCircleOutlined />}
        aria-label={label ?? entry.title}
        title={label ?? entry.title}
      />
    </Popover>
  );
}
