import { App, Button } from 'antd';
import { CopyOutlined } from '@ant-design/icons';

export function CodeBlock({
  code,
  maxHeight,
  title = '源代码',
}: {
  code: string;
  maxHeight?: number;
  title?: string;
}) {
  const { message } = App.useApp();
  const lines = code.length > 0 ? code.split('\n') : [''];

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      message.success('代码已复制');
    } catch {
      message.error('复制失败，请手动选择代码');
    }
  };

  return (
    <div className="code-view">
      <div className="code-view-bar">
        <span className="code-view-title">{title}</span>
        <Button
          type="text"
          size="small"
          icon={<CopyOutlined />}
          onClick={() => void handleCopy()}
        >
          复制
        </Button>
      </div>
      <div className="code-view-body" style={maxHeight ? { maxHeight } : undefined}>
        {lines.map((line, index) => (
          <div className="code-line" key={index}>
            <span className="code-line-no">{index + 1}</span>
            <span className="code-line-text">{line.length > 0 ? line : ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
