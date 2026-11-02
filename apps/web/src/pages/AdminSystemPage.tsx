import { useState } from 'react';
import { Alert, App, Button, Card, Space, Table, Tabs, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type {
  BackupEntry,
  DiagnosticCheck,
  DiagnosticsReport,
  DiagnosticStatus,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatBytes, formatDateTime } from '../utils/format';
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

function BackupsPanel() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

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

  return (
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
        message="备份为数据目录副本，当前版本不提供恢复或删除操作。"
        description="创建前会执行数据库检查点，并复制数据库与 problems / submissions / plugins / hacks 目录；备份期间请勿关闭服务。"
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
          columns={BACKUP_COLUMNS}
          dataSource={backupsQuery.data ?? []}
          pagination={false}
          locale={{ emptyText: '还没有备份；点击“创建备份”生成第一份。' }}
        />
      )}
      <div className="system-backup-footer muted">
        共 {backupsQuery.data?.length ?? 0} 个备份
      </div>
    </Card>
  );
}

export function AdminSystemPage() {
  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理', to: '/admin/problems' }, { label: '系统运维' }]}
        title="系统运维"
        subtitle="查看运行环境诊断，并创建可验证的数据备份；恢复与删除暂未开放。"
      />
      <Tabs
        className="admin-tabs"
        defaultActiveKey="diagnostics"
        items={[
          { key: 'diagnostics', label: '诊断', children: <DiagnosticsPanel /> },
          { key: 'backups', label: '备份', children: <BackupsPanel /> },
        ]}
      />
    </div>
  );
}
