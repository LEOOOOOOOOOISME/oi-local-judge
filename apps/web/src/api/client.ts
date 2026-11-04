import type { ApiEnvelope, QualityGateReport } from './types';

/**
 * 统一 API client：
 * - 始终带上会话 Cookie（credentials: 'include'）
 * - 统一解析 { ok, data, error } 信封
 * - 401 时广播事件，由 AuthProvider 清理登录态并跳转登录页
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** 发布接口在 409 时附带的质控报告。 */
  readonly report: QualityGateReport | undefined;

  constructor(
    status: number,
    message: string,
    code?: string,
    report?: QualityGateReport,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.report = report;
  }
}

type UnauthorizedListener = () => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

/** 订阅 401 事件，返回取消订阅函数。 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

function emitUnauthorized(): void {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // 监听器自身异常不能影响请求错误处理。
    }
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** 原始字节（文件上传）；设置后不会 JSON 序列化 body。 */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 用于登录态探测、登录接口：401 不触发全局跳转。 */
  skipAuthRedirect?: boolean;
}

function defaultErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return '请求参数有误';
    case 401:
      return '登录状态已失效，请重新登录';
    case 403:
      return '没有访问权限';
    case 404:
      return '请求的资源不存在';
    case 413:
      return '内容超过大小限制';
    case 500:
      return '服务器内部错误';
    default:
      return `请求失败（HTTP ${status}）`;
  }
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    rawBody,
    headers,
    signal,
    skipAuthRedirect = false,
  } = options;
  const finalHeaders: Record<string, string> = { Accept: 'application/json', ...headers };
  if (body !== undefined && rawBody === undefined) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      headers: finalHeaders,
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error;
    }
    throw new ApiError(0, '网络连接失败，请确认后端服务已启动');
  }

  const text = await response.text();
  let envelope: ApiEnvelope<T> | null = null;
  if (text.length > 0) {
    try {
      envelope = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      envelope = null;
    }
  }

  if (!response.ok || envelope === null || envelope.ok !== true) {
    if (response.status === 401 && !skipAuthRedirect) {
      emitUnauthorized();
    }
    throw new ApiError(
      response.status,
      envelope?.error?.message ?? defaultErrorMessage(response.status),
      envelope?.error?.code,
      envelope?.error?.report,
    );
  }

  return envelope.data as T;
}

export function apiGet<T>(
  path: string,
  options: Omit<RequestOptions, 'method' | 'body' | 'rawBody'> = {},
): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'GET' });
}

export function apiPost<T>(
  path: string,
  body?: unknown,
  options: Omit<RequestOptions, 'method' | 'body' | 'rawBody'> = {},
): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'POST', body });
}

export function apiPut<T>(
  path: string,
  body?: unknown,
  options: Omit<RequestOptions, 'method' | 'body' | 'rawBody'> = {},
): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'PUT', body });
}

export function apiDelete<T>(
  path: string,
  options: Omit<RequestOptions, 'method' | 'body' | 'rawBody'> = {},
): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'DELETE' });
}

export function apiPatch<T>(
  path: string,
  body?: unknown,
  options: Omit<RequestOptions, 'method' | 'body' | 'rawBody'> = {},
): Promise<T> {
  return apiRequest<T>(path, { ...options, method: 'PATCH', body });
}

/** 文件上传：body 为原始 File/Blob 字节，不做 JSON 序列化。 */
export function apiUpload<T>(
  path: string,
  file: Blob,
  contentType: string,
): Promise<T> {
  return apiRequest<T>(path, {
    method: 'POST',
    rawBody: file,
    headers: { 'Content-Type': contentType },
  });
}

/**
 * 以当前会话下载后端生成的文件（如比赛成绩报告 CSV）。
 * 手动触发浏览器保存，避免整页跳转离开管理控制台。
 */
export async function downloadApiFile(path: string, filename: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'include' });
  } catch {
    throw new ApiError(0, '网络连接失败，请确认后端服务已启动');
  }

  if (!response.ok) {
    const text = await response.text();
    let envelope: ApiEnvelope<unknown> | null = null;
    if (text.length > 0) {
      try {
        envelope = JSON.parse(text) as ApiEnvelope<unknown>;
      } catch {
        envelope = null;
      }
    }
    if (response.status === 401) emitUnauthorized();
    throw new ApiError(
      response.status,
      envelope?.error?.message ?? defaultErrorMessage(response.status),
      envelope?.error?.code,
    );
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
