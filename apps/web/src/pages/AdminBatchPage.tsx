import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined, InboxOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, apiUpload } from '../api/client';
import type {
  AdminProblemSummary,
  BatchFailureItem,
  BatchImportStatus,
  BatchItemStatus,
  BatchJob,
  BatchResultItem,
  BatchRunResult,
  BatchUploadResult,
  SubmissionStatus,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { VerdictBadge } from '../components/VerdictBadge';
import {
  formatMemoryKb,
  formatRunTime,
} from '../utils/format';
import { SUBMISSION_STATUS_LABEL } from '../utils/status';
import '../styles/admin.css';
import '../styles/batch.css';

// P0 上限与后端 10 GB bodyLimit 对齐；真正的流式上传/解压在 P1 实现。
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx', '.c']);
const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = ['20', '50', '100', '200'];
const LEVEL_OPTIONS = Array.from({ length: 6 }, (_, index) => ({
  value: index + 1,
  label: `第 ${index + 1} 层`,
}));

interface ParsedStudent {
  student: string;
  path: string;
}

interface MultiPair {
  student: string;
  folder: string;
  problemId: number;
  problemTitle: string;
  path: string;
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index).toLowerCase() : '';
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extensionOf(path));
}

function autoProblemId(
  folder: string,
  problems: Map<number, AdminProblemSummary>,
): number | null {
  if (!/^\d+$/.test(folder)) return null;
  const id = Number(folder);
  return Number.isInteger(id) && problems.has(id) ? id : null;
}

/** 多题模式下可选的题目文件夹（按学生层级/题目层级解析）。 */
function parseFolderKeys(files: string[], studentLevel: number, problemLevel: number): string[] {
  const maxLevel = Math.max(studentLevel, problemLevel);
  const folders = new Set<string>();
  for (const path of files) {
    if (!isSourceFile(path)) continue;
    const parts = path.split('/');
    if (parts.length <= maxLevel) continue;
    const student = parts[studentLevel - 1];
    const folder = parts[problemLevel - 1];
    if (student && folder) folders.add(folder);
  }
  return [...folders].sort((left, right) =>
    left.localeCompare(right, undefined, { numeric: true }),
  );
}

/** 与后端 batch/run 相同的层级规则：取第 level 段目录作为选手名。 */
function parseStudents(files: string[], level: number): ParsedStudent[] {
  const map = new Map<string, string>();
  for (const path of files) {
    if (!isSourceFile(path)) continue;
    const parts = path.split('/');
    if (parts.length <= level) continue;
    const student = parts[level - 1];
    if (!student || map.has(student)) continue;
    map.set(student, path);
  }
  return [...map.entries()]
    .map(([student, path]) => ({ student, path }))
    .sort((left, right) => left.student.localeCompare(right.student));
}

function statusLabel(status: BatchItemStatus): string {
  if (status === 'missing') return '缺失';
  if (status === 'skipped') return '已跳过';
  if (status === 'error') return '导入失败';
  return SUBMISSION_STATUS_LABEL[status as SubmissionStatus] ?? status;
}

function statusColor(status: BatchItemStatus): string {
  if (status === 'missing') return 'red';
  if (status === 'skipped') return 'orange';
  if (status === 'error') return 'red';
  if (status === 'finished') return 'green';
  if (status === 'failed' || status === 'canceled') return 'red';
  return 'blue';
}

function importStatusLabel(status: BatchImportStatus | null): string {
  if (status === 'imported') return '已导入';
  if (status === 'skipped') return '已跳过';
  if (status === 'error') return '导入失败';
  return '—';
}

const ERROR_CODE_LABEL: Record<string, string> = {
  SOURCE_TOO_LARGE: '源码超过管理员上限',
  EMPTY_SOURCE: '源码为空',
  UNSUPPORTED_SOURCE: '题目类型不支持该源码',
  UNMAPPED_PROBLEM: '题目文件夹未映射',
  INVALID_STUDENT_FOLDER: '无效学生文件夹（缺少可用源码）',
  USER_CREATE_FAILED: '创建合成学生失败',
  SUBMIT_FAILED: '创建提交失败',
  UNSAFE_PATH: 'zip 路径不安全',
};

