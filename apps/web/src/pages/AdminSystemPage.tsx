import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '../api/client';
import type {
  BackupEntry,
  DiagnosticCheck,
  DiagnosticsReport,
  DiagnosticStatus,
  RestoreRequestResult,
  RuntimeMetrics,
  SlowRequest,
  SystemSettings,
  SystemSettingsEffective,
  SystemSettingsPatch,
  SystemSettingsUpdateResult,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatBytes, formatDateTime, formatDuration } from '../utils/format';
import '../styles/admin.css';

const CHECK_STATUS_META: Record<DiagnosticStatus, { label: string; color: string }> = {
  pass: { label: '通过', color: 'green' },
  warn: { label: '警告', color: 'gold' },
  fail: { label: '失败', color: 'red' },
};

const CHECK_COLUMNS: TableColumnsType<DiagnosticCheck> = [
  {
    title: '检查项',
    dataIndex: 'name',
    width: 190,
    render: (value: string) => <span className="mono system-check-name">{value}</span>,
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (value: DiagnosticStatus) => {
      const meta = CHECK_STATUS_META[value];
      return <Tag color={meta.color}>{meta.label}</Tag>;
    },
  },
  {
    title: '详情',
    dataIndex: 'detail',
    render: (value: string) => <span className="system-check-detail">{value}</span>,
  },
];

/** 白名单设置项：字段名、中文标签与对应的环境变量。 */
interface SettingField {
  key: keyof SystemSettingsEffective;
  label: string;
  env: string;
}

const SETTING_FIELDS: SettingField[] = [
  { key: 'host', label: '监听地址', env: 'OIJ_HOST' },
  { key: 'port', label: '监听端口', env: 'OIJ_PORT' },
  { key: 'judgeConcurrency', label: '评测并发数', env: 'OIJ_JUDGE_CONCURRENCY' },
  { key: 'gxx', label: '编译器路径', env: 'OIJ_GXX' },
  { key: 'sessionTtlSec', label: '会话有效期（秒）', env: 'OIJ_SESSION_TTL' },
];

/** 生效值的来源：环境变量 > settings.json > 默认值。 */
type SettingSource = 'env' | 'file' | 'default';

interface SettingsSourceRow {
  key: keyof SystemSettingsEffective;
  label: string;
  env: string;
  effective: string;
  persisted: string;
  source: SettingSource;
}

const SETTINGS_SOURCE_COLUMNS: TableColumnsType<SettingsSourceRow> = [
  { title: '配置项', dataIndex: 'label', width: 150 },
  {
    title: '生效值',
    dataIndex: 'effective',
    render: (value: string) => <span className="mono system-settings-value">{value}</span>,
  },
  {
    title: '已保存值',
    dataIndex: 'persisted',
    render: (value: string) => <span className="mono system-settings-value">{value}</span>,
  },
  {
    title: '环境变量',
    dataIndex: 'env',
    width: 190,
    render: (value: string) => <span className="mono system-settings-env">{value}</span>,
  },
  {
    title: '来源',
    dataIndex: 'source',
    width: 130,
    render: (value: SettingSource) => {
      if (value === 'env') return <Tag color="gold">环境变量覆盖</Tag>;
      if (value === 'file') return <Tag color="blue">settings.json</Tag>;
      return <Tag>默认值</Tag>;
    },
  },
];

type SettingsFormValues = SystemSettingsEffective;

function envOverrideSet(settings: SystemSettings | undefined): Set<string> {
  return new Set(settings?.envOverrides ?? []);
}

/**
 * 表单展示"保存后将会生效"的值：非环境变量字段优先使用 settings.json 中
 * 的值，未持久化时回退到当前生效值；被环境变量覆盖的字段只读展示生效值。
 */
