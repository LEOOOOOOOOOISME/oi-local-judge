import { useRef, useState } from 'react';
import { Alert, App, Button, Card, Input, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPatch, apiUpload } from '../api/client';
import type { RankingPlugin, RankingPluginUploadResult } from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/admin.css';

export function AdminRankingPluginsPage() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pluginName, setPluginName] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const pluginsQuery = useQuery({
    queryKey: ['ranking-plugins'],
    queryFn: () => apiGet<RankingPlugin[]>('/api/admin/ranking-plugins'),
  });

  const uploadPlugin = async () => {
    const name = pluginName.trim();
    if (!/^[a-z0-9-]{1,40}$/.test(name)) {
      setUploadError('插件名称只能包含小写字母、数字和短横线（1-40 字符）');
      return;
    }
    if (!selectedFile) {
      setUploadError('请选择 .mjs 插件文件');
      return;
    }
    if (!selectedFile.name.toLowerCase().endsWith('.mjs')) {
      setUploadError('插件必须是 .mjs 文件');
      return;
    }
    if (selectedFile.size > 256 * 1024) {
      setUploadError('插件文件不能超过 256 KB');
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const result = await apiUpload<RankingPluginUploadResult>(
        `/api/admin/ranking-plugins?name=${encodeURIComponent(name)}`,
        selectedFile,
        'application/octet-stream',
      );
      setRestartRequired(result.restartRequired);
      setPluginName('');
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      message.success(`插件 ${result.name} 已上传，重启服务后生效`);
      void queryClient.invalidateQueries({ queryKey: ['ranking-plugins'] });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : '插件上传失败');
    } finally {
      setUploading(false);
    }
  };

  const toggleEnabled = async (plugin: RankingPlugin) => {
    setTogglingId(plugin.id);
    try {
      await apiPatch<null>(`/api/admin/ranking-plugins/${plugin.id}`, {
        enabled: !plugin.enabled,
      });
      message.success(
        `${plugin.enabled ? '已禁用' : '已启用'}插件 ${plugin.name}；重启服务后生效`,
      );
      void queryClient.invalidateQueries({ queryKey: ['ranking-plugins'] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '更新插件状态失败');
    } finally {
      setTogglingId(null);
    }
  };

  const columns: TableColumnsType<RankingPlugin> = [
    { title: '名称', dataIndex: 'name', width: 180 },
    {
      title: 'SHA-256',
      dataIndex: 'sha256',
      render: (value: string) => (
        <span className="mono plugin-hash" title={value}>
          {value}
        </span>
      ),
    },
    {
      title: '状态',
      dataIndex: 'enabled',
      width: 90,
      render: (value: boolean) =>
        value ? <Tag color="green">已启用</Tag> : <Tag>已禁用</Tag>,
    },
    {
      title: '上传时间',
      dataIndex: 'uploadedAt',
      width: 170,
      render: (value: number) => formatDateTime(value),
    },
    {
      title: '',
      width: 100,
      align: 'center',
      render: (_value, row) => (
        <Button
          size="small"
          loading={togglingId === row.id}
          onClick={() => void toggleEnabled(row)}
        >
          {row.enabled ? '禁用' : '启用'}
        </Button>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理', to: '/admin/problems' }, { label: '排名插件' }]}
        title="排名插件"
        subtitle="上传自定义排名计算插件；插件是可信代码，等同服务器权限，重启服务后生效。"
        extra={
          <Button onClick={() => void pluginsQuery.refetch()}>刷新</Button>
        }
      />

      <Alert
        className="plugin-risk"
        type="warning"
        showIcon
        message="安全提示：插件以服务器进程权限执行"
        description="只上传你自己审查过的 .mjs 文件；插件缺失、被禁用或执行失败时，正式榜会回退到 OI 规则并在榜单数据中返回 pluginError。"
      />

      <div className="stack">
        <Card className="oij-card" title="上传插件">
          <div className="plugin-upload">
            <div className="plugin-field">
              <span className="muted">插件名称</span>
              <Input
                value={pluginName}
                onChange={(event) => setPluginName(event.target.value)}
                placeholder="例如 custom-oi"
                maxLength={40}
                style={{ width: 220 }}
              />
            </div>
            <div className="plugin-field">
              <span className="muted">插件文件</span>
              <Button
                onClick={() => fileInputRef.current?.click()}
                loading={uploading}
              >
                选择 .mjs 文件
              </Button>
              <span className="muted">
                {selectedFile ? `${selectedFile.name} · ${selectedFile.size} B` : '尚未选择'}
              </span>
              <input
                ref={fileInputRef}
                className="admin-file-input"
                type="file"
                accept=".mjs,text/javascript"
                data-testid="ranking-plugin-input"
                onChange={(event) => {
                  setSelectedFile(event.target.files?.[0] ?? null);
                  setUploadError(null);
                  setRestartRequired(false);
                }}
              />
            </div>
            <Button type="primary" loading={uploading} onClick={() => void uploadPlugin()}>
              上传插件
            </Button>
          </div>
          <div className="batch-level-hint muted">
            模块需导出 `apiVersion = 1` 与 `compute(input)`；上传后需重启服务才会加载。
          </div>
          {uploadError ? (
            <Alert className="plugin-upload-result" type="error" showIcon message={uploadError} />
          ) : null}
          {restartRequired ? (
            <Alert
              className="plugin-upload-result"
              type="success"
              showIcon
              message="插件已上传"
              description="请重启后端服务使插件可被加载；重启前启用/禁用状态不会改变运行时行为。"
            />
          ) : null}
        </Card>

        <Card className="oij-card" title="已上传插件">
          {pluginsQuery.isError ? (
            <ErrorResult
              error={pluginsQuery.error}
              onRetry={() => void pluginsQuery.refetch()}
            />
          ) : (
            <Table<RankingPlugin>
              className="oij-table"
              rowKey="id"
              size="small"
              loading={pluginsQuery.isPending}
              columns={columns}
              dataSource={pluginsQuery.data ?? []}
              pagination={false}
              locale={{ emptyText: '还没有上传排名插件' }}
            />
          )}
        </Card>
      </div>
    </div>
  );
}
