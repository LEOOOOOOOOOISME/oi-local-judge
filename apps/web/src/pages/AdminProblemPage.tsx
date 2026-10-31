import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Divider,
  Empty,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CodeOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPost, apiPut, apiUpload } from '../api/client';
import type {
  AdminDataImportResult,
  AdminTestcase,
  AssetKind,
  CompileAssetResult,
  ProblemAsset,
  ProblemAssetSource,
  ProblemDetail,
} from '../api/types';
import { CodeBlock } from '../components/CodeBlock';
import { MetaList } from '../components/MetaList';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { StatementHtml } from '../components/StatementHtml';
import {
  formatBytes,
  formatDateTime,
  formatMemoryLimit,
  formatTimeLimit,
} from '../utils/format';
import { difficultyLabel, problemTypeLabel } from '../utils/status';
import '../styles/admin.css';

const MAX_UPLOAD_BYTES = 80 * 1024 * 1024;
const ALLOWED_SOURCE_ACCEPT = '.cpp,.cc,.cxx,.c,.py,.exe,.txt';

const ASSET_META: Record<AssetKind, { label: string; hint: string }> = {
  std: { label: '标准程序', hint: '标准答案 / 对拍基准，上传后编译为可执行文件。' },
  checker: { label: '校验器', hint: '自定义 SPJ 源码，支持 testlib 或 Lemon 六参数模式。' },
  validator: { label: '输入校验器', hint: '校验输入数据合法性（运行接入 Phase 1E）。' },
  generator: { label: '数据生成器', hint: '批量生成测试数据（运行接入 Phase 1E）。' },
  interactor: { label: '交互器', hint: '交互题评测器（运行接入 Phase 1E）。' },
  judger: { label: '自定义评测器', hint: '完整评测流程程序（运行接入 Phase 1E）。' },
  brute: { label: '暴力程序', hint: '对拍用暴力程序（运行接入 Phase 1E）。' },
};

const ASSET_ORDER: AssetKind[] = [
  'std',
  'checker',
  'validator',
  'generator',
  'interactor',
  'judger',
  'brute',
];

type KindMap<T> = Partial<Record<AssetKind, T>>;

function describeImportError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'MISSING_OUTPUTS':
        return `缺少输出文件：${error.message}`;
      case 'UNSAFE_PATH':
        return `zip 内含不安全路径：${error.message}`;
      case 'NO_INPUTS':
        return 'zip 内没有 .in 输入文件';
      case 'BAD_ZIP':
        return `无法解析 zip：${error.message}`;
      case 'EMPTY_BODY':
        return 'zip 文件为空';
      case 'PROBLEM_NOT_FOUND':
        return '题目不存在';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '导入失败';
}