function settingsToFormValues(settings: SystemSettings): SettingsFormValues {
  const overridden = envOverrideSet(settings);
  return {
    host: overridden.has('host')
      ? settings.effective.host
      : (settings.persisted.host ?? settings.effective.host),
    port: overridden.has('port')
      ? settings.effective.port
      : (settings.persisted.port ?? settings.effective.port),
    judgeConcurrency: overridden.has('judgeConcurrency')
      ? settings.effective.judgeConcurrency
      : (settings.persisted.judgeConcurrency ?? settings.effective.judgeConcurrency),
    gxx: overridden.has('gxx')
      ? settings.effective.gxx
      : (settings.persisted.gxx ?? settings.effective.gxx),
    sessionTtlSec: overridden.has('sessionTtlSec')
      ? settings.effective.sessionTtlSec
      : (settings.persisted.sessionTtlSec ?? settings.effective.sessionTtlSec),
  };
}

function DiagnosticsPanel() {
  const diagnosticsQuery = useQuery({
    queryKey: ['admin-system-diagnostics'],
    queryFn: () => apiGet<DiagnosticsReport>('/api/admin/system/diagnostics'),
  });
  const report = diagnosticsQuery.data;
  // 内存没有独立字段，后端把它作为 memory 检查项返回。
  const memoryCheck = report?.checks.find((entry) => entry.name === 'memory');
  const hasWarn = report?.checks.some((entry) => entry.status === 'warn') ?? false;
  const overall = !report?.ok
    ? { alert: 'error' as const, label: '存在失败项', className: 'system-stat-bad' }
    : hasWarn
      ? { alert: 'warning' as const, label: '存在警告项', className: 'system-stat-warn' }
      : { alert: 'success' as const, label: '正常', className: 'system-stat-ok' };

  return (
    <Card
      className="oij-card"
      title="系统诊断"
      extra={
        <Button
          icon={<ReloadOutlined />}
          loading={diagnosticsQuery.isFetching}
          onClick={() => void diagnosticsQuery.refetch()}
        >
          刷新
        </Button>
      }
    >
      {diagnosticsQuery.isError ? (
        <ErrorResult
          error={diagnosticsQuery.error}
          onRetry={() => void diagnosticsQuery.refetch()}
        />
      ) : !report ? (
        <PageLoading tip="正在运行系统诊断…" />
      ) : (
        <>
          <Alert
            className="system-overall"
            type={overall.alert}
            showIcon
            message={
              overall.alert === 'success'
                ? '系统检查通过'
                : overall.alert === 'warning'
                  ? '系统检查通过，但存在警告项'
                  : '系统检查存在失败项'
            }
            description={`生成时间：${formatDateTime(report.generatedAt)} · 共 ${report.checks.length} 项检查`}
          />
          <div className="system-stat-grid">
            <div className={`system-stat ${overall.className}`}>
              <div className="system-stat-label">整体状态</div>
              <div className="system-stat-value">{overall.label}</div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">排队任务</div>
              <div className="system-stat-value mono">{report.queue.queued}</div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">运行中</div>
              <div className="system-stat-value mono">{report.queue.running}</div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">失败任务</div>
              <div className="system-stat-value mono">{report.queue.failed}</div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">进程内存</div>
              <div className="system-stat-value system-stat-value-text">
                {memoryCheck?.detail ?? '—'}
              </div>
            </div>
          </div>
          <Table<DiagnosticCheck>
            className="oij-table"
            rowKey="name"
            size="small"
            columns={CHECK_COLUMNS}
            dataSource={report.checks}
            pagination={false}
            locale={{ emptyText: '暂无诊断项' }}
          />
        </>
      )}
    </Card>
  );
}

/** 毫秒的紧凑展示：小于 10 ms 保留两位，其余保留一位。 */
function formatMetricsMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
}