function errorCodeLabel(code: string | null): string {
  if (!code) return '—';
  return ERROR_CODE_LABEL[code] ?? code;
}

function FailureList({
  items,
  total,
  tone,
}: {
  items: BatchFailureItem[];
  total: number;
  tone: 'warning' | 'error';
}) {
  if (items.length === 0) return null;
  return (
    <div className="batch-failure-list">
      {items.map((item) => (
        <div className="batch-failure-row" key={item.id}>
          <span className="batch-failure-student">{item.student}</span>
          <span className="mono batch-failure-path" title={item.sourcePath}>
            {item.sourcePath}
          </span>
          <Tag color={tone === 'warning' ? 'orange' : 'red'}>{item.errorCode ?? 'ERROR'}</Tag>
          <span className="batch-failure-message">
            {errorCodeLabel(item.errorCode)}
            {item.errorMessage ? `：${item.errorMessage}` : ''}
          </span>
        </div>
      ))}
      {total > items.length ? (
        <div className="muted batch-failure-more">
          仅显示前 {items.length} 条，共 {total} 条；可翻页查看全部条目。
        </div>
      ) : null}
    </div>
  );
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function describeBatchError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'BAD_ZIP':
        return `无法解析 zip：${error.message}`;
      case 'EMPTY_BODY':
        return 'zip 文件为空';
      case 'UNSAFE_PATH':
        return `zip 内含不安全路径：${error.message}`;
      case 'NO_SOURCES':
        return '当前层级没有识别到学生目录或 .cpp 源文件，请调整层级或检查 zip 目录结构。';
      case 'UPLOAD_NOT_FOUND':
        return '上传记录不存在，请重新上传 zip。';
      case 'BAD_UPLOAD_ID':
        return 'uploadId 无效，请重新上传 zip。';
      case 'PROBLEM_NOT_FOUND':
        return '题目不存在';
      case 'UNMAPPED_PROBLEMS':
      case 'UNMAPPED_PROBLEM':
        return `有题目文件夹未映射：${error.message}`;
      case 'SOURCE_TOO_LARGE':
        return `源码超过大小上限：${error.message}`;
      case 'EMPTY_SOURCE':
        return '源码为空';
      case 'UNSUPPORTED_SOURCE':
        return `题目类型不支持该源码：${error.message}`;
      case 'INVALID_STUDENT_FOLDER':
        return '无效学生文件夹（缺少可用源码或空目录）';
      case 'USER_CREATE_FAILED':
        return '创建合成学生失败，请检查用户名冲突。';
      case 'SUBMIT_FAILED':
        return `创建提交失败：${error.message}`;
      case 'BAD_REQUEST':
        return '请求参数有误';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '批量评测请求失败';
}

