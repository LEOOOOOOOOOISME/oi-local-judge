import { Button, Result, Spin } from 'antd';
import { ApiError } from '../api/client';

export function PageLoading({ tip = '加载中…' }: { tip?: string }) {
  return (
    <div className="page-loading">
      <Spin />
      <div className="page-loading-tip">{tip}</div>
    </div>
  );
}

export function ErrorResult({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null;
  const status = apiError?.status ?? 0;
  const resultStatus: '403' | '404' | 'error' =
    status === 403 ? '403' : status === 404 ? '404' : 'error';
  const title = status === 403 ? '无权访问' : status === 404 ? '未找到内容' : '加载失败';
  const subtitle = error instanceof Error ? error.message : '发生未知错误';

  return (
    <Result
      status={resultStatus}
      title={title}
      subTitle={subtitle}
      extra={
        onRetry ? (
          <Button type="primary" onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    />
  );
}