const SLOW_REQUEST_COLUMNS: TableColumnsType<SlowRequest> = [
  {
    title: '时间',
    dataIndex: 'at',
    width: 170,
    render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
  },
  {
    title: '方法',
    dataIndex: 'method',
    width: 90,
    render: (value: string) => <span className="mono">{value}</span>,
  },
  {
    title: '路径',
    dataIndex: 'url',
    render: (value: string) => (
      <span className="mono system-metrics-path" title={value}>
        {value}
      </span>
    ),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 90,
    render: (value: number) => (
      <Tag color={value >= 500 ? 'red' : value >= 400 ? 'gold' : 'green'}>{value}</Tag>
    ),
  },
  {
    title: '耗时',
    dataIndex: 'durationMs',
    width: 110,
    render: (value: number) => (
      <span className="mono system-metrics-duration">{formatMetricsMs(value)}</span>
    ),
  },
];

function MetricsPanel() {
  const metricsQuery = useQuery({
    queryKey: ['admin-system-metrics'],
    queryFn: () => apiGet<RuntimeMetrics>('/api/admin/system/metrics'),
  });
  const metrics = metricsQuery.data;
  const hasServerErrors = (metrics?.requests.serverErrors ?? 0) > 0;

  return (
    <Card
      className="oij-card"
      title="运行指标"
      extra={
        <Button
          icon={<ReloadOutlined />}
          loading={metricsQuery.isFetching}
          onClick={() => void metricsQuery.refetch()}
        >
          刷新
        </Button>
      }
    >
      {metricsQuery.isError ? (
        <ErrorResult error={metricsQuery.error} onRetry={() => void metricsQuery.refetch()} />
      ) : !metrics ? (
        <PageLoading tip="正在读取运行指标…" />
      ) : (
        <>
          <Alert
            className="system-overall"
            type="info"
            showIcon
            message="进程内本地指标，仅统计本次启动以来的数据"
            description={`生成时间：${formatDateTime(metrics.generatedAt)} · 进程启动：${formatDateTime(
              metrics.process.startedAt,
            )} · 数据目录剩余：${metrics.disk ? formatBytes(metrics.disk.freeBytes) : '未知'}`}
          />
          <div className="system-stat-grid">
            <div className="system-stat">
              <div className="system-stat-label">请求总数</div>
              <div className="system-stat-value mono">{metrics.requests.total}</div>
            </div>
            <div className={`system-stat ${hasServerErrors ? 'system-stat-bad' : ''}`}>
              <div className="system-stat-label">5xx 响应</div>
              <div className="system-stat-value mono">{metrics.requests.serverErrors}</div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">平均延迟</div>
              <div className="system-stat-value mono">
                {formatMetricsMs(metrics.requests.avgLatencyMs)}
              </div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">p95 延迟</div>
              <div className="system-stat-value mono">
                {formatMetricsMs(metrics.requests.p95LatencyMs)}
              </div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">事件循环 p95</div>
              <div className="system-stat-value mono">
                {formatMetricsMs(metrics.eventLoopDelay.p95Ms)}
              </div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">常驻内存 RSS</div>
              <div className="system-stat-value system-stat-value-text mono">
                {formatBytes(metrics.process.rssBytes)}
              </div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">堆内存</div>
              <div className="system-stat-value system-stat-value-text mono">
                {formatBytes(metrics.process.heapUsedBytes)} /{' '}
                {formatBytes(metrics.process.heapTotalBytes)}
              </div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">CPU 使用率</div>
              <div className="system-stat-value mono">
                {metrics.process.cpu.percent.toFixed(1)}%
              </div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">运行时长</div>
              <div className="system-stat-value system-stat-value-text mono">
                {formatDuration(metrics.process.uptimeSec * 1000)}
              </div>
            </div>
            <div className="system-stat">
              <div className="system-stat-label">评测队列</div>
              <div className="system-stat-value system-stat-value-text mono">
                排队 {metrics.queue.queued} · 运行 {metrics.queue.running} · 失败{' '}
                {metrics.queue.failed}
              </div>
            </div>
          </div>
          <div className="system-metrics-title">慢请求（≥ 500 ms，最近 50 条）</div>
          <Table<SlowRequest>
            className="oij-table"
            rowKey={(row) => `${row.at}-${row.method}-${row.url}`}
            size="small"
            columns={SLOW_REQUEST_COLUMNS}
            dataSource={metrics.slowRequests}
            pagination={false}
            locale={{ emptyText: '暂无慢请求' }}
          />
        </>
      )}
    </Card>
  );
}

