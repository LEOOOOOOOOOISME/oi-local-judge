import { useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost, apiUpload } from '../api/client';
import type {
  ContestBatchDetail,
  ContestBatchItem,
  ContestBatchMode,
  ContestBatchPreview,
  ContestBatchPreviewRow,
  ContestBatchUploadResult,
  ContestDetail,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { VerdictBadge } from '../components/VerdictBadge';
import { formatMemoryKb, formatRunTime } from '../utils/format';
import { SUBMISSION_STATUS_LABEL } from '../utils/status';
import '../styles/admin.css';
import '../styles/contest-admin.css';

const LEVEL_OPTIONS = Array.from({ length: 6 }, (_, index) => ({
  value: index + 1,
  label: `第 ${index + 1} 层`,
}));

const MODE_OPTIONS: Array<{ value: ContestBatchMode; label: string; hint: string }> = [
  { value: 'merge', label: '合并（取较高分）', hint: '正式分与批次分取较高者' },
  { value: 'overwrite', label: '覆盖', hint: '用批次分直接覆盖正式分' },
  { value: 'fill', label: '仅补缺', hint: '仅当没有正式分时写入批次分' },
];

const BATCH_STATUS_LABEL: Record<string, string> = {
  draft: '评测中',
  ready: '待预览/发布',
  failed: '评测失败',
  published: '已发布',
  discarded: '已丢弃',
};

const BATCH_STATUS_COLOR: Record<string, string> = {
  draft: 'blue',
  ready: 'green',
  failed: 'red',
  published: 'purple',
  discarded: 'default',
};

function batchErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'BATCH_OI_ONLY':
        return '仅 OI 赛制比赛支持批量导入。';
      case 'CONTEST_ARCHIVED':
        return '比赛已归档，不能上传或发布批次。';
      case 'CONTEST_FROZEN':
        return '比赛已封榜，不能发布批次；请先解封。';
      case 'BAD_ZIP':
        return 'zip 解析失败，请检查文件格式。';
      case 'NO_SOURCES':
        return 'zip 中没有匹配到可用的学生/题目 .cpp 文件。';
      case 'BATCH_NOT_READY':
        return '批次尚未评测完成，请稍后重试。';
      case 'PUBLISH_FAILED':
        return `发布失败：${error.message}`;
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '批量导入请求失败';
}

function itemStatusLabel(status: ContestBatchItem['status']): string {
  if (status === 'missing') return '缺失';
  return SUBMISSION_STATUS_LABEL[status] ?? status;
}