export function AdminProblemPage() {
  const params = useParams<{ problemId: string }>();
  const problemId = Number(params.problemId);
  const validId = Number.isInteger(problemId) && problemId > 0;
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('basic');

  const [uploading, setUploading] = useState<KindMap<boolean>>({});
  const [compiling, setCompiling] = useState<KindMap<boolean>>({});
  const [deleting, setDeleting] = useState<KindMap<boolean>>({});
  const [compileResults, setCompileResults] = useState<KindMap<CompileAssetResult>>({});
  const [checkerMode, setCheckerMode] = useState<'testlib' | 'lemon'>('testlib');
  const fileInputs = useRef<Partial<Record<AssetKind, HTMLInputElement | null>>>({});

  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceKind, setSourceKind] = useState<AssetKind>('std');
  const [sourceName, setSourceName] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [zipFile, setZipFile] = useState<File | null>(null);
  const [importPoints, setImportPoints] = useState<number>(100);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<AdminDataImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const [pointsDraft, setPointsDraft] = useState<Record<number, number>>({});
  const [savingPoints, setSavingPoints] = useState(false);

  const problemQuery = useQuery({
    queryKey: ['problem', problemId],
    queryFn: () => apiGet<ProblemDetail>(`/api/problems/${problemId}`),
    enabled: validId,
  });
  const assetsQuery = useQuery({
    queryKey: ['admin-assets', problemId],
    queryFn: () => apiGet<ProblemAsset[]>(`/api/admin/problems/${problemId}/assets`),
    enabled: validId,
  });
  const testcasesQuery = useQuery({
    queryKey: ['admin-testcases', problemId],
    queryFn: () => apiGet<AdminTestcase[]>(`/api/admin/problems/${problemId}/testcases`),
    enabled: validId,
  });

  useEffect(() => {
    if (!testcasesQuery.data) return;
    setPointsDraft(
      Object.fromEntries(testcasesQuery.data.map((row) => [row.id, row.points])),
    );
  }, [testcasesQuery.data]);

  const invalidateAssets = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin-assets', problemId] });
  };

  const uploadAsset = async (kind: AssetKind, file: File) => {
    if (file.size > MAX_UPLOAD_BYTES) {
      message.error('文件超过 80 MB 限制');
      return;
    }
    setUploading((previous) => ({ ...previous, [kind]: true }));
    try {
      const search = new URLSearchParams({ name: file.name });
      if (kind === 'checker') search.set('mode', checkerMode);
      await apiUpload<ProblemAsset>(
        `/api/admin/problems/${problemId}/assets/${kind}?${search.toString()}`,
        file,
        'application/octet-stream',
      );
      message.success(`${ASSET_META[kind].label}已上传`);
      setCompileResults((previous) => {
        const next = { ...previous };
        delete next[kind];
        return next;
      });
      invalidateAssets();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '上传失败');
    } finally {
      setUploading((previous) => ({ ...previous, [kind]: false }));
    }
  };

  const compileAsset = async (kind: AssetKind) => {
    setCompiling((previous) => ({ ...previous, [kind]: true }));
    try {
      const result = await apiPost<CompileAssetResult>(
        `/api/admin/problems/${problemId}/assets/${kind}/compile`,
      );
      setCompileResults((previous) => ({ ...previous, [kind]: result }));
      if (result.compiled) {
        message.success(result.cached ? '编译成功（缓存命中）' : '编译成功');
      } else {
        message.error('编译失败');
      }
    } catch (error) {
      const result: CompileAssetResult = {
        compiled: false,
        message: error instanceof Error ? error.message : '编译请求失败',
      };
      setCompileResults((previous) => ({ ...previous, [kind]: result }));
      message.error(result.message);
    } finally {
      setCompiling((previous) => ({ ...previous, [kind]: false }));
    }
  };

  const openSource = async (kind: AssetKind) => {
    setSourceOpen(true);
    setSourceLoading(true);
    setSourceKind(kind);
    setSourceName('');
    setSourceText('');
    setSourceError(null);
    try {
      const data = await apiGet<ProblemAssetSource>(
        `/api/admin/problems/${problemId}/assets/${kind}/source`,
      );
      setSourceName(data.name);
      setSourceText(data.source);
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : '读取源码失败');
    } finally {
      setSourceLoading(false);
    }
  };

  const removeAsset = async (kind: AssetKind) => {
    setDeleting((previous) => ({ ...previous, [kind]: true }));
    try {
      await apiDelete<null>(`/api/admin/problems/${problemId}/assets/${kind}`);
      message.success(`${ASSET_META[kind].label}已删除`);
      setCompileResults((previous) => {
        const next = { ...previous };
        delete next[kind];
        return next;
      });
      invalidateAssets();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '删除失败');
    } finally {
      setDeleting((previous) => ({ ...previous, [kind]: false }));
    }
  };

  const handleAssetDrop = (event: DragEvent<HTMLDivElement>, kind: AssetKind) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void uploadAsset(kind, file);
  };

  const importData = async () => {
    if (!zipFile) {
      message.warning('请选择 zip 文件');
      return;
    }
    setImporting(true);
    setImportError(null);
    try {
      const result = await apiUpload<AdminDataImportResult>(
        `/api/admin/problems/${problemId}/data/import?points=${encodeURIComponent(
          String(importPoints),
        )}`,
        zipFile,
        'application/zip',
      );
      setImportResult(result);
      setZipFile(null);
      if (zipInputRef.current) zipInputRef.current.value = '';
      message.success(`已导入 ${result.testcases.length} 个测试点`);
      void queryClient.invalidateQueries({ queryKey: ['admin-testcases', problemId] });
    } catch (error) {
      const text = describeImportError(error);
      setImportError(text);
      message.error(text);
    } finally {
      setImporting(false);
    }
  };

  const testcases = testcasesQuery.data ?? [];
  const pointsDirty = testcases.some(
    (row) => (pointsDraft[row.id] ?? row.points) !== row.points,
  );
  const totalDraftPoints = testcases.reduce(
    (sum, row) => sum + (pointsDraft[row.id] ?? row.points),
    0,
  );

  const savePoints = async () => {
    const items = testcases.map((row) => ({
      id: row.id,
      points: Number(pointsDraft[row.id] ?? row.points),
    }));
    if (items.some((item) => !Number.isFinite(item.points) || item.points < 0)) {
      message.error('分值必须是非负数字');
      return;
    }
    setSavingPoints(true);
    try {
      await apiPut<null>(`/api/admin/problems/${problemId}/testcases`, { items });
      message.success('测试点分值已保存');
      void queryClient.invalidateQueries({ queryKey: ['admin-testcases', problemId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存分值失败');
    } finally {
      setSavingPoints(false);
    }
  };

  if (!validId) {
    return <ErrorResult error={new Error('无效的题目编号')} />;
  }
  if (problemQuery.isPending) {
    return <PageLoading tip="正在加载题目…" />;
  }
  if (problemQuery.isError) {
    return (
      <ErrorResult error={problemQuery.error} onRetry={() => void problemQuery.refetch()} />
    );
  }
  const problem = problemQuery.data;
  if (!problem) {
    return <PageLoading tip="正在加载题目…" />;
  }

  const assetsById = new Map((assetsQuery.data ?? []).map((asset) => [asset.kind, asset]));

  const basicPanel = (
    <Card className="oij-card">
      <MetaList
        items={[
          { label: '题目 ID', value: `#${problem.id}` },
          { label: '标题', value: problem.title },
          { label: '类型', value: problemTypeLabel(problem.type) },
          { label: '时间限制', value: formatTimeLimit(problem.timeMs) },
          { label: '内存限制', value: formatMemoryLimit(problem.memoryMb) },
          {
            label: 'IO 模式',
            value:
              problem.ioMode === 'file'
                ? `文件：${problem.inputFile ?? '—'} / ${problem.outputFile ?? '—'}`
                : '标准输入输出',
          },
          { label: '难度', value: difficultyLabel(problem.difficulty) },
          {
            label: '标签',
            value:
              problem.tags.length === 0 ? (
                <span className="muted">—</span>
              ) : (
                <span className="tag-list">
                  {problem.tags.map((tag) => (
                    <Tag key={tag} bordered={false}>
                      {tag}
                    </Tag>
                  ))}
                </span>
              ),
          },
          { label: '测试点', value: testcases.length > 0 ? `${testcases.length} 个` : '尚未导入' },
        ]}
      />
      <Divider orientation="left">题面预览</Divider>
      {problem.statementHtml.trim().length > 0 ? (
        <div className="admin-statement">
          <StatementHtml html={problem.statementHtml} />
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无题面" />
      )}
    </Card>
  );

  const assetsPanel = (
    <Card
      className="oij-card"
      title="程序资产"
      extra={<span className="muted">每个类型只保留最新一份，重新上传会覆盖</span>}
    >
      {assetsQuery.isPending ? (
        <div className="inline-loading">
          <Spin />
        </div>
      ) : assetsQuery.isError ? (
        <ErrorResult error={assetsQuery.error} onRetry={() => void assetsQuery.refetch()} />
      ) : (
        <div className="asset-grid">
          {ASSET_ORDER.map((kind) => {
            const meta = ASSET_META[kind];
            const asset = assetsById.get(kind);
            const compileResult = compileResults[kind];
            const busy = Boolean(uploading[kind] || compiling[kind] || deleting[kind]);
            return (
              <Card
                key={kind}
                size="small"
                className="asset-card"
                title={
                  <span className="asset-title">
                    {meta.label}
                    <span className="asset-kind mono">{kind}</span>
                  </span>
                }
                extra={asset ? <Tag color="green">已上传</Tag> : <Tag>未上传</Tag>}
              >
                <div className="asset-hint">{meta.hint}</div>

                {asset ? (
                  <div className="asset-meta">
                    <div>
                      <span className="muted">文件</span>{' '}
                      <span className="mono asset-name" title={asset.name}>
                        {asset.name}
                      </span>
                    </div>
                    <div>
                      <span className="muted">大小</span> {formatBytes(asset.size)}
                    </div>
                    <div>
                      <span className="muted">SHA256</span>{' '}
                      <Tooltip title={asset.sha256}>
                        <span className="mono">{asset.sha256.slice(0, 12)}…</span>
                      </Tooltip>
                    </div>
                    <div>
                      <span className="muted">更新</span> {formatDateTime(asset.updated_at)}
                    </div>
                  </div>
                ) : null}

                {kind === 'checker' ? (
                  <div className="asset-mode">
                    <span className="muted">SPJ 模式</span>
                    <Select
                      size="small"
                      value={checkerMode}
                      onChange={(value: 'testlib' | 'lemon') => setCheckerMode(value)}
                      options={[
                        { value: 'testlib', label: 'testlib' },
                        { value: 'lemon', label: 'lemon 六参数' },
                      ]}
                      style={{ width: 128 }}
                      disabled={busy}
                    />
                  </div>
                ) : null}

                {asset ? (
                  <Space wrap size={8} className="asset-actions">
                    <Button
                      size="small"
                      icon={<CodeOutlined />}
                      onClick={() => void openSource(kind)}
                    >
                      查看源码
                    </Button>
                    <Button
                      size="small"
                      icon={<PlayCircleOutlined />}
                      loading={Boolean(compiling[kind])}
                      onClick={() => void compileAsset(kind)}
                    >
                      编译
                    </Button>
                    <Popconfirm
                      title={`删除${meta.label}？`}
                      description="会同时删除已上传的源文件，且不可恢复。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => void removeAsset(kind)}
                    >
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        loading={Boolean(deleting[kind])}
                      >
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ) : null}

                {compileResult ? (
                  <Alert
                    className="asset-compile"
                    type={compileResult.compiled ? 'success' : 'error'}
                    showIcon
                    message={
                      compileResult.compiled
                        ? `编译成功${compileResult.cached ? '（缓存命中）' : ''}`
                        : '编译失败'
                    }
                    description={compileResult.message || undefined}
                  />
                ) : null}

                <div
                  className={`asset-drop${uploading[kind] ? ' asset-drop-busy' : ''}`}
                  role="button"
                  tabIndex={0}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => handleAssetDrop(event, kind)}
                  onClick={() => fileInputs.current[kind]?.click()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      fileInputs.current[kind]?.click();
                    }
                  }}
                >
                  {uploading[kind] ? (
                    <Spin size="small" />
                  ) : (
                    <span>{asset ? '拖拽或点击替换文件' : '拖拽或点击上传文件'}</span>
                  )}
                  <span className="asset-drop-hint muted">
                    .cpp / .cc / .cxx / .c / .py / .exe / .txt（≤ 80 MB）
                  </span>
                </div>
                <input
                  ref={(element) => {
                    fileInputs.current[kind] = element;
                  }}
                  className="admin-file-input"
                  type="file"
                  accept={ALLOWED_SOURCE_ACCEPT}
                  data-testid={`asset-input-${kind}`}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadAsset(kind, file);
                    event.target.value = '';
                  }}
                />
              </Card>
            );
          })}
        </div>
      )}
    </Card>
  );

  const testcaseColumns: TableColumnsType<AdminTestcase> = [
    {
      title: '#',
      dataIndex: 'ordinal',
      width: 56,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '输入',
      dataIndex: 'input_path',
      render: (value: string) => (
        <span className="mono data-path" title={value}>
          {value}
        </span>
      ),
    },
    {
      title: '输出',
      dataIndex: 'output_path',
      render: (value: string) => (
        <span className="mono data-path" title={value}>
          {value}
        </span>
      ),
    },
    {
      title: '分值',
      width: 128,
      render: (_value, row) => (
        <InputNumber
          size="small"
          min={0}
          max={10000}
          precision={0}
          value={pointsDraft[row.id] ?? row.points}
          onChange={(value) =>
            setPointsDraft((previous) => ({
              ...previous,
              [row.id]: typeof value === 'number' ? value : 0,
            }))
          }
          style={{ width: 96 }}
        />
      ),
    },
    {
      title: '子任务',
      dataIndex: 'subtask_id',
      width: 88,
      render: (value: number | null) =>
        value === null ? <span className="muted">—</span> : <span className="mono">#{value}</span>,
    },
    {
      title: '依赖',
      dataIndex: 'depends_on',
      width: 90,
      render: (value: string | null) =>
        value ? <span className="mono">{value}</span> : <span className="muted">—</span>,
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 76,
      render: (value: number) =>
        value === 1 ? <Tag color="green">启用</Tag> : <Tag>禁用</Tag>,
    },
  ];

  const dataPanel = (
    <div className="stack">
      <Card className="oij-card" title="导入测试数据（zip）">
        <Alert
          className="data-import-note"
          type="warning"
          showIcon
          message="导入会替换该题现有测试点。zip 内按同名 .in / .out（或 .ans）配对。"
        />
        <div className="zip-upload">
          <input
            ref={zipInputRef}
            type="file"
            accept=".zip,application/zip"
            data-testid="zip-input"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              setZipFile(file);
              setImportResult(null);
              setImportError(null);
            }}
          />
          <span className="muted">
            {zipFile ? `${zipFile.name} · ${formatBytes(zipFile.size)}` : '尚未选择 zip 文件'}
          </span>
          <span className="zip-points">
            <span className="muted">导入分值</span>
            <InputNumber
              size="small"
              min={1}
              max={10000}
              precision={0}
              value={importPoints}
              onChange={(value) => setImportPoints(typeof value === 'number' ? value : 100)}
              style={{ width: 100 }}
            />
          </span>
          <Button type="primary" loading={importing} onClick={() => void importData()}>
            上传并导入
          </Button>
        </div>
        {importResult ? (
          <Alert
            className="data-import-result"
            type="success"
            showIcon
            message={`导入成功，共 ${importResult.testcases.length} 组测试点`}
            description={importResult.testcases
              .map((testcase) => testcase.stem)
              .join('、')}
          />
        ) : null}
        {importError ? (
          <Alert
            className="data-import-result"
            type="error"
            showIcon
            message="导入失败"
            description={importError}
          />
        ) : null}
      </Card>

      <Card
        className="oij-card"
        title="测试点列表"
        extra={
          <Space>
            <span className="muted">
              共 {testcases.length} 个 · 总分 {totalDraftPoints}
            </span>
            <Button
              size="small"
              icon={<ReloadOutlined />}
              onClick={() => void testcasesQuery.refetch()}
              loading={testcasesQuery.isFetching}
            >
              刷新
            </Button>
            <Button
              size="small"
              type="primary"
              disabled={!pointsDirty}
              loading={savingPoints}
              onClick={() => void savePoints()}
            >
              保存分值
            </Button>
          </Space>
        }
      >
        {testcasesQuery.isPending ? (
          <div className="inline-loading">
            <Spin />
          </div>
        ) : testcasesQuery.isError ? (
          <ErrorResult
            error={testcasesQuery.error}
            onRetry={() => void testcasesQuery.refetch()}
          />
        ) : testcases.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="尚未导入测试数据，请上传 zip"
          />
        ) : (
          <Table<AdminTestcase>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={testcaseColumns}
            dataSource={testcases}
            pagination={false}
            scroll={{ x: 900 }}
          />
        )}
      </Card>
    </div>
  );

  const validationPanel = (
    <Card className="oij-card" title="校验与自测">
      <Alert
        type="info"
        showIcon
        message="Phase 1E 接入"
        description="校验器运行、数据校验、自测与对拍等功能将在 Phase 1E 提供。当前阶段仅保留入口，不提供实际校验/自测功能。"
      />
    </Card>
  );

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '管理', to: '/admin/problems' },
          { label: '题目', to: '/admin/problems' },
          { label: `#${problem.id}` },
        ]}
        title={problem.title}
        tags={
          <>
            <Tag className="mono">#{problem.id}</Tag>
            <Tag color="blue">{problemTypeLabel(problem.type)}</Tag>
            <Tag>{difficultyLabel(problem.difficulty)}</Tag>
          </>
        }
        subtitle={`时间限制 ${formatTimeLimit(problem.timeMs)} · 内存限制 ${formatMemoryLimit(
          problem.memoryMb,
        )}`}
        extra={
          <Space>
            <Link to={`/problem/${problem.id}`}>
              <Button>前台查看</Button>
            </Link>
            <Link to="/admin/problems">
              <Button>返回列表</Button>
            </Link>
          </Space>
        }
      />

      <Tabs
        className="problem-tabs admin-tabs"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'basic', label: '基本信息', children: basicPanel },
          { key: 'assets', label: '程序资产', children: assetsPanel },
          { key: 'data', label: '测试数据', children: dataPanel },
          { key: 'validation', label: '校验与自测', children: validationPanel },
        ]}
      />

      <Modal
        title={`查看源码 · ${ASSET_META[sourceKind].label}${sourceName ? ` · ${sourceName}` : ''}`}
        open={sourceOpen}
        onCancel={() => setSourceOpen(false)}
        footer={null}
        width={900}
        destroyOnHidden
      >
        {sourceLoading ? (
          <div className="inline-loading">
            <Spin />
          </div>
        ) : sourceError ? (
          <Alert type="error" showIcon message={sourceError} />
        ) : (
          <CodeBlock code={sourceText} maxHeight={560} />
        )}
      </Modal>
    </div>
  );
}