function SettingsPanel() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<SettingsFormValues>();
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  const settingsQuery = useQuery({
    queryKey: ['admin-system-settings'],
    queryFn: () => apiGet<SystemSettings>('/api/admin/system/settings'),
  });
  const settings = settingsQuery.data;
  const overridden = envOverrideSet(settings);
  const overrideFields = SETTING_FIELDS.filter((field) => overridden.has(field.key));

  // GET 是异步的，表单在拿到数据后才挂载；这里同步刷新/保存后的最新值。
  useEffect(() => {
    if (settings) form.setFieldsValue(settingsToFormValues(settings));
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: (patch: SystemSettingsPatch) =>
      apiPut<SystemSettingsUpdateResult>('/api/admin/system/settings', patch),
    onSuccess: (result) => {
      setFeedback({
        type: 'success',
        text: '设置已保存到 settings.json；请重启服务后生效。',
      });
      message.success('设置已保存，重启服务后生效');
      form.setFieldsValue(settingsToFormValues(result.settings));
      void queryClient.invalidateQueries({ queryKey: ['admin-system-settings'] });
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : '设置保存失败';
      setFeedback({ type: 'error', text });
      message.error(text);
    },
  });

  // 被环境变量覆盖的字段不可在此修改：既不在表单中允许编辑，也不随 PUT 提交。
  const submit = (values: SettingsFormValues) => {
    const patch: SystemSettingsPatch = {};
    if (!overridden.has('host')) patch.host = values.host;
    if (!overridden.has('port')) patch.port = values.port;
    if (!overridden.has('judgeConcurrency')) patch.judgeConcurrency = values.judgeConcurrency;
    if (!overridden.has('gxx')) patch.gxx = values.gxx;
    if (!overridden.has('sessionTtlSec')) patch.sessionTtlSec = values.sessionTtlSec;
    saveMutation.mutate(patch);
  };

  const sourceRows: SettingsSourceRow[] = settings
    ? SETTING_FIELDS.map((field): SettingsSourceRow => {
        const persistedValue = settings.persisted[field.key];
        return {
          key: field.key,
          label: field.label,
          env: field.env,
          effective: String(settings.effective[field.key]),
          persisted: persistedValue === undefined ? '—' : String(persistedValue),
          source: overridden.has(field.key)
            ? 'env'
            : persistedValue !== undefined
              ? 'file'
              : 'default',
        };
      })
    : [];

  return (
    <Card
      className="oij-card"
      title="运行时设置"
      extra={
        <Button
          icon={<ReloadOutlined />}
          loading={settingsQuery.isFetching}
          onClick={() => void settingsQuery.refetch()}
        >
          刷新
        </Button>
      }
    >
      {settingsQuery.isError ? (
        <ErrorResult
          error={settingsQuery.error}
          onRetry={() => void settingsQuery.refetch()}
        />
      ) : !settings ? (
        <PageLoading tip="正在读取运行时设置…" />
      ) : (
        <>
          <Alert
            className="system-settings-note"
            type="info"
            showIcon
            message="保存后需要重启服务才能生效"
            description="设置会写入数据目录下的 settings.json；运行中的服务不会立即采用新值，请保存后手动重启服务。"
          />
          {overrideFields.length > 0 ? (
            <Alert
              className="system-settings-note"
              type="warning"
              showIcon
              message="部分配置被环境变量覆盖"
              description={`以下字段由环境变量控制（优先级高于 settings.json），界面内只读：${overrideFields
                .map((field) => `${field.label}（${field.env}）`)
                .join('、')}。如需调整，请修改环境变量并重启服务。`}
            />
          ) : null}
          {feedback ? (
            <Alert
              className="system-settings-note"
              type={feedback.type}
              showIcon
              message={feedback.text}
              closable
              onClose={() => setFeedback(null)}
            />
          ) : null}
          <Form<SettingsFormValues>
            form={form}
            layout="vertical"
            requiredMark={false}
            initialValues={settingsToFormValues(settings)}
            onFinish={submit}
          >
            <div className="system-settings-grid">
              <Form.Item
                label="监听地址 host"
                name="host"
                rules={[
                  { required: true, whitespace: true, message: '请输入监听地址' },
                  { max: 255, message: '最多 255 个字符' },
                ]}
                extra={
                  overridden.has('host')
                    ? '该项被环境变量 OIJ_HOST 覆盖，不可在此修改'
                    : undefined
                }
              >
                <Input
                  disabled={overridden.has('host')}
                  placeholder="0.0.0.0"
                  maxLength={255}
                />
              </Form.Item>
              <Form.Item
                label="监听端口 port"
                name="port"
                rules={[
                  { required: true, message: '请输入监听端口' },
                  { type: 'number', min: 1, max: 65535, message: '端口需在 1-65535 之间' },
                ]}
                extra={
                  overridden.has('port')
                    ? '该项被环境变量 OIJ_PORT 覆盖，不可在此修改'
                    : undefined
                }
              >
                <InputNumber
                  disabled={overridden.has('port')}
                  min={1}
                  max={65535}
                  precision={0}
                  step={1}
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Form.Item
                label="评测并发数 judgeConcurrency"
                name="judgeConcurrency"
                rules={[
                  { required: true, message: '请输入评测并发数' },
                  { type: 'number', min: 1, max: 8, message: '并发数需在 1-8 之间' },
                ]}
                extra={
                  overridden.has('judgeConcurrency')
                    ? '该项被环境变量 OIJ_JUDGE_CONCURRENCY 覆盖，不可在此修改'
                    : undefined
                }
              >
                <InputNumber
                  disabled={overridden.has('judgeConcurrency')}
                  min={1}
                  max={8}
                  precision={0}
                  step={1}
                  style={{ width: '100%' }}
                />
              </Form.Item>
              <Form.Item
                label="编译器路径 gxx"
                name="gxx"
                rules={[
                  { required: true, whitespace: true, message: '请输入编译器路径' },
                  { max: 1024, message: '最多 1024 个字符' },
                ]}
                extra={
                  overridden.has('gxx')
                    ? '该项被环境变量 OIJ_GXX 覆盖，不可在此修改'
                    : undefined
                }
              >
                <Input
                  disabled={overridden.has('gxx')}
                  placeholder="C:\\mingw64\\bin\\g++.exe"
                  maxLength={1024}
                />
              </Form.Item>
              <Form.Item
                label="会话有效期 sessionTtlSec（秒）"
                name="sessionTtlSec"
                rules={[
                  { required: true, message: '请输入会话有效期' },
                  {
                    type: 'number',
                    min: 300,
                    max: 604800,
                    message: '会话有效期需在 300-604800 秒之间',
                  },
                ]}
                extra={
                  overridden.has('sessionTtlSec')
                    ? '该项被环境变量 OIJ_SESSION_TTL 覆盖，不可在此修改'
                    : undefined
                }
              >
                <InputNumber
                  disabled={overridden.has('sessionTtlSec')}
                  min={300}
                  max={604800}
                  precision={0}
                  step={300}
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </div>
            <div className="system-settings-footer">
              <span className="muted">
                {overrideFields.length > 0
                  ? `环境变量覆盖 ${overrideFields.length} 项，保存时不会写入这些字段；其余修改重启后生效。`
                  : '修改保存后需手动重启服务才能生效。'}
              </span>
              <Space>
                <Button onClick={() => form.setFieldsValue(settingsToFormValues(settings))}>
                  重置
                </Button>
                <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
                  保存设置
                </Button>
              </Space>
            </div>
          </Form>
          <div className="system-settings-source-title">当前配置来源</div>
          <Table<SettingsSourceRow>
            className="oij-table"
            rowKey="key"
            size="small"
            columns={SETTINGS_SOURCE_COLUMNS}
            dataSource={sourceRows}
            pagination={false}
          />
        </>
      )}
    </Card>
  );
}

