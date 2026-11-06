import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Progress,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  DownloadOutlined,
  FileExcelOutlined,
  Html5Outlined,
  InboxOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
  TableOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { apiGet, apiPost, apiUploadWithProgress, downloadApiFile } from '../api/client';
import type {
  AdminProblemSummary,
  BatchAsyncRunResult,
  BatchExportFormat,
  BatchFailureItem,
  BatchImportStatus,
  BatchItemStatus,
  BatchJob,
  BatchPreview,
  BatchResultItem,
  BatchUploadStreamResult,
  SubmissionStatus,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { VerdictBadge } from '../components/VerdictBadge';
import {
  BATCH_PROBLEM_SCOPE_OPTIONS,
  applyOrderedMapping,
  autoProblemId,
  batchStatusColor,
  batchStatusLabel,
  describeBatchError,
  estimateSubmissions,
  filterProblems,
  isBatchActive,
  levelExample,
  MAX_BATCH_ZIP_BYTES,
  problemScope,
  treeSampleRows,
  validateFolderMapping,
  validateZipFile,
  type BatchProblemScope,
} from '../utils/batch';
import { formatBytes, formatMemoryKb, formatRunTime } from '../utils/format';
import { SUBMISSION_STATUS_LABEL } from '../utils/status';
import '../styles/admin.css';
import '../styles/batch.css';

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = ['20', '50', '100', '200'];

type LevelState = { studentLevel: number; problemLevel: number };

const SOURCE_SKIP_REASON_LABEL: Record<string, string> = {
  UNSAFE_PATH: '路径不安全',
  BATCH_FILE_TOO_LARGE: '单个文件超过 512 MB',
  ENTRY_ERROR: '压缩条目读取失败',
};

const ERROR_CODE_LABEL: Record<string, string> = {
  SOURCE_TOO_LARGE: '源码超过管理员上限',
  EMPTY_SOURCE: '源码为空',
  UNSUPPORTED_SOURCE: '题目类型不支持该源码',
  UNMAPPED_PROBLEM: '题目文件夹未映射',
  INVALID_STUDENT_FOLDER: '无效学生文件夹（缺少可用源码）',
  USER_CREATE_FAILED: '创建合成学生失败',
  SUBMIT_FAILED: '创建提交失败',
  UNSAFE_PATH: 'zip 路径不安全',
  EXTRACT_FAILED: '源码解压失败',
  BATCH_IMPORT_INTERRUPTED: '服务重启导致导入中断',
};

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

function errorCodeLabel(code: string | null | undefined): string {
  if (!code) return '—';
  return ERROR_CODE_LABEL[code] ?? code;
}

/** 导出格式 → 服务端查询串后缀 / 下载文件名后缀。 */
const EXPORT_REQUEST: Record<BatchExportFormat, { query: string; extension: string }> = {
  csv: { query: 'format=csv', extension: 'csv' },
  matrix: { query: 'format=csv&matrix=1', extension: 'matrix.csv' },
  xlsx: { query: 'format=xlsx', extension: 'xlsx' },
  html: { query: 'format=html', extension: 'html' },
};

/** 上传时文件名走请求头，必须转义成 ASCII；展示时还原。 */
function decodeFileName(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function problemOptionLabel(problem: AdminProblemSummary): string {
  const scope = problemScope(problem);
  const scopeLabel = scope === 'personal' ? '个人' : scope === 'team' ? '团队' : '公共';
  const tags = (problem.tags ?? []).slice(0, 3).join(',');
  return `#${problem.id} ${problem.title}（${scopeLabel}）${tags ? ` · ${tags}` : ''}`;
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

export function AdminBatchPage() {
  const { message, modal } = App.useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadLoaded, setUploadLoaded] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [fileName, setFileName] = useState('');
  const [upload, setUpload] = useState<BatchUploadStreamResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [levelDraft, setLevelDraft] = useState<LevelState>({
    studentLevel: 1,
    problemLevel: 0,
  });
  const [previewParams, setPreviewParams] = useState<LevelState | null>(null);
  const [scope, setScope] = useState<BatchProblemScope>('all');
  const [problemMap, setProblemMap] = useState<Record<string, number | undefined>>({});
  const [singleProblemId, setSingleProblemId] = useState<number | undefined>(undefined);
  const [orderedSelection, setOrderedSelection] = useState<number[]>([]);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [exportingFormat, setExportingFormat] = useState<BatchExportFormat | null>(null);
  const [canceling, setCanceling] = useState(false);

  const problemsQuery = useQuery({
    queryKey: ['admin-problems'],
    queryFn: () => apiGet<AdminProblemSummary[]>('/api/admin/problems'),
    staleTime: 30_000,
  });

  const previewQuery = useQuery({
    queryKey: [
      'batch-preview',
      upload?.uploadId ?? 'none',
      previewParams?.studentLevel ?? 0,
      previewParams?.problemLevel ?? 0,
    ],
    queryFn: () => {
      if (!upload || !previewParams) throw new Error('预览参数缺失');
      return apiGet<BatchPreview>(
        `/api/admin/batch/uploads/${upload.uploadId}/preview?studentLevel=${previewParams.studentLevel}&problemLevel=${previewParams.problemLevel}`,
      );
    },
    enabled: upload !== null && previewParams !== null,
    retry: false,
    staleTime: 5 * 60_000,
  });

  const jobQuery = useQuery({
    queryKey: ['batch', jobId, page, pageSize],
    queryFn: () =>
      apiGet<BatchJob>(
        `/api/admin/batch/${jobId}?offset=${(page - 1) * pageSize}&limit=${pageSize}`,
      ),
    enabled: jobId !== null,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1000;
      return isBatchActive(data.status) ? 1000 : false;
    },
  });

  const problems = problemsQuery.data ?? [];
  const problemsById = useMemo(
    () => new Map(problems.map((problem) => [problem.id, problem])),
    [problems],
  );
  const knownProblemIds = useMemo(() => new Set(problemsById.keys()), [problemsById]);

  const preview = previewQuery.data ?? null;
  const multiProblem = (previewParams?.problemLevel ?? 0) > 0;
  const folders = useMemo(() => preview?.problemFolders ?? [], [preview]);
  const maxDepth = preview?.maxDepth ?? 0;

  const levelOptions = useMemo(
    () =>
      Array.from({ length: Math.max(6, maxDepth) }, (_, index) => ({
        value: index + 1,
        label: `第 ${index + 1} 层`,
      })),
    [maxDepth],
  );

  const mapping = useMemo(
    () => validateFolderMapping(folders, problemMap, knownProblemIds),
    [folders, problemMap, knownProblemIds],
  );
  const estimate = useMemo(
    () =>
      estimateSubmissions({
        validCount: preview?.validCount ?? 0,
        multiProblem,
        folders,
        problemMap,
      }),
    [preview, multiProblem, folders, problemMap],
  );

  const scopedProblems = useMemo(
    () => filterProblems(problems, { scope, limit: 500 }),
    [problems, scope],
  );
  const problemOptions = useMemo(
    () => scopedProblems.map((problem) => ({ value: problem.id, label: problemOptionLabel(problem) })),
    [scopedProblems],
  );

  const mappedProblemIds = useMemo(() => {
    if (!multiProblem) return singleProblemId === undefined ? [] : [singleProblemId];
    return [
      ...new Set(
        folders
          .map((folder) => problemMap[folder])
          .filter((id): id is number => typeof id === 'number'),
      ),
    ].sort((left, right) => left - right);
  }, [multiProblem, singleProblemId, folders, problemMap]);

  const levelsDirty =
    previewParams !== null &&
    (levelDraft.studentLevel !== previewParams.studentLevel ||
      levelDraft.problemLevel !== previewParams.problemLevel);

  // 数字文件夹自动匹配题目 ID；保留用户已经手动选择的映射。
  useEffect(() => {
    if (!preview || preview.problemLevel <= 0) {
      setProblemMap((previous) => (Object.keys(previous).length === 0 ? previous : {}));
      return;
    }
    setProblemMap((previous) => {
      const next: Record<string, number | undefined> = {};
      for (const folder of preview.problemFolders) {
        const manual = previous[folder];
        if (typeof manual === 'number') {
          next[folder] = manual;
          continue;
        }
        const auto = autoProblemId(folder, knownProblemIds);
        if (auto !== null) next[folder] = auto;
      }
      return next;
    });
  }, [preview, knownProblemIds]);

  const job = jobQuery.data ?? null;
  const jobActive = job !== null && isBatchActive(job.status);

  const canStart =
    upload !== null &&
    preview !== null &&
    !uploading &&
    !starting &&
    !jobActive &&
    !problemsQuery.isError &&
    preview.validCount > 0 &&
    (multiProblem ? folders.length > 0 && mapping.complete : singleProblemId !== undefined);

  const resetMappingState = () => {
    setProblemMap({});
    setSingleProblemId(undefined);
    setOrderedSelection([]);
    setRunError(null);
  };

  const uploadZip = async (file: File) => {
    const validation = validateZipFile(file);
    if (validation) {
      setUploadError(validation);
      message.error(validation);
      return;
    }
    setUploading(true);
    setUploadError(null);
    setRunError(null);
    setUploadPercent(0);
    setUploadLoaded(0);
    setUploadTotal(file.size);
    setFileName(file.name);
    setUpload(null);
    setPreviewParams(null);
    setLevelDraft({ studentLevel: 1, problemLevel: 0 });
    resetMappingState();
    setJobId(null);
    setPage(1);
    try {
      const result = await apiUploadWithProgress<BatchUploadStreamResult>(
        '/api/admin/batch/uploads',
        file,
        'application/zip',
        {
          headers: { 'x-file-name': encodeURIComponent(file.name) },
          onProgress: ({ loaded, total, percent }) => {
            setUploadLoaded(loaded);
            setUploadTotal(total);
            setUploadPercent(percent);
          },
        },
      );
      setUploadPercent(100);
      setUpload(result);
      setPreviewParams({ studentLevel: 1, problemLevel: 0 });
      message.success(
        `zip 已流式上传（${formatBytes(result.sizeBytes)}），正在生成解析预览…`,
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const description = describeBatchError(error);
      setUploadError(description);
      message.error(description);
    } finally {
      setUploading(false);
    }
  };

  const handleFile = (file: File | undefined) => {
    if (!file || uploading) return;
    void uploadZip(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    handleFile(event.dataTransfer.files?.[0]);
  };

  const applyLevels = () => {
    const next: LevelState = {
      studentLevel: levelDraft.studentLevel,
      problemLevel: levelDraft.problemLevel,
    };
    resetMappingState();
    const same =
      previewParams !== null &&
      previewParams.studentLevel === next.studentLevel &&
      previewParams.problemLevel === next.problemLevel;
    if (same) {
      void previewQuery.refetch();
    } else {
      setPreviewParams(next);
    }
  };

  const applySuggestedLevels = () => {
    if (!preview) return;
    const next: LevelState = {
      studentLevel: preview.studentLevel,
      problemLevel: preview.studentLevel + 1,
    };
    setLevelDraft(next);
    resetMappingState();
    setPreviewParams(next);
  };

  const bindOrdered = () => {
    const ordered = orderedSelection.filter((id) => knownProblemIds.has(id));
    if (ordered.length === 0) return;
    setProblemMap((previous) => applyOrderedMapping(folders, ordered, previous));
    message.success(`已按顺序绑定 ${Math.min(ordered.length, folders.length)} 个题目文件夹`);
  };

  const bindNumeric = () => {
    const next: Record<string, number | undefined> = { ...problemMap };
    let bound = 0;
    for (const folder of folders) {
      const auto = autoProblemId(folder, knownProblemIds);
      if (auto !== null) {
        next[folder] = auto;
        bound += 1;
      }
    }
    setProblemMap(next);
    if (bound === 0) {
      message.info('没有可用数字 ID 自动匹配的文件夹');
    } else {
      message.success(`已按数字 ID 自动绑定 ${bound} 个文件夹`);
    }
  };

  const startBatch = async () => {
    if (!upload || !preview || !canStart) return;
    setStarting(true);
    setRunError(null);
    try {
      const body = multiProblem
        ? {
            studentLevel: preview.studentLevel,
            problemLevel: preview.problemLevel,
            language: 'cpp17',
            problemMap: Object.fromEntries(
              folders
                .map((folder) => [folder, problemMap[folder]] as const)
                .filter((entry): entry is readonly [string, number] => typeof entry[1] === 'number'),
            ),
          }
        : {
            studentLevel: preview.studentLevel,
            problemLevel: 0,
            language: 'cpp17',
            problemId: singleProblemId,
          };
      const result = await apiPost<BatchAsyncRunResult>(
        `/api/admin/batch/uploads/${upload.uploadId}/run`,
        body,
      );
      setJobId(result.jobId);
      setPage(1);
      message.success('已提交异步批量任务，正在后台导入并评测');
    } catch (error) {
      const description = describeBatchError(error);
      setRunError(description);
      message.error(description);
    } finally {
      setStarting(false);
    }
  };

  const cancelBatch = async () => {
    if (!job) return;
    setCanceling(true);
    try {
      await apiPost<{ id: number; status: string; canceled: number }>(
        `/api/admin/batch/${job.id}/cancel`,
      );
      message.success('已请求取消批次');
      await jobQuery.refetch();
    } catch (error) {
      message.error(describeBatchError(error));
    } finally {
      setCanceling(false);
    }
  };

  const confirmCancel = () => {
    if (!job) return;
    modal.confirm({
      title: `取消批次 #${job.id}？`,
      content: '已导入的提交会尽量取消并保留记录；取消后可以重新上传运行。',
      okText: '取消批次',
      okButtonProps: { danger: true },
      cancelText: '继续评测',
      onOk: () => cancelBatch(),
    });
  };

  const exportBatch = async (format: BatchExportFormat) => {
    if (!job || job.total === 0) return;
    setExportingFormat(format);
    try {
      const request = EXPORT_REQUEST[format];
      await downloadApiFile(
        `/api/admin/batch/${job.id}/export?${request.query}`,
        `batch-${job.id}.${request.extension}`,
      );
      message.success(
        format === 'matrix'
          ? '学生×题目矩阵已导出'
          : `${format.toUpperCase()} 已导出（由服务端流式生成）`,
      );
    } catch (error) {
      message.error(describeBatchError(error));
    } finally {
      setExportingFormat(null);
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

  const treeRows = useMemo(() => treeSampleRows(preview?.treeSample ?? []), [preview]);
  const example = useMemo(
    () =>
      preview
        ? levelExample(preview.treeSample, preview.studentLevel, preview.problemLevel)
        : null,
    [preview],
  );
  const importProgress = job?.progress?.import ?? null;
  const progressPercent =
    job?.progress?.percent ?? (job?.status === 'finished' ? 100 : 0);
  const progressStatus =
    job?.status === 'failed'
      ? 'exception'
      : job?.status === 'finished'
        ? 'success'
        : jobActive
          ? 'active'
          : 'normal';

  const scopeControl = (
    <Segmented
      size="small"
      value={scope}
      options={BATCH_PROBLEM_SCOPE_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
      }))}
      onChange={(value) => setScope(value as BatchProblemScope)}
    />
  );

  const problemSearchHint =
    scope === 'all'
      ? '搜索题号 / 标题 / 标签；可按 个人 / 团队 / 公共 过滤。'
      : `仅在${scope === 'personal' ? '个人' : scope === 'team' ? '团队' : '公共'}题目中搜索题号 / 标题 / 标签。`;

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理', to: '/admin/problems' }, { label: '批量评测' }]}
        title="批量评测"
        subtitle="流式上传选手代码 zip，预览目录结构，把题目文件夹映射到题目后异步导入并评测。"
        extra={
          <a href="/admin/problems">
            <Button>题目管理</Button>
          </a>
        }
      />

      <Card
        className="oij-card"
        title="1. 上传选手代码 zip"
        extra={<span className="muted">流式上传 · 最大 5 GB· 仅识别 .cpp / .cc / .cxx / .c</span>}
      >
        <div
          className={`batch-drop${dragActive ? ' batch-drop-active' : ''}${
            uploading ? ' batch-drop-busy' : ''
          }`}
          role="button"
          tabIndex={0}
          onClick={() => {
            if (!uploading) fileInputRef.current?.click();
          }}
          onKeyDown={(event) => {
            if (!uploading && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          onDragOver={(event) => {
            event.preventDefault();
            if (!uploading) setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={handleDrop}
        >
          {uploading ? <Spin /> : <InboxOutlined className="batch-drop-icon" />}
          <div className="batch-drop-title">
            {uploading
              ? '正在流式上传 zip…'
              : upload
                ? '拖拽或点击替换 zip 文件'
                : '拖拽选手代码 zip 到此，或点击选择文件'}
          </div>
          <div className="batch-drop-hint muted">
            {fileName || '支持 .zip，最大 5 GB；上传期间服务器边接收边落盘。'}
          </div>
        </div>
        <input
          ref={fileInputRef}
          className="admin-file-input"
          type="file"
          accept=".zip,application/zip"
          data-testid="batch-zip-input"
          disabled={uploading}
          onChange={(event) => {
            handleFile(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        {uploading ? (
          <div className="batch-upload-progress">
            <Progress percent={uploadPercent} status="active" />
            <div className="muted">
              {formatBytes(uploadLoaded)} / {formatBytes(uploadTotal)}
              {uploadTotal > 0 ? `（${uploadPercent}%）` : ''}
            </div>
          </div>
        ) : null}

        {uploadError ? (
          <Alert
            className="batch-alert"
            type="error"
            showIcon
            message="上传失败"
            description={uploadError}
          />
        ) : null}

        {upload ? (
          <div className="batch-upload-result">
            <div className="batch-upload-meta">
              <span>
                <span className="muted">文件</span> {decodeFileName(upload.originalName) || fileName}
              </span>
              <span>
                <span className="muted">uploadId</span>{' '}
                <span className="mono">{upload.uploadId}</span>
              </span>
              <span className="muted">
                {formatBytes(upload.sizeBytes)} · sha256{' '}
                <span className="mono">{upload.sha256.slice(0, 12)}…</span>
              </span>
            </div>
            <div className="muted">
              上传完成（上限 {MAX_BATCH_ZIP_BYTES / 1024 ** 3} GB），下一步解析目录层级并生成预览。
            </div>
          </div>
        ) : null}
      </Card>

      <Card
        className="oij-card batch-section"
        title="2. 目录层级与文件结构"
        extra={<span className="muted">按目录层级识别学生与题目文件夹</span>}
      >
        <div className="batch-level-bar">
          <div className="batch-field">
            <span className="muted">选手目录层级</span>
            <Select
              value={levelDraft.studentLevel}
              options={levelOptions}
              onChange={(value: number) =>
                setLevelDraft((previous) => ({ ...previous, studentLevel: value }))
              }
              style={{ width: 130 }}
              disabled={!upload || uploading}
            />
          </div>
          <div className="batch-field">
            <span className="muted">题目层级</span>
            <Select
              value={levelDraft.problemLevel}
              options={[
                { value: 0, label: '0（单题目模式）' },
                ...levelOptions.map((option) => ({
                  ...option,
                  label: `第 ${option.value} 层`,
                })),
              ]}
              onChange={(value: number) =>
                setLevelDraft((previous) => ({ ...previous, problemLevel: value }))
              }
              style={{ width: 170 }}
              disabled={!upload || uploading}
            />
          </div>
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={applyLevels}
            disabled={!upload || uploading}
            loading={previewQuery.isFetching && !previewQuery.isPending}
          >
            解析 / 重新解析
          </Button>
          {levelsDirty ? (
            <Tag color="orange">层级已修改，需重新解析</Tag>
          ) : preview ? (
            <Tag color="green">当前预览：学生第 {preview.studentLevel} 层 / 题目第 {preview.problemLevel} 层</Tag>
          ) : null}
        </div>
        <div className="batch-level-hint muted">
          {upload
            ? preview
              ? `zip 内路径最大深度 ${preview.maxDepth}；学生取第 ${preview.studentLevel} 层，题目取第 ${preview.problemLevel} 层目录。`
              : '层级确定后点击“解析 / 重新解析”生成预览。'
            : '上传 zip 后可调整层级。'}
          {preview && preview.problemLevel === 0 && preview.maxDepth > preview.studentLevel ? (
            <Button size="small" type="link" onClick={applySuggestedLevels}>
              按“学生 / 题目”结构解析（题目层级 = {preview.studentLevel + 1}）
            </Button>
          ) : null}
        </div>

        {!upload ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="上传 zip 后自动生成目录结构预览。"
          />
        ) : previewQuery.isPending ? (
          <PageLoading tip="正在流式扫描 zip 并生成预览…" />
        ) : previewQuery.isError ? (
          <ErrorResult
            error={previewQuery.error}
            onRetry={() => void previewQuery.refetch()}
          />
        ) : preview ? (
          <div>
            <div className="batch-preview-meta">
              <Tag>条目 {preview.entryCount}</Tag>
              <Tag>源文件 {preview.totalFiles}</Tag>
              <Tag color="blue">有效源码 {preview.validCount}</Tag>
              <Tag color="purple">学生 {preview.students}</Tag>
              <Tag color="green">题目文件夹 {preview.problemFolders.length}</Tag>
              {preview.invalidStudents.length > 0 ? (
                <Tag color="orange">无效学生 {preview.invalidStudents.length}</Tag>
              ) : null}
              {preview.duplicateCount > 0 ? (
                <Tag color="gold">重复 {preview.duplicateCount}</Tag>
              ) : null}
              {preview.skipped.length > 0 ? (
                <Tag color="red">跳过条目 {preview.skipped.length}</Tag>
              ) : null}
              {preview.failures.length > 0 ? (
                <Tag color="red">文件异常 {preview.failures.length}</Tag>
              ) : null}
            </div>

            <div className="batch-structure">
              <div className="batch-preview-head">
                <span>文件结构（路径示例）</span>
                <span className="muted">
                  前 {treeRows.length} 条 · 最大深度 {preview.maxDepth}
                </span>
              </div>
              {example ? (
                <div className="batch-example">
                  示例：<span className="mono">{example.path}</span> → 学生{' '}
                  <strong>{example.student}</strong>
                  {example.problemFolder ? (
                    <>
                      {' '}
                      · 题目文件夹 <strong>{example.problemFolder}</strong>
                    </>
                  ) : null}
                </div>
              ) : (
                <div className="batch-example batch-example-empty">
                  当前层级无法从路径样例中解析出“学生
                  {preview.problemLevel > 0 ? ' / 题目文件夹' : ''}”，请调整层级后重新解析。
                </div>
              )}
              {treeRows.length === 0 ? (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="没有可展示的路径样例"
                />
              ) : (
                <div className="batch-tree">
                  {treeRows.map((row) => (
                    <div
                      className="batch-tree-row"
                      key={row.path}
                      style={{ paddingLeft: row.depth * 14 }}
                    >
                      <span className="mono">{row.name}</span>
                      <span className="muted batch-tree-path">{row.path}</span>
                    </div>
                  ))}
                </div>
              )}
              {preview.studentSample.length > 0 ? (
                <div className="batch-student-sample muted">
                  学生示例：{preview.studentSample.slice(0, 8).join('、')}
                  {preview.students > 8 ? `…（共 ${preview.students} 人）` : ''}
                </div>
              ) : null}
            </div>

            <div className="batch-preview-columns">
              <div className="batch-report-block">
                <div className="batch-preview-head">
                  <span>无效学生（{preview.invalidStudents.length}）</span>
                  <span className="muted">丢弃，不阻塞整批</span>
                </div>
                {preview.invalidStudents.length === 0 ? (
                  <span className="muted">无</span>
                ) : (
                  <div className="batch-report-list">
                    {preview.invalidStudents.map((item) => (
                      <div className="batch-report-row" key={`${item.student}|${item.sourcePath}`}>
                        <span className="batch-report-name">{item.student}</span>
                        <Tag color="orange">{errorCodeLabel(item.reason)}</Tag>
                        <span className="muted mono batch-report-path" title={item.sourcePath}>
                          {item.sourcePath}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="batch-report-block">
                <div className="batch-preview-head">
                  <span>重复学生-题目（{preview.duplicateCount}）</span>
                  <span className="muted">同一学生-题目保留第一条</span>
                </div>
                {preview.duplicates.length === 0 ? (
                  <span className="muted">无</span>
                ) : (
                  <div className="batch-report-list">
                    {preview.duplicates.map((item) => (
                      <div
                        className="batch-report-row"
                        key={`${item.student}|${item.problemFolder}|${item.sourcePath}`}
                      >
                        <span className="batch-report-name">{item.student}</span>
                        <Tag>{item.problemFolder || '—'}</Tag>
                        <span className="muted mono batch-report-path" title={item.sourcePath}>
                          {item.sourcePath}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {preview.skipped.length > 0 ? (
                <div className="batch-report-block">
                  <div className="batch-preview-head">
                    <span>跳过的 zip 条目（{preview.skipped.length}）</span>
                    <span className="muted">继续解析其余文件</span>
                  </div>
                  <div className="batch-report-list">
                    {preview.skipped.map((item) => (
                      <div className="batch-report-row" key={`${item.path}|${item.reason}`}>
                        <Tag color="red">
                          {SOURCE_SKIP_REASON_LABEL[item.reason] ?? item.reason}
                        </Tag>
                        <span className="muted mono batch-report-path" title={item.path}>
                          {item.path}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {preview.failures.length > 0 ? (
                <div className="batch-report-block">
                  <div className="batch-preview-head">
                    <span>文件级异常（{preview.failures.length}）</span>
                    <span className="muted">导入时逐条记录</span>
                  </div>
                  <div className="batch-report-list">
                    {preview.failures.map((item) => (
                      <div
                        className="batch-report-row"
                        key={`${item.student}|${item.sourcePath}|${item.errorCode}`}
                      >
                        <span className="batch-report-name">{item.student}</span>
                        <Tag color="red">{errorCodeLabel(item.errorCode)}</Tag>
                        <span className="muted mono batch-report-path" title={item.sourcePath}>
                          {item.sourcePath}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Card>

      <Card
        className="oij-card batch-section"
        title="3. 题目映射"
        extra={<span className="muted">未映射禁止开始</span>}
      >
        {!preview ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="先上传 zip 并完成目录解析。"
          />
        ) : problemsQuery.isError ? (
          <Alert
            className="batch-alert"
            type="error"
            showIcon
            message="题目列表加载失败"
            description="题目选择器不可用，请刷新页面重试。"
          />
        ) : multiProblem ? (
          <div>
            <Alert
              className="batch-alert"
              type="info"
              showIcon
              message="多题目模式"
              description={`每个题目文件夹一行。数字文件夹会自动匹配题目 ID；其余请手动选择，或按顺序批量绑定。当前 ${folders.length} 个题目文件夹。`}
            />

            <div className="batch-map-toolbar">
              <div className="batch-map-scope">
                <span className="muted">题目来源</span>
                {scopeControl}
              </div>
              <div className="batch-map-order">
                <span className="muted">按顺序批量绑定</span>
                <Select
                  mode="multiple"
                  showSearch
                  allowClear
                  optionFilterProp="label"
                  placeholder="按题目顺序选择：第 1 道 → 第 1 个文件夹"
                  value={orderedSelection}
                  options={problemOptions}
                  onChange={(values: number[]) => setOrderedSelection(values)}
                  style={{ width: '100%' }}
                  loading={problemsQuery.isPending}
                />
                <Space wrap>
                  <Button
                    onClick={bindOrdered}
                    disabled={orderedSelection.length === 0 || folders.length === 0}
                  >
                    按顺序绑定
                  </Button>
                  <Button
                    onClick={bindNumeric}
                    disabled={folders.length === 0 || knownProblemIds.size === 0}
                  >
                    数字 ID 自动绑定
                  </Button>
                  <Button
                    type="text"
                    danger
                    onClick={() => {
                      resetMappingState();
                      setProblemMap({});
                    }}
                    disabled={Object.keys(problemMap).length === 0}
                  >
                    清空映射
                  </Button>
                </Space>
                {orderedSelection.length > 0 ? (
                  <div className="batch-order-preview">
                    {orderedSelection.map((id, index) => (
                      <Tag key={`${id}-${index}`} color="blue">
                        {index + 1}. #{id} {problemsById.get(id)?.title ?? '未知题目'}
                      </Tag>
                    ))}
                  </div>
                ) : null}
                <span className="muted batch-search-hint">{problemSearchHint}</span>
              </div>
            </div>

            {folders.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="当前题目层级没有识别到题目文件夹，请调整层级后重新解析。"
              />
            ) : (
              <div className="batch-map-list">
                {folders.map((folder) => {
                  const auto = autoProblemId(folder, knownProblemIds);
                  const selected = problemMap[folder];
                  return (
                    <div
                      className={`batch-map-row${
                        selected === undefined ? ' batch-map-row-unresolved' : ''
                      }`}
                      key={folder}
                    >
                      <span className="mono batch-map-folder" title={folder}>
                        {folder}
                      </span>
                      <span className="muted batch-map-auto">
                        {auto !== null ? `数字 ID 自动匹配 #${auto}` : '手动映射'}
                      </span>
                      <Select
                        allowClear
                        showSearch
                        optionFilterProp="label"
                        placeholder="选择题目"
                        value={selected}
                        options={problemOptions}
                        onChange={(value: number | undefined) =>
                          setProblemMap((previous) => ({ ...previous, [folder]: value }))
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

            <div className="batch-mapping-status">
              <span>
                已映射{' '}
                <strong>
                  {folders.length - mapping.unmapped.length - mapping.unknown.length}
                </strong>{' '}
                / {folders.length}
              </span>
              <span>已选 {mappedProblemIds.length} 道题</span>
              <span className="mono">
                预计提交 {estimate.submissions} 条{estimate.exact ? '' : '（上界）'}
              </span>
            </div>

            {mapping.unmapped.length > 0 ? (
              <Alert
                className="batch-alert"
                type="warning"
                showIcon
                message={`还有 ${mapping.unmapped.length} 个题目文件夹未映射，不能开始`}
                description={mapping.unmapped.join('、')}
              />
            ) : null}
            {mapping.unknown.length > 0 ? (
              <Alert
                className="batch-alert"
                type="error"
                showIcon
                message="映射到了题目目录中不存在的题目"
                description={`${mapping.unknown.join('、')}；请重新选择题目后开始。`}
              />
            ) : null}
            {mapping.duplicateProblems.length > 0 ? (
              <Alert
                className="batch-alert"
                type="info"
                showIcon
                message="多个文件夹映射到同一题目"
                description={`题目 ${mapping.duplicateProblems
                  .map((id) => `#${id}`)
                  .join('、')} 被多个文件夹选中；导入时会按“学生-题目”去重，实际提交数可能少于 ${estimate.submissions}。`}
              />
            ) : null}
          </div>
        ) : (
          <div>
            <Alert
              className="batch-alert"
              type="info"
              showIcon
              message="单题目模式"
              description={`题目层级为 0：第 ${preview.studentLevel} 层目录作为学生，所有有效源码提交到同一道题。若要按文件夹映射多道题，请把题目层级设为 > 0。`}
            />
            <div className="batch-map-toolbar">
              <div className="batch-map-scope">
                <span className="muted">题目来源</span>
                {scopeControl}
              </div>
            </div>
            <div className="batch-field batch-single-problem">
              <span className="muted">题目</span>
              <Select
                showSearch
                optionFilterProp="label"
                placeholder={problemsQuery.isPending ? '正在加载题目…' : '搜索并选择题目'}
                value={singleProblemId}
                options={problemOptions}
                onChange={(value: number) => setSingleProblemId(value)}
                style={{ width: '100%' }}
                loading={problemsQuery.isPending}
              />
            </div>
            <span className="muted batch-search-hint">{problemSearchHint}</span>
            <div className="batch-mapping-status">
              <span>有效源码 {preview.validCount} 条</span>
              <span>已选 {mappedProblemIds.length} 道题</span>
              <span className="mono">预计提交 {estimate.submissions} 条</span>
            </div>
          </div>
        )}

        {preview ? (
          <div className="batch-estimate">
            <div className="batch-estimate-numbers">
              <div>
                <span className="batch-stat-value">{preview.students}</span>
                <span className="muted">位学生</span>
              </div>
              <span className="batch-estimate-op">×</span>
              <div>
                <span className="batch-stat-value">{mappedProblemIds.length}</span>
                <span className="muted">道题目</span>
              </div>
              <span className="batch-estimate-op">=</span>
              <div>
                <span className="batch-stat-value">{estimate.submissions}</span>
                <span className="muted">条提交</span>
              </div>
            </div>
            <span className="muted batch-estimate-hint">
              后端预览结构有效源码 {preview.validCount} 条
              {estimate.exact ? '，按当前映射预计全部导入。' : '；存在未映射或重复映射时，实际数量可能更少。'}
            </span>
          </div>
        ) : null}

        {runError ? (
          <Alert
            className="batch-alert"
            type="error"
            showIcon
            message="提交批量任务失败"
            description={runError}
          />
        ) : null}
        {jobActive ? (
          <Alert
            className="batch-alert"
            type="info"
            showIcon
            message="评测进行中"
            description="当前上传已有未完成的批次；完成或取消后才能再次运行。结果每 1 秒刷新。"
          />
        ) : null}

        <div className="batch-run-bar">
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={!canStart}
            loading={starting}
            onClick={() => void startBatch()}
          >
            开始批量评测
          </Button>
          {preview && !canStart ? (
            <span className="muted">
              {multiProblem
                ? mapping.unmapped.length > 0
                  ? `还有 ${mapping.unmapped.length} 个题目文件夹未映射`
                  : mapping.unknown.length > 0
                    ? '映射中包含题目目录里不存在的题目'
                    : preview.validCount === 0
                      ? '当前层级没有结构有效的源码'
                      : jobActive
                        ? '当前批次仍在运行'
                        : '请先完成题目映射'
                : singleProblemId === undefined
                  ? '请先选择题目'
                  : preview.validCount === 0
                    ? '当前层级没有结构有效的源码'
                    : jobActive
                      ? '当前批次仍在运行'
                      : '暂时无法开始'}
            </span>
          ) : null}
        </div>
      </Card>

      <Card
        className="oij-card batch-result"
        title={
          <Space>
            4. 运行结果
            {job ? <Tag color={batchStatusColor(job.status)}>{batchStatusLabel(job.status)}</Tag> : null}
          </Space>
        }
        extra={
          <Space wrap size={[8, 8]}>
            {jobActive ? <Spin size="small" /> : null}
            <Button
              danger
              icon={<StopOutlined />}
              loading={canceling}
              disabled={!job || !jobActive}
              onClick={confirmCancel}
            >
              取消批次
            </Button>
            <Button
              icon={<DownloadOutlined />}
              loading={exportingFormat === 'csv'}
              disabled={
                !job || jobActive || job.total === 0 || exportingFormat !== null
              }
              onClick={() => void exportBatch('csv')}
            >
              导出 CSV
            </Button>
            <Button
              icon={<TableOutlined />}
              loading={exportingFormat === 'matrix'}
              disabled={
                !job || jobActive || job.total === 0 || exportingFormat !== null
              }
              onClick={() => void exportBatch('matrix')}
            >
              矩阵 CSV
            </Button>
            <Button
              icon={<FileExcelOutlined />}
              loading={exportingFormat === 'xlsx'}
              disabled={
                !job || jobActive || job.total === 0 || exportingFormat !== null
              }
              onClick={() => void exportBatch('xlsx')}
            >
              导出 Excel
            </Button>
            <Button
              icon={<Html5Outlined />}
              loading={exportingFormat === 'html'}
              disabled={
                !job || jobActive || job.total === 0 || exportingFormat !== null
              }
              onClick={() => void exportBatch('html')}
            >
              导出 HTML
            </Button>
          </Space>
        }
      >
        {jobId === null ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="完成题目映射并开始评测后，这里显示导入进度、分页结果和失败明细。"
          />
        ) : jobQuery.isPending ? (
          <PageLoading tip="正在加载批次进度…" />
        ) : jobQuery.isError ? (
          <ErrorResult error={jobQuery.error} onRetry={() => void jobQuery.refetch()} />
        ) : job ? (
          <div>
            <div className="batch-result-meta muted">
              {job.multiProblem
                ? `批次 #${job.id} · 多题 · 学生层级 ${job.studentLevel}`
                : `批次 #${job.id} · 题目 #${job.problemId} · 层级 ${job.studentLevel}`}
              {job.uploadId ? ` · upload ${job.uploadId.slice(0, 8)}…` : ''}
              {` · 状态 ${batchStatusLabel(job.status)}`}
            </div>

            <div className="batch-progress">
              <div className="batch-progress-head">
                <span>
                  {job.status === 'importing'
                    ? '导入进度'
                    : job.status === 'finished'
                      ? '评测完成'
                      : isBatchActive(job.status)
                        ? '评测进度'
                        : '批次进度'}
                </span>
                <span className="muted">
                  {job.status === 'importing' && importProgress
                    ? `已处理 ${importProgress.processed} / ${importProgress.totalCandidates} 条源码`
                    : `已评测 ${job.judgedCount} / ${job.importedCount}`}
                </span>
              </div>
              <Progress
                percent={progressPercent}
                status={progressStatus}
                strokeWidth={10}
              />
            </div>

            {job.status === 'failed' ? (
              <Alert
                className="batch-alert"
                type="error"
                showIcon
                message="批次失败"
                description="导入过程中出现整批级错误（如 zip 损坏、服务重启）。请重新上传后运行，已写入的逐条失败记录仍可在下方查看。"
              />
            ) : job.status === 'canceled' ? (
              <Alert
                className="batch-alert"
                type="warning"
                showIcon
                message="批次已取消"
                description="已导入的提交已尽量取消；可以重新上传并运行。"
              />
            ) : null}

            <div className="batch-summary">
              <div className="batch-stat">
                <span className="batch-stat-value">{job.acCount}</span>
                <span className="muted">{job.multiProblem ? 'AC 数量' : 'AC 人数'}</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{job.total}</span>
                <span className="muted">总条目</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{job.importedCount}</span>
                <span className="muted">成功导入</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{job.skippedCount}</span>
                <span className="muted">跳过</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{job.errorCount}</span>
                <span className="muted">导入失败</span>
              </div>
              {job.multiProblem ? (
                <>
                  <div className="batch-stat">
                    <span className="batch-stat-value">{job.distinctStudentCount}</span>
                    <span className="muted">学生数</span>
                  </div>
                  <div className="batch-stat">
                    <span className="batch-stat-value">{job.distinctProblemCount}</span>
                    <span className="muted">题目数</span>
                  </div>
                </>
              ) : null}
              <div className="batch-stat">
                <span className="batch-stat-value">{job.averageScore.toFixed(1)}</span>
                <span className="muted">平均分</span>
              </div>
            </div>

            {job.skippedCount > 0 ? (
              <Alert
                className="batch-alert"
                type="warning"
                showIcon
                message={`跳过 ${job.skippedCount} 个无效学生文件夹`}
                description={<FailureList items={job.skipped} total={job.skippedCount} tone="warning" />}
              />
            ) : null}
            {job.errorCount > 0 ? (
              <Alert
                className="batch-alert"
                type="error"
                showIcon
                message={`${job.errorCount} 条导入失败`}
                description={<FailureList items={job.errors} total={job.errorCount} tone="error" />}
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
