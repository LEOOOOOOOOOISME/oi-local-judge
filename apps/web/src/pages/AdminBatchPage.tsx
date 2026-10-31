import { useMemo, useRef, useState, type DragEvent } from 'react';
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
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DownloadOutlined, InboxOutlined, PlayCircleOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, apiUpload } from '../api/client';
import type {
  AdminProblemSummary,
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

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set(['.cpp', '.cc', '.cxx']);
const LEVEL_OPTIONS = Array.from({ length: 6 }, (_, index) => ({
  value: index + 1,
  label: `第 ${index + 1} 层`,
}));

interface ParsedStudent {
  student: string;
  path: string;
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index).toLowerCase() : '';
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extensionOf(path));
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

function statusLabel(status: BatchResultItem['status']): string {
  if (status === 'missing') return '缺失';
  return SUBMISSION_STATUS_LABEL[status as SubmissionStatus] ?? status;
}

function statusColor(status: BatchResultItem['status']): string {
  if (status === 'missing') return 'red';
  if (status === 'finished') return 'green';
  if (status === 'failed' || status === 'canceled') return 'red';
  return 'blue';
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
        return '当前层级没有识别到 .cpp 源文件，请调整层级或检查 zip 目录结构。';
      case 'UPLOAD_NOT_FOUND':
        return '上传记录不存在，请重新上传 zip。';
      case 'BAD_UPLOAD_ID':
        return 'uploadId 无效，请重新上传 zip。';
      case 'PROBLEM_NOT_FOUND':
        return '题目不存在';
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
  const [problemId, setProblemId] = useState<number | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);

  const problemsQuery = useQuery({
    queryKey: ['admin-problems'],
    queryFn: () => apiGet<AdminProblemSummary[]>('/api/admin/problems'),
    staleTime: 30_000,
  });
  const batchQuery = useQuery({
    queryKey: ['batch', batchId],
    queryFn: () => apiGet<BatchJob>(`/api/admin/batch/${batchId}`),
    enabled: batchId !== null,
    retry: false,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1000;
      return data.status === 'running' ? 1000 : false;
    },
  });

  const job = batchQuery.data ?? null;
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

  const batchRunning = batchId !== null && job?.status !== 'finished';
  const canRun =
    Boolean(uploadResult) &&
    problemId !== undefined &&
    !starting &&
    !batchRunning;

  const uploadZip = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setUploadError('请选择 .zip 文件');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError('zip 超过 80 MB 限制');
      return;
    }
    setUploading(true);
    setUploadError(null);
    setRunError(null);
    setUploadResult(null);
    setBatchId(null);
    setUploadFileName(file.name);
    try {
      const result = await apiUpload<BatchUploadResult>(
        '/api/admin/batch/upload',
        file,
        'application/zip',
      );
      setUploadResult(result);
      setStudentLevel(1);
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
    if (!uploadResult || problemId === undefined || !canRun) return;
    setStarting(true);
    setRunError(null);
    try {
      const result = await apiPost<BatchRunResult>('/api/admin/batch/run', {
        uploadId: uploadResult.uploadId,
        problemId,
        studentLevel,
        language: 'cpp17',
      });
      setBatchId(result.id);
      message.success(`已提交 ${result.count} 份代码，开始评测`);
    } catch (error) {
      setRunError(describeBatchError(error));
      message.error(describeBatchError(error));
    } finally {
      setStarting(false);
    }
  };

  const exportCsv = () => {
    if (!job || job.items.length === 0) return;
    const header = ['选手', '源文件', '状态', 'Verdict', '得分', '用时(ms)', '内存(KB)'];
    const rows = job.items.map((item) => [
      item.student,
      item.sourcePath,
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
    message.success('CSV 已导出');
  };

  const columns: TableColumnsType<BatchResultItem> = [
    { title: '选手', dataIndex: 'student', width: 130 },
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
      title: '状态',
      dataIndex: 'status',
      width: 98,
      render: (value: BatchResultItem['status']) => (
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

  const acCount = (job?.items ?? []).filter((item) => item.verdict === 'AC').length;
  const totalStudents = job?.items.length ?? 0;
  const averageScore =
    totalStudents > 0
      ? (job?.items ?? []).reduce((sum, item) => sum + item.score, 0) / totalStudents
      : 0;
  const judgedCount =
    job?.items.filter((item) => item.status === 'finished' || item.status === 'failed')
      .length ?? 0;

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
            {uploadFileName || '支持 .zip，最大 80 MB；例如 Alice/main.cpp、Bob/main.cpp'}
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
          <div className="batch-level-hint muted">
            {uploadResult
              ? `zip 内路径最大深度 ${maxDepth}；当前取第 ${studentLevel} 层目录作为选手名。`
              : '上传 zip 后可调整层级。'}
          </div>
          <div className="batch-example">
            {example ? (
              <span>
                示例：<span className="mono">{example.path}</span> → 选手{' '}
                <strong>{example.student}</strong>
              </span>
            ) : uploadResult ? (
              <span className="batch-example-empty">
                当前层级无法解析出选手（源文件路径层级不足），请调小层级。
              </span>
            ) : (
              <span className="muted">等待上传 zip。</span>
            )}
          </div>
          {uploadResult ? (
            <div className="batch-preview">
              <div className="batch-preview-head">
                <span>解析预览</span>
                <span className="muted">{parsedStudents.length} 位选手</span>
              </div>
              {parsedStudents.length === 0 ? (
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
              ? `将提交 ${parsedStudents.length} 位选手、共 ${sourcePaths.length} 个源文件。`
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
              <Tag color={job.status === 'finished' ? 'green' : 'blue'}>
                {job.status === 'finished' ? '已完成' : '评测中'}
              </Tag>
            ) : null}
          </Space>
        }
        extra={
          <Space>
            {job?.status === 'running' ? <Spin size="small" /> : null}
            <Button
              icon={<DownloadOutlined />}
              disabled={!job || job.status !== 'finished' || job.items.length === 0}
              onClick={exportCsv}
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
              批次 #{job.id} · 题目 #{job.problemId} · 层级 {job.studentLevel} · 已评测{' '}
              {judgedCount} / {totalStudents}
            </div>
            <div className="batch-summary">
              <div className="batch-stat">
                <span className="batch-stat-value">{acCount}</span>
                <span className="muted">AC 人数</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{totalStudents}</span>
                <span className="muted">总人数</span>
              </div>
              <div className="batch-stat">
                <span className="batch-stat-value">{averageScore.toFixed(1)}</span>
                <span className="muted">平均分</span>
              </div>
            </div>
            <Table<BatchResultItem>
              className="oij-table"
              rowKey="student"
              size="small"
              columns={columns}
              dataSource={job.items}
              pagination={false}
              locale={{ emptyText: '本批次没有选手' }}
            />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