const BACKUP_COLUMNS: TableColumnsType<BackupEntry> = [
  {
    title: '备份 ID',
    dataIndex: 'id',
    width: 230,
    render: (value: string) => <span className="mono">{value}</span>,
  },
  {
    title: '创建时间',
    dataIndex: 'createdAt',
    width: 170,
    render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
  },
  {
    title: '类型',
    dataIndex: 'manifest',
    width: 130,
    render: (manifest: Record<string, unknown>) =>
      manifest.kind === 'pre-restore' ? (
        <Tag color="gold">恢复前快照</Tag>
      ) : (
        <Tag>手动备份</Tag>
      ),
  },
  {
    title: '大小',
    dataIndex: 'sizeBytes',
    width: 110,
    render: (value: number) => formatBytes(value),
  },
  {
    title: '路径',
    dataIndex: 'path',
    render: (value: string) => (
      <span className="mono system-backup-path" title={value}>
        {value}
      </span>
    ),
  },
];

function BackupsPanel() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [restoreConfirm, setRestoreConfirm] = useState('');

  const backupsQuery = useQuery({
    queryKey: ['admin-system-backups'],
    queryFn: () => apiGet<BackupEntry[]>('/api/admin/system/backups'),
  });

  const createMutation = useMutation({
    mutationFn: () => apiPost<BackupEntry>('/api/admin/system/backups'),
    onSuccess: (entry) => {
      setFeedback({
        type: 'success',
        text: `备份已创建：${entry.id}（${formatBytes(entry.sizeBytes)}）`,
      });
      message.success(`备份 ${entry.id} 已创建`);
      void queryClient.invalidateQueries({ queryKey: ['admin-system-backups'] });
    },
    onError: (error) => {
      const text = error instanceof Error ? error.message : '备份创建失败';
      setFeedback({ type: 'error', text });
      message.error(text);
    },
  });

  const restoreMutation = useMutation({
    mutationFn: (backupId: string) =>
      apiPost<RestoreRequestResult>('/api/admin/system/restore', {
        backupId,
        confirm: 'RESTORE',
      }),
    onSuccess: (result) => {
      setFeedback({
        type: 'success',
        text: `已排定从备份 ${result.backupId} 恢复：请重启服务，启动时应用恢复（会先创建 pre-restore 快照）。`,
      });
      message.success('恢复请求已提交，请重启服务以应用');
      setRestoreTarget(null);
      setRestoreConfirm('');
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '恢复请求提交失败');
    },
  });

  const openRestore = (backup: BackupEntry) => {
    restoreMutation.reset();
    setRestoreConfirm('');
    setRestoreTarget(backup);
  };

  const closeRestore = () => {
    restoreMutation.reset();
    setRestoreConfirm('');
    setRestoreTarget(null);
  };

  const columns: TableColumnsType<BackupEntry> = [
    ...BACKUP_COLUMNS,
    {
      title: '操作',
      key: 'actions',
      width: 90,
      align: 'center',
      // pre-restore 快照同样是完整备份，可以再次恢复。
      render: (_value, row) => (
        <Button size="small" danger onClick={() => openRestore(row)}>
          恢复
        </Button>
      ),
    },
  ];

  return (
    <>
      <Card
        className="oij-card"
        title="数据备份"
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={backupsQuery.isFetching}
              onClick={() => void backupsQuery.refetch()}
            >
              刷新
            </Button>
            <Button
              type="primary"
              loading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              创建备份
            </Button>
          </Space>
        }
      >
        <Alert
          className="system-backup-note"
          type="info"
          showIcon
          message="恢复只在下次启动时应用"
          description="创建备份前会执行数据库检查点，并复制数据库与 problems / submissions / plugins / hacks 目录。提交恢复后不会在运行中替换数据库；重启服务时会在打开数据库前先创建 pre-restore 快照，再应用恢复。恢复前快照同样可以再次恢复。"
        />
        {feedback ? (
          <Alert
            className="system-backup-feedback"
            type={feedback.type}
            showIcon
            message={feedback.text}
            closable
            onClose={() => setFeedback(null)}
          />
        ) : null}
        {backupsQuery.isError ? (
          <ErrorResult
            error={backupsQuery.error}
            onRetry={() => void backupsQuery.refetch()}
          />
        ) : backupsQuery.isPending ? (
          <PageLoading tip="正在读取备份列表…" />
        ) : (
          <Table<BackupEntry>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={backupsQuery.data ?? []}
            pagination={false}
            locale={{ emptyText: '还没有备份；点击“创建备份”生成第一份。' }}
          />
        )}
        <div className="system-backup-footer muted">
          共 {backupsQuery.data?.length ?? 0} 个备份
        </div>
      </Card>

      <Modal
        title={`从备份恢复${restoreTarget ? ` · ${restoreTarget.id}` : ''}`}
        open={restoreTarget !== null}
        onCancel={closeRestore}
        onOk={() => restoreTarget && restoreMutation.mutate(restoreTarget.id)}
        okText="提交恢复"
        cancelText="取消"
        okButtonProps={{ danger: true, disabled: restoreConfirm !== 'RESTORE' }}
        confirmLoading={restoreMutation.isPending}
        destroyOnHidden
      >
        {restoreTarget ? (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Alert
              type="warning"
              showIcon
              message="恢复请求不会立即执行"
              description="提交后请重启服务；启动时会在打开数据库前应用恢复，并自动创建 pre-restore 快照用于回滚。"
            />
            <div className="system-restore-meta">
              <span>
                备份 ID：<span className="mono">{restoreTarget.id}</span>
              </span>
              <span>
                创建时间：
                <span className="mono">{formatDateTime(restoreTarget.createdAt)}</span>
              </span>
              <span>
                类型：
                {restoreTarget.manifest.kind === 'pre-restore' ? '恢复前快照' : '手动备份'}
              </span>
            </div>
            <div>
              <div className="system-restore-hint">
                确认覆盖当前数据，请输入 <span className="mono">RESTORE</span>：
              </div>
              <Input
                value={restoreConfirm}
                onChange={(event) => setRestoreConfirm(event.target.value)}
                placeholder="RESTORE"
                autoFocus
              />
            </div>
            {restoreMutation.isError ? (
              <Alert
                type="error"
                showIcon
                message={
                  restoreMutation.error instanceof Error
                    ? restoreMutation.error.message
                    : '恢复请求提交失败'
                }
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </>
  );
}

export function AdminSystemPage() {
  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理', to: '/admin/problems' }, { label: '系统运维' }]}
        title="系统运维"
        subtitle="查看运行环境诊断，修改需要重启生效的系统设置，并创建或恢复数据备份。"
      />
      <Tabs
        className="admin-tabs"
        defaultActiveKey="diagnostics"
        items={[
          { key: 'diagnostics', label: '诊断', children: <DiagnosticsPanel /> },
          { key: 'metrics', label: '指标', children: <MetricsPanel /> },
          { key: 'settings', label: '设置', children: <SettingsPanel /> },
          { key: 'backups', label: '备份', children: <BackupsPanel /> },
        ]}
      />
    </div>
  );
}