export function AdminContestBatchPage() {
  const { contestId: contestIdParam } = useParams<{ contestId: string }>();
  const contestId = Number(contestIdParam);
  const validId = Number.isInteger(contestId) && contestId > 0;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [studentLevel, setStudentLevel] = useState(1);
  const [problemLevel, setProblemLevel] = useState(2);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [batchId, setBatchId] = useState<number | null>(null);
  const [mode, setMode] = useState<ContestBatchMode>('merge');
  const [previewing, setPreviewing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [preview, setPreview] = useState<ContestBatchPreview | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const detailQuery = useQuery({
    queryKey: ['contest-detail', contestId],
    queryFn: () => apiGet<ContestDetail>(`/api/contests/${contestId}`),
    enabled: validId,
  });
  const batchQuery = useQuery({
    queryKey: ['contest-batch', contestId, batchId],
    queryFn: () =>
      apiGet<ContestBatchDetail>(`/api/admin/contests/${contestId}/batches/${batchId}`),
    enabled: validId && batchId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.status === 'draft' ? 1000 : false;
    },
  });

  const contest = detailQuery.data?.contest ?? null;
  const problems = detailQuery.data?.problems ?? [];
  const batch = batchQuery.data ?? null;
  const archived = Boolean(contest?.archived_at) || contest?.status === 'archived';
  const oiOnly = contest ? contest.mode === 'oi' : true;
  const frozen = contest?.status === 'frozen';
  const blocked = archived || !oiOnly;
  const canPublish = Boolean(batch && batch.status === 'ready' && !archived && oiOnly && !frozen);
  const modeHint = MODE_OPTIONS.find((option) => option.value === mode)?.hint ?? '';

  const items = batch?.items ?? [];

  const uploadZip = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.zip')) {
      setUploadError('请选择 .zip 文件');
      return;
    }
    setUploading(true);
    setUploadError(null);
    setActionError(null);
    setPreview(null);
    setBatchId(null);
    try {
      const params = new URLSearchParams({
        studentLevel: String(studentLevel),
        problemLevel: String(problemLevel),
      });
      const result = await apiUpload<ContestBatchUploadResult>(
        `/api/admin/contests/${contestId}/batches?${params.toString()}`,
        file,
        'application/zip',
      );
      setBatchId(result.id);
      if (result.unknownUsers.length > 0 || result.unresolvedProblems.length > 0) {
        message.warning(
          `批次已创建，但有 ${result.unknownUsers.length} 个未知用户、${result.unresolvedProblems.length} 个未解析题目文件夹`,
        );
      } else {
        message.success(`批次已创建，共 ${result.count} 条提交`);
      }
    } catch (error) {
      const text = batchErrorText(error);
      setUploadError(text);
      message.error(text);
    } finally {
      setUploading(false);
    }
  };

  const runPreview = async () => {
    if (!batch) return;
    setPreviewing(true);
    setActionError(null);
    try {
      const result = await apiPost<ContestBatchPreview>(
        `/api/admin/contests/${contestId}/batches/${batch.id}/preview`,
        { mode },
      );
      setPreview(result);
      message.success(`预览完成，${result.changed} 条分数将变化`);
    } catch (error) {
      const text = batchErrorText(error);
      setActionError(text);
      message.error(text);
    } finally {
      setPreviewing(false);
    }
  };

  const publish = async () => {
    if (!batch) return;
    setPublishing(true);
    setActionError(null);
    try {
      const result = await apiPost<{ id: number; published: number; mode: string }>(
        `/api/admin/contests/${contestId}/batches/${batch.id}/publish`,
        { mode },
      );
      message.success(`已发布 ${result.published} 条正式成绩`);
      void queryClient.invalidateQueries({ queryKey: ['official-ranking', contestId] });
      void queryClient.invalidateQueries({ queryKey: ['contest-detail', contestId] });
      navigate(`/contest/${contestId}/ranking`);
    } catch (error) {
      const text = batchErrorText(error);
      setActionError(text);
      message.error(text);
    } finally {
      setPublishing(false);
    }
  };

  const discard = async () => {
    if (!batch) return;
    setDiscarding(true);
    setActionError(null);
    try {
      await apiPost<null>(`/api/admin/contests/${contestId}/batches/${batch.id}/discard`);
      message.success('批次已丢弃');
      setBatchId(null);
      setPreview(null);
    } catch (error) {
      const text = batchErrorText(error);
      setActionError(text);
      message.error(text);
    } finally {
      setDiscarding(false);
    }
  };

  const itemColumns: TableColumnsType<ContestBatchItem> = [
    { title: '学生', dataIndex: 'student', width: 130 },
    {
      title: '题目',
      width: 190,
      render: (_value, row) =>
        row.problemTitle ?? (row.problemId ? `#${row.problemId}` : '—'),
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
      title: '状态',
      dataIndex: 'status',
      width: 92,
      render: (value: ContestBatchItem['status']) => (
        <Tag color={value === 'missing' ? 'red' : value === 'finished' ? 'green' : 'blue'}>
          {itemStatusLabel(value)}
        </Tag>
      ),
    },
    {
      title: 'Verdict',
      dataIndex: 'verdict',
      width: 86,
      render: (value: ContestBatchItem['verdict']) => <VerdictBadge verdict={value} />,
    },
    {
      title: '得分',
      dataIndex: 'score',
      width: 70,
      align: 'right',
      render: (value: number) => <span className="score-value">{value}</span>,
    },
    {
      title: '用时',
      dataIndex: 'timeMs',
      width: 86,
      align: 'right',
      render: (value: number) => formatRunTime(value),
    },
    {
      title: '内存',
      dataIndex: 'memoryKb',
      width: 92,
      align: 'right',
      render: (value: number) => formatMemoryKb(value),
    },
  ];

  const previewColumns: TableColumnsType<ContestBatchPreviewRow> = [
    { title: '学生', dataIndex: 'student', width: 130 },
    {
      title: '题目',
      width: 190,
      render: (_value, row) =>
        row.problemTitle ?? (row.problemId ? `#${row.problemId}` : '—'),
    },
    {
      title: '当前成绩',
      width: 150,
      render: (_value, row) => (
        <span>
          {row.currentScore} 分{' '}
          {row.currentVerdict ? <Tag>{row.currentVerdict}</Tag> : <span className="muted">—</span>}
        </span>
      ),
    },
    {
      title: '批次成绩',
      width: 150,
      render: (_value, row) => (
        <span>
          {row.batchScore} 分{' '}
          {row.batchVerdict ? <Tag>{row.batchVerdict}</Tag> : <span className="muted">—</span>}
        </span>
      ),
    },
    {
      title: '发布后',
      dataIndex: 'afterScore',
      width: 100,
      align: 'right',
      render: (value: number, row) => (
        <strong className={value !== row.currentScore ? 'batch-after-changed' : undefined}>
          {value}
        </strong>
      ),
    },
    {
      title: '变化',
      width: 70,
      align: 'center',
      render: (_value, row) =>
        row.afterScore === row.currentScore ? (
          <span className="muted">—</span>
        ) : (
          <Tag color="orange">变化</Tag>
        ),
    },
  ];

  if (!validId) {
    return <ErrorResult error={new Error('无效的比赛编号')} />;
  }
  if (detailQuery.isPending) {
    return <PageLoading tip="正在加载比赛…" />;
  }
  if (detailQuery.isError) {
    return (
      <ErrorResult error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
    );
  }
  if (!contest) {
    return <ErrorResult error={new Error('比赛不存在')} />;
  }

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '管理', to: '/admin/problems' },
          { label: '比赛管理', to: '/admin/contests' },
          { label: contest.name, to: `/admin/contests/${contestId}` },
          { label: '批量导入' },
        ]}
        title={`${contest.name} · 批量导入`}
        tags={
          <>
            <Tag className="mono">#{contest.id}</Tag>
            <Tag color="blue">{contest.mode.toUpperCase()}</Tag>
            {archived ? <Tag color="red">已归档</Tag> : null}
            {frozen ? <Tag color="gold">已封榜</Tag> : null}
          </>
        }
        subtitle="上传“学生/题目/源码”目录结构的 zip，评测后预览并发布到正式榜。"
        extra={
          <Space>
            <Link to={`/admin/contests/${contestId}`}>
              <Button>返回控制台</Button>
            </Link>
            <Link to={`/contest/${contestId}/ranking`}>
              <Button>正式榜</Button>
            </Link>
          </Space>
        }
      />

      {blocked ? (
        <Alert
          className="batch-alert"
          type="warning"
          showIcon
          message={
            archived
              ? '比赛已归档，批量导入与发布已禁用。'
              : '仅 OI 赛制比赛支持批量导入。'
          }
        />
      ) : frozen ? (
        <Alert
          className="batch-alert"
          type="info"
          showIcon
          message="比赛已封榜：可以上传并预览批次，但发布前需先解封。"
        />
      ) : null}

      <div className="stack">
        <Card className="oij-card" title="比赛题目">
          {problems.length === 0 ? (
            <Empty description="比赛尚未配置题目" />
          ) : (
            <Space wrap>
              {problems.map((problem) => (
                <Tag key={problem.problemId} bordered={false}>
                  {problem.ordinal}. {problem.title}（#{problem.problemId}，{problem.points} 分）
                </Tag>
              ))}
            </Space>
          )}
        </Card>

        <Card className="oij-card" title="1. 上传批量源码 zip">
          <div className="contest-batch-levels">
            <span className="muted">学生目录层级</span>
            <Select
              value={studentLevel}
              options={LEVEL_OPTIONS}
              onChange={(value: number) => {
                setStudentLevel(value);
                setPreview(null);
              }}
              style={{ width: 140 }}
              disabled={blocked || uploading}
            />
            <span className="muted">题目目录层级</span>
            <Select
              value={problemLevel}
              options={LEVEL_OPTIONS}
              onChange={(value: number) => {
                setProblemLevel(value);
                setPreview(null);
              }}
              style={{ width: 140 }}
              disabled={blocked || uploading}
            />
            <Button
              type="primary"
              disabled={blocked || uploading}
              loading={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              选择 zip 上传
            </Button>
            <input
              ref={fileInputRef}
              className="admin-file-input"
              type="file"
              accept=".zip,application/zip"
              data-testid="contest-batch-zip-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadZip(file);
                event.target.value = '';
              }}
            />
          </div>
          <div className="batch-level-hint muted">
            默认 1/2：zip 形如 alice/1/main.cpp、bob/3/main.cpp；学生目录名必须是已注册用户名，题目目录可为题目 ID、A/B 或题目标题。
          </div>
          {uploadError ? (
            <Alert className="batch-alert" type="error" showIcon message="上传失败" description={uploadError} />
          ) : null}
        </Card>

        {batchId !== null ? (
          <Card
            className="oij-card"
            title="2. 批次预览与发布"
            extra={
              batch ? (
                <Space>
                  <Tag color={BATCH_STATUS_COLOR[batch.status] ?? 'default'}>
                    {BATCH_STATUS_LABEL[batch.status] ?? batch.status}
                  </Tag>
                  {batch.status === 'draft' ? <Spin size="small" /> : null}
                </Space>
              ) : null
            }
          >
            {batchQuery.isPending ? (
              <div className="inline-loading">
                <Spin />
              </div>
            ) : batchQuery.isError ? (
              <ErrorResult
                error={batchQuery.error}
                onRetry={() => void batchQuery.refetch()}
              />
            ) : batch ? (
              <div className="stack">
                <div className="contest-batch-summary muted">
                  批次 #{batch.id} · 学生层级 {batch.studentLevel} · 题目层级 {batch.problemLevel} ·{' '}
                  {items.length} 条提交
                </div>
                {batch.meta.unknownUsers.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="未知用户"
                    description={batch.meta.unknownUsers.join('、')}
                  />
                ) : null}
                {batch.meta.unresolvedProblems.length > 0 ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="未解析的题目文件夹"
                    description={batch.meta.unresolvedProblems.join('、')}
                  />
                ) : null}
                {batch.meta.ignoredFiles.length > 0 ? (
                  <Alert
                    type="info"
                    showIcon
                    message={`忽略 ${batch.meta.ignoredFiles.length} 个文件`}
                    description={batch.meta.ignoredFiles.join('、')}
                  />
                ) : null}
                {batch.status === 'draft' ? (
                  <Alert
                    type="info"
                    showIcon
                    message="正在评测批次"
                    description="页面每秒轮询批次状态，评测完成后可预览并发布。"
                  />
                ) : batch.status === 'failed' ? (
                  <Alert
                    type="error"
                    showIcon
                    message="批次评测失败"
                    description="请检查学生用户名、题目映射和源码后重新上传。"
                  />
                ) : null}

                <Table<ContestBatchItem>
                  className="oij-table"
                  rowKey={(row) => `${row.student}:${row.problemId}`}
                  size="small"
                  columns={itemColumns}
                  dataSource={items}
                  pagination={false}
                  locale={{ emptyText: '批次中没有可用提交' }}
                />

                {batch.status === 'ready' ? (
                  <>
                    <div className="contest-batch-actions">
                      <span className="muted">发布模式</span>
                      <Select
                        value={mode}
                        options={MODE_OPTIONS.map((option) => ({
                          value: option.value,
                          label: option.label,
                        }))}
                        onChange={(value: ContestBatchMode) => {
                          setMode(value);
                          setPreview(null);
                        }}
                        style={{ width: 210 }}
                      />
                      <span className="muted">{modeHint}</span>
                      <Button loading={previewing} onClick={() => void runPreview()}>
                        预览
                      </Button>
                      <Button
                        type="primary"
                        loading={publishing}
                        disabled={!canPublish}
                        onClick={() => void publish()}
                      >
                        发布到正式榜
                      </Button>
                      <Popconfirm
                        title="丢弃这个批次？"
                        description="丢弃后不会写入正式成绩；已评测的提交不会删除。"
                        okText="丢弃"
                        cancelText="取消"
                        onConfirm={() => void discard()}
                      >
                        <Button danger loading={discarding}>
                          丢弃批次
                        </Button>
                      </Popconfirm>
                    </div>
                    {actionError ? (
                      <Alert
                        className="batch-alert"
                        type="error"
                        showIcon
                        message="操作失败"
                        description={actionError}
                      />
                    ) : null}
                    {preview ? (
                      <div className="contest-batch-preview">
                        <div className="batch-preview-head">
                          <span>发布预览</span>
                          <span className="muted">
                            {preview.changed} 条分数将变化 / 共 {preview.rows.length} 条
                          </span>
                        </div>
                        <Table<ContestBatchPreviewRow>
                          className="oij-table"
                          rowKey={(row) => `${row.student}:${row.problemId}`}
                          size="small"
                          columns={previewColumns}
                          dataSource={preview.rows}
                          pagination={false}
                        />
                      </div>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : null}
          </Card>
        ) : null}
      </div>
    </div>
  );
}