export function AdminBatchPage() {
  const { message } = App.useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFileName, setUploadFileName] = useState('');
  const [uploadResult, setUploadResult] = useState<BatchUploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [studentLevel, setStudentLevel] = useState(1);
  const [problemLevel, setProblemLevel] = useState(0);
  const [problemMap, setProblemMap] = useState<Record<string, number | undefined>>({});
  const [problemId, setProblemId] = useState<number | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [exporting, setExporting] = useState(false);

  const problemsQuery = useQuery({
    queryKey: ['admin-problems'],
    queryFn: () => apiGet<AdminProblemSummary[]>('/api/admin/problems'),
    staleTime: 30_000,
  });
  const batchQuery = useQuery({
    queryKey: ['batch', batchId, page, pageSize],
    queryFn: () =>
      apiGet<BatchJob>(
        `/api/admin/batch/${batchId}?offset=${(page - 1) * pageSize}&limit=${pageSize}`,
      ),
    enabled: batchId !== null,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1000;
      return data.status === 'running' ? 1000 : false;
    },
  });

  const job = batchQuery.data ?? null;
  const problemsById = useMemo(
    () => new Map((problemsQuery.data ?? []).map((problem) => [problem.id, problem])),
    [problemsQuery.data],
  );
  const sourcePaths = useMemo(
    () => (uploadResult?.files ?? []).filter(isSourceFile),
    [uploadResult],
  );
  const maxDepth = useMemo(() => {
    if (!uploadResult || uploadResult.files.length === 0) return 0;
    return uploadResult.files.reduce(
      (maximum, path) => Math.max(maximum, path.split('/').length),
      0,
    );
  }, [uploadResult]);
  const parsedStudents = useMemo(
    () => parseStudents(uploadResult?.files ?? [], studentLevel),
    [uploadResult, studentLevel],
  );
  const example = parsedStudents[0];
  const multiProblem = problemLevel > 0;
  const folderKeys = useMemo(
    () =>
      multiProblem
        ? parseFolderKeys(uploadResult?.files ?? [], studentLevel, problemLevel)
        : [],
    [uploadResult, studentLevel, problemLevel, multiProblem],
  );

  const multiPreview = useMemo(() => {
    if (!multiProblem || !uploadResult) {
      return {
        pairs: [] as MultiPair[],
        unresolved: [] as string[],
        studentCount: 0,
        problemIds: [] as number[],
      };
    }
    const maxLevel = Math.max(studentLevel, problemLevel);
    const seen = new Set<string>();
    const pairs: MultiPair[] = [];
    const unresolved = new Set<string>();
    for (const path of uploadResult.files) {
      if (!isSourceFile(path)) continue;
      const parts = path.split('/');
      if (parts.length <= maxLevel) continue;
      const student = parts[studentLevel - 1];
      const folder = parts[problemLevel - 1];
      if (!student || !folder) continue;
      const resolved =
        problemMap[folder] ??
        autoProblemId(folder, problemsById) ??
        undefined;
      const problem = resolved ? problemsById.get(resolved) : undefined;
      if (!resolved || !problem) {
        unresolved.add(folder);
        continue;
      }
      const key = `${student}|${resolved}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({
        student,
        folder,
        problemId: resolved,
        problemTitle: problem.title,
        path,
      });
    }
    pairs.sort(
      (left, right) =>
        left.student.localeCompare(right.student) || left.problemId - right.problemId,
    );
    return {
      pairs,
      unresolved: [...unresolved].sort(),
      studentCount: new Set(pairs.map((pair) => pair.student)).size,
      problemIds: [...new Set(pairs.map((pair) => pair.problemId))].sort(
        (left, right) => left - right,
      ),
    };
  }, [
    multiProblem,
    uploadResult,
    studentLevel,
    problemLevel,
    problemMap,
    problemsById,
  ]);

  useEffect(() => {
    if (!multiProblem || !uploadResult) {
      setProblemMap({});
      return;
    }
    setProblemMap((previous) => {
      const next: Record<string, number | undefined> = {};
      for (const folder of folderKeys) {
        const auto = autoProblemId(folder, problemsById);
        if (auto !== null) {
          next[folder] = auto;
        } else if (previous[folder] && problemsById.has(previous[folder]!)) {
          next[folder] = previous[folder];
        }
      }
      return next;
    });
  }, [multiProblem, uploadResult, folderKeys, problemsById]);

  const batchRunning = batchId !== null && (job === null || job.status === 'running');
  const multiReady =
    multiProblem &&
    multiPreview.pairs.length > 0 &&
    multiPreview.unresolved.length === 0;
  const canRun =
    Boolean(uploadResult) &&
    !starting &&
    !batchRunning &&
    (multiProblem ? multiReady : problemId !== undefined);

  const uploadZip = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setUploadError('请选择 .zip 文件');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('zip 超过 5 GB 限制');
      return;
    }
    setUploading(true);
    setUploadError(null);
    setRunError(null);
    setUploadResult(null);
    setBatchId(null);
    setPage(1);
    setUploadFileName(file.name);
    try {
      const result = await apiUpload<BatchUploadResult>(
        '/api/admin/batch/upload',
        file,
        'application/zip',
      );
      setUploadResult(result);
      setStudentLevel(1);
      setProblemLevel(0);
      setProblemMap({});
      message.success(`zip 解析成功，共 ${result.files.length} 个文件`);
    } catch (error) {
      setUploadError(describeBatchError(error));
      message.error(describeBatchError(error));
    } finally {
      setUploading(false);
    }
  };

  const handleFile = (file: File | undefined) => {
    if (file) void uploadZip(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    handleFile(event.dataTransfer.files?.[0]);
  };

  const startBatch = async () => {
    if (!uploadResult || !canRun) return;
    setStarting(true);
    setRunError(null);
    try {
      const result = await apiPost<BatchRunResult>('/api/admin/batch/run', {
        uploadId: uploadResult.uploadId,
        studentLevel,
        language: 'cpp17',
        ...(multiProblem
          ? {
              problemLevel,
              problemMap: Object.fromEntries(
                Object.entries(problemMap).filter(
                  (entry): entry is [string, number] => typeof entry[1] === 'number',
                ),
              ),
            }
          : { problemId }),
      });
      setBatchId(result.id);
      setPage(1);
      message.success(
        `已提交 ${result.count} 份代码，跳过 ${result.skippedCount} 项，失败 ${result.errorCount} 项`,
      );
    } catch (error) {
      setRunError(describeBatchError(error));
      message.error(describeBatchError(error));
    } finally {
      setStarting(false);
    }
  };

  const exportCsv = async () => {
    if (!job || job.total === 0) return;
    setExporting(true);
    try {
      // 分页接口单次最多 1000 条；导出时按页拉取全部结果，避免只导出当前页。
      const allItems: BatchResultItem[] = [];
      let offset = 0;
      while (offset < job.total) {
        const pageData = await apiGet<BatchJob>(
          `/api/admin/batch/${job.id}?offset=${offset}&limit=1000`,
        );
        allItems.push(...pageData.items);
        if (pageData.items.length === 0) break;
        offset += pageData.items.length;
      }
      const header = [
        '选手',
        '题目',
        '源文件',
        '导入状态',
        '错误码',
        '错误信息',
        '状态',
        'Verdict',
        '得分',
        '用时(ms)',
        '内存(KB)',
      ];
      const rows = allItems.map((item) => [
        item.student,
        item.problemTitle ?? (item.problemId === null ? '' : `#${item.problemId}`),
        item.sourcePath,
        importStatusLabel(item.importStatus),
        item.errorCode ?? '',
        item.errorMessage ?? '',
        statusLabel(item.status),
        item.verdict ?? '',
        String(item.score),
        String(item.timeMs),
        String(item.memoryKb),
      ]);
      const csv = [header, ...rows]
        .map((row) => row.map((cell) => csvCell(cell)).join(','))
        .join('\r\n');
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `batch-${job.id}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      message.success(`CSV 已导出（${allItems.length} 条）`);
    } catch (error) {
      message.error(describeBatchError(error));
    } finally {
      setExporting(false);
    }
  };

  const columns: TableColumnsType<BatchResultItem> = [
    { title: '选手', dataIndex: 'student', width: 130 },
    {
      title: '题目',
      dataIndex: 'problemTitle',
      width: 180,
      render: (_value, item) => (
        <span title={item.problemTitle ?? (item.problemId === null ? '—' : `#${item.problemId}`)}>
          {item.problemTitle ?? (item.problemId === null ? '—' : `#${item.problemId}`)}
        </span>
      ),
    },
    {
      title: '源文件',
      dataIndex: 'sourcePath',
      render: (value: string) => (
        <span className="mono batch-path" title={value}>
          {value}
        </span>
      ),
    },
    {
      title: '导入',
      dataIndex: 'importStatus',
      width: 90,
      render: (value: BatchImportStatus | null) =>
        value === 'error' ? (
          <Tag color="red">{importStatusLabel(value)}</Tag>
        ) : value === 'skipped' ? (
          <Tag color="orange">{importStatusLabel(value)}</Tag>
        ) : (
          <Tag color="green">{importStatusLabel(value)}</Tag>
        ),
    },
    {
      title: '错误',
      dataIndex: 'errorCode',
      width: 210,
      render: (_value, item) =>
        item.errorCode ? (
          <Tooltip
            title={`${errorCodeLabel(item.errorCode)}${
              item.errorMessage ? `：${item.errorMessage}` : ''
            }`}
          >
            <span className="batch-error-code mono">{item.errorCode}</span>
          </Tooltip>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 98,
      render: (value: BatchItemStatus) => (
        <Tag color={statusColor(value)}>{statusLabel(value)}</Tag>
      ),
    },
    {
      title: 'Verdict',
      dataIndex: 'verdict',
      width: 88,
      render: (value: BatchResultItem['verdict']) => <VerdictBadge verdict={value} />,
    },
    {
      title: '得分',
      dataIndex: 'score',
      width: 72,
      align: 'right',
      render: (value: number) => <span className="score-value">{value}</span>,
    },
    {
      title: '用时',
      dataIndex: 'timeMs',
      width: 92,
      align: 'right',
      render: (value: number) => formatRunTime(value),
    },
    {
      title: '内存',
      dataIndex: 'memoryKb',
      width: 96,
      align: 'right',
      render: (value: number) => formatMemoryKb(value),
    },
  ];

  // 汇总统计来自服务端聚合，不随当前分页变化。
  const acCount = job?.acCount ?? 0;
  const totalStudents = job?.total ?? 0;
  const averageScore = job?.averageScore ?? 0;
  const judgedCount = job?.judgedCount ?? 0;
  const resultMulti = Boolean(job?.multiProblem);
  const distinctStudentCount = job?.distinctStudentCount ?? 0;
  const distinctProblemCount = job?.distinctProblemCount ?? 0;
  const skippedCount = job?.skippedCount ?? 0;
  const errorCount = job?.errorCount ?? 0;

  const problemOptions = (problemsQuery.data ?? []).map((problem) => ({
    value: problem.id,
    label: `#${problem.id} ${problem.title}`,
  }));

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理', to: '/admin/problems' }, { label: '批量评测' }]}
        title="批量评测"
        subtitle="上传选手代码 zip，按目录层级映射选手，自动创建 batch_<姓名> 用户并评测。"
        extra={
          <a href="/admin/problems">
            <Button>题目管理</Button>
          </a>
        }
      />

      <Card
        className="oij-card"
        title="1. 上传选手代码 zip"
        extra={<span className="muted">仅识别 .cpp / .cc / .cxx</span>}
      >
        <div
          className={`batch-drop${dragActive ? ' batch-drop-active' : ''}${
            uploading ? ' batch-drop-busy' : ''
          }`}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          {uploading ? (
            <Spin />
          ) : (
            <InboxOutlined className="batch-drop-icon" />
          )}
          <div className="batch-drop-title">
            {uploading
              ? '正在上传并解析 zip…'
              : uploadFileName
                ? '拖拽或点击替换 zip 文件'
                : '拖拽选手代码 zip 到此，或点击选择文件'}
          </div>
          <div className="batch-drop-hint muted">
            {uploadFileName ||
              '支持 .zip，最大 5 GB；例如 Alice/main.cpp、Bob/main.cpp（超大文件 P1 将改为流式上传）'}
          </div>
        </div>
        <input
          ref={fileInputRef}
          className="admin-file-input"
          type="file"
          accept=".zip,application/zip"
          data-testid="batch-zip-input"
          onChange={(event) => {
            handleFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        {uploadError ? (
          <Alert
            className="batch-alert"
            type="error"
            showIcon
            message="上传失败"
            description={uploadError}
          />
        ) : null}

        {uploadResult ? (
          <div className="batch-upload-result">
            <div className="batch-upload-meta">
              <span>
                <span className="muted">uploadId</span>{' '}
                <span className="mono">{uploadResult.uploadId}</span>
              </span>
              <span className="muted">
                共 {uploadResult.files.length} 个文件 · {sourcePaths.length} 个源文件
                {maxDepth > 0 ? ` · 最大路径深度 ${maxDepth}` : ''}
              </span>
            </div>
            <div className="batch-file-list">
              {uploadResult.files.map((path) => (
                <div className="batch-file-row" key={path}>
                  <span className="mono batch-file-path" title={path}>
                    {path}
                  </span>
                  {isSourceFile(path) ? <Tag color="blue">源文件</Tag> : <Tag>其他</Tag>}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <div className="batch-grid">
        <Card className="oij-card" title="2. 目录层级映射">
          <div className="batch-field batch-level-field">
            <span className="muted">选手目录层级</span>
            <Select
              value={studentLevel}
              options={LEVEL_OPTIONS}
              onChange={(value: number) => setStudentLevel(value)}
              style={{ width: 150 }}
              disabled={!uploadResult || uploading}
            />
          </div>
          <div className="batch-field batch-problem-level-field">
            <span className="muted">题目层级</span>
            <Select
              value={problemLevel}
              options={[
                { value: 0, label: '不启用（单题模式）' },
                ...LEVEL_OPTIONS.map((option) => ({
                  ...option,
                  label: `第 ${option.value} 层`,
                })),
              ]}
              onChange={(value: number) => setProblemLevel(value)}
              style={{ width: 190 }}
              disabled={!uploadResult || uploading}
            />
          </div>
          <div className="batch-level-hint muted">
            {uploadResult
              ? multiProblem
                ? `zip 内路径最大深度 ${maxDepth}；学生取第 ${studentLevel} 层，题目取第 ${problemLevel} 层目录。`
                : `zip 内路径最大深度 ${maxDepth}；当前取第 ${studentLevel} 层目录作为选手名。`
              : '上传 zip 后可调整层级。'}
          </div>
          <div className="batch-example">
            {multiProblem && multiPreview.pairs[0] ? (
              <span>
                示例：<span className="mono">{multiPreview.pairs[0].path}</span> → 选手{' '}
                <strong>{multiPreview.pairs[0].student}</strong> · 题目{' '}
                <strong>
                  {multiPreview.pairs[0].problemTitle}（#{multiPreview.pairs[0].problemId}）
                </strong>
              </span>
            ) : example ? (
              <span>
                示例：<span className="mono">{example.path}</span> → 选手{' '}
                <strong>{example.student}</strong>
              </span>
            ) : uploadResult ? (
              <span className="batch-example-empty">
                {multiProblem
                  ? '当前层级无法解析出“学生/题目”，请检查层级或题目映射。'
                  : '当前层级无法解析出选手（源文件路径层级不足），请调小层级。'}
              </span>
            ) : (
              <span className="muted">等待上传 zip。</span>
            )}
          </div>
          {uploadResult && multiProblem ? (
            <div className="batch-folder-map">
              <div className="batch-preview-head">
                <span>文件夹 → 题目映射</span>
                <span className="muted">
                  {folderKeys.length} 个题目文件夹
                  {multiPreview.unresolved.length > 0
                    ? ` · ${multiPreview.unresolved.length} 个未映射`
                    : ''}
                </span>
              </div>
              {folderKeys.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="当前题目层级没有可识别的文件夹"
                />
              ) : (
                <div className="batch-map-list">
                  {folderKeys.map((folder) => {
                    const auto = autoProblemId(folder, problemsById);
                    const selected = problemMap[folder] ?? auto ?? undefined;
                    return (
                      <div
                        className={`batch-map-row${
                          selected === undefined ? ' batch-map-row-unresolved' : ''
                        }`}
                        key={folder}
                      >
                        <span className="mono batch-map-folder">{folder}</span>
                        <span className="muted batch-map-auto">
                          {auto !== null ? '数字 ID 自动匹配' : '手动映射'}
                        </span>
                        <Select
                          allowClear={auto === null}
                          showSearch
                          optionFilterProp="label"
                          placeholder="选择题目"
                          value={selected}
                          options={problemOptions}
                          onChange={(value: number | undefined) =>
                            setProblemMap((previous) => ({
                              ...previous,
                              [folder]: value,
                            }))
                          }
                          loading={problemsQuery.isPending}
                          style={{ flex: 1, minWidth: 220 }}
                        />
                        {selected === undefined ? (
                          <Tag color="red">未映射</Tag>
                        ) : (
                          <Tag color="green">已映射</Tag>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : null}
          {uploadResult ? (
            <div className="batch-preview">
              <div className="batch-preview-head">
                <span>{multiProblem ? '学生 × 题目预览' : '解析预览'}</span>
                <span className="muted">
                  {multiProblem
                    ? `${multiPreview.studentCount} 位学生 × ${multiPreview.problemIds.length} 道题 · ${multiPreview.pairs.length} 条`
                    : `${parsedStudents.length} 位选手`}
                </span>
              </div>
              {multiProblem ? (
                multiPreview.pairs.length === 0 ? (
                  <Empty
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="当前层级没有可识别的“学生/题目”组合"
                  />
                ) : (
                  <div className="batch-preview-list">
                    {multiPreview.pairs.map((pair) => (
                      <div
                        className="batch-preview-row batch-preview-row-multi"
                        key={`${pair.student}|${pair.problemId}`}
                      >
                        <span className="batch-preview-student">{pair.student}</span>
                        <span className="batch-preview-problem">
                          {pair.problemTitle} · #{pair.problemId}
                        </span>
                        <span className="mono batch-preview-path" title={pair.path}>
                          {pair.path}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              ) : parsedStudents.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="当前层级没有可识别的选手"
                />
              ) : (
                <div className="batch-preview-list">
                  {parsedStudents.map((item) => (
                    <div className="batch-preview-row" key={item.student}>
                      <span className="batch-preview-student">{item.student}</span>
                      <span className="mono batch-preview-path" title={item.path}>
                        {item.path}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}
        </Card>

        <Card className="oij-card" title="3. 评测配置">
          {multiProblem ? (
            <Alert
              className="batch-alert"
              type="info"
              showIcon
              message="多题模式"
              description={`按“学生第 ${studentLevel} 层 / 题目第 ${problemLevel} 层”解析，每位学生的每道题生成一条提交；数值文件夹自动映射题目 ID，其余文件夹需在上方选择题目。`}
            />
          ) : (
            <div className="batch-field batch-problem-field">
              <span className="muted">题目</span>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder={problemsQuery.isPending ? '正在加载题目…' : '选择题目'}
                value={problemId}
                options={problemOptions}
                onChange={(value: number) => setProblemId(value)}
                style={{ width: '100%' }}
                loading={problemsQuery.isPending}
              />
            </div>
          )}
          {problemsQuery.isError ? (
            <Alert
              className="batch-alert"
              type="error"
              showIcon
              message="题目列表加载失败"
              description="请刷新页面重试。"
            />
          ) : null}
          <div className="batch-field">
            <span className="muted">语言</span>
            <Select
              value="cpp17"
              options={[{ value: 'cpp17', label: 'C++17' }]}
              style={{ width: 160 }}
              disabled
            />
          </div>
          <div className="batch-config-hint muted">
            {uploadResult
              ? multiProblem
                ? multiPreview.unresolved.length > 0
                  ? `有 ${multiPreview.unresolved.length} 个题目文件夹未映射：${multiPreview.unresolved.join('、')}，请先完成映射。`
                  : `将提交 ${multiPreview.studentCount} 位学生、${multiPreview.problemIds.length} 道题、共 ${multiPreview.pairs.length} 条提交。`
                : `将提交 ${parsedStudents.length} 位选手、共 ${sourcePaths.length} 个源文件。`
              : '请先上传 zip。'}
          </div>
          {runError ? (
            <Alert
              className="batch-alert"
              type="error"
              showIcon
              message="批量评测失败"
              description={runError}
            />
          ) : null}
          {batchRunning ? (
            <Alert
              className="batch-alert"
              type="info"
              showIcon
              message="评测进行中"
              description="批次未完成前不能重复提交；结果每 1 秒刷新。"
            />
          ) : null}
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={!canRun}
            loading={starting}
            onClick={() => void startBatch()}
          >
            开始批量评测
          </Button>
        </Card>
      </div>

      <Card
        className="oij-card batch-result"
        title={
          <Space>
            评测结果
            {job ? (
              <Tag
                color={
                  job.status === 'finished' ? 'green' : job.status === 'failed' ? 'red' : 'blue'
                }
              >
                {job.status === 'finished' ? '已完成' : job.status === 'failed' ? '失败' : '评测中'}
              </Tag>
            ) : null}
          </Space>
        }
        extra={
          <Space>
            {job?.status === 'running' ? <Spin size="small" /> : null}
            <Button
              icon={<DownloadOutlined />}
              loading={exporting}
              disabled={!job || job.status === 'running' || job.total === 0}
              onClick={() => void exportCsv()}
            >
              导出 CSV
            </Button>
          </Space>
        }
      >
        {batchId === null ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="上传 zip、选择题目并开始评测后，这里显示结果。"
          />
        ) : batchQuery.isPending ? (
          <PageLoading tip="正在提交并加载批次结果…" />
        ) : batchQuery.isError ? (
          <ErrorResult
            error={batchQuery.error}
            onRetry={() => void batchQuery.refetch()}
          />
        ) : job ? (
          <div>
            <div className="batch-result-meta muted">
              {job.multiProblem
                ? `批次 #${job.id} · 多题 · 学生层级 ${job.studentLevel} · 已评测 ${judgedCount} / ${job.importedCount}`
                : `批次 #${job.id} · 题目 #${job.problemId} · 层级 ${job.studentLevel} · 已评测 ${judgedCount} / ${job.importedCount}`}
              {` · 共 ${job.total} 条（跳过 ${skippedCount} · 失败 ${errorCount}）`}
            </div>
            <div className="batch-summary">
              <div className="batch-stat">
                <span className="batch-stat-value">{acCount}</span>
                <span className="muted">{resultMulti ? 'AC 数量' : 'AC 人数'}</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{totalStudents}</span>
                <span className="muted">总条目</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{job.importedCount}</span>
                <span className="muted">成功导入</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{skippedCount}</span>
                <span className="muted">跳过文件夹</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{errorCount}</span>
                <span className="muted">导入失败</span>
              </div>
              {resultMulti ? (
                <>
                  <div className="batch-stat">
                    <span className="batch-stat-value">{distinctStudentCount}</span>
                    <span className="muted">学生数</span>
                  </div>
                  <div className="batch-stat">
                    <span className="batch-stat-value">{distinctProblemCount}</span>
                    <span className="muted">题目数</span>
                  </div>
                </>
              ) : null}
              <div className="batch-stat">
                <span className="batch-stat-value">{averageScore.toFixed(1)}</span>
                <span className="muted">平均分</span>
              </div>
            </div>
            {skippedCount > 0 ? (
              <Alert
                className="batch-alert"
                type="warning"
                showIcon
                message={`跳过 ${skippedCount} 个无效学生文件夹`}
                description={
                  <FailureList items={job.skipped} total={skippedCount} tone="warning" />
                }
              />
            ) : null}
            {errorCount > 0 ? (
              <Alert
                className="batch-alert"
                type="error"
                showIcon
                message={`${errorCount} 条导入失败`}
                description={<FailureList items={job.errors} total={errorCount} tone="error" />}
              />
            ) : null}
            <Table<BatchResultItem>
              className="oij-table batch-result-table"
              rowKey={(item) => item.id}
              size="small"
              columns={columns}
              dataSource={job.items}
              pagination={{
                current: page,
                pageSize,
                total: job.total,
                showSizeChanger: true,
                pageSizeOptions: PAGE_SIZE_OPTIONS,
                showTotal: (total, range) => `${range[0]}-${range[1]} / 共 ${total} 条`,
                onChange: (nextPage, nextPageSize) => {
                  if (nextPageSize !== pageSize) {
                    setPageSize(nextPageSize);
                    setPage(1);
                  } else {
                    setPage(nextPage);
                  }
                },
              }}
              locale={{ emptyText: '本批次没有选手' }}
            />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
