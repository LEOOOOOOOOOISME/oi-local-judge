import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  EyeOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '../api/client';
import type {
  DataPlan,
  DataPlanIssue,
  DataPlanTemplateId,
  GenerationJobCase,
  GenerationJobDetail,
  GenerationJobPreview,
  ProblemDetail,
} from '../api/types';
import { formatBytes } from '../utils/format';
import { AiPromptDrawer } from './AiPromptDrawer';
import {
  fromGroupDrafts,
  parsePlanJson,
  sumDraftCount,
  sumDraftPoints,
  toGroupDrafts,
  type PlanGroupDraft,
} from './data-plan-form';

const TEMPLATE_OPTIONS: Array<{ value: DataPlanTemplateId; label: string }> = [
  { value: '10-30-60', label: '10/30/60（常规题）' },
  { value: 'subtask-ladder', label: '子任务阶梯（部分分）' },
  { value: 'extreme-random', label: '极限 + 随机（构造题）' },
  { value: 'single-group', label: '只有一组（简单题）' },
];

const STATUS_COLOR: Record<string, string> = {
  queued: 'blue',
  running: 'processing',
  finished: 'green',
  failed: 'red',
  canceled: 'default',
  pending: 'default',
  blocked: 'orange',
};

function newGroupDraft(index: number, seedStart: number): PlanGroupDraft {
  return {
    id: `sub${index}`,
    name: `子任务 ${index}`,
    points: 0,
    count: 1,
    seedStart,
    argsText: '',
    dependsOn: [],
  };
}

export function DataPlanPanel({
  problemId,
  problem,
}: {
  problemId: number;
  problem: ProblemDetail;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [basePlan, setBasePlan] = useState<DataPlan | null>(null);
  const [drafts, setDrafts] = useState<PlanGroupDraft[]>([]);
  const [jsonText, setJsonText] = useState('');
  const [issues, setIssues] = useState<DataPlanIssue[]>([]);
  const [template, setTemplate] = useState<DataPlanTemplateId>('10-30-60');
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [preview, setPreview] = useState<
    (GenerationJobPreview & { title: string }) | null
  >(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

  const planQuery = useQuery({
    queryKey: ['data-plan', problemId],
    queryFn: () =>
      apiGet<{ plan: DataPlan | null; version: number; updatedAt: number | null }>(
        `/api/admin/problems/${problemId}/data-plan`,
      ),
  });

  useEffect(() => {
    const plan = planQuery.data?.plan;
    if (!plan) return;
    setBasePlan(plan);
    setDrafts(toGroupDrafts(plan));
    setJsonText(JSON.stringify(plan, null, 2));
  }, [planQuery.data]);

  const jobQuery = useQuery<GenerationJobDetail>({
    queryKey: ['generation-job', problemId, jobId],
    queryFn: () =>
      apiGet<GenerationJobDetail>(
        `/api/admin/problems/${problemId}/generation-jobs/${jobId!}`,
      ),
    enabled: jobId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'queued' || status === 'running' ? 1500 : false;
    },
  });
  const job = jobQuery.data ?? null;

  const draftPlan = useMemo(
    () => (basePlan ? fromGroupDrafts(basePlan, drafts) : null),
    [basePlan, drafts],
  );
  const points = sumDraftPoints(drafts);
  const count = sumDraftCount(drafts);

  const updateDraft = (index: number, patch: Partial<PlanGroupDraft>) => {
    setDrafts((previous) =>
      previous.map((draft, position) =>
        position === index ? { ...draft, ...patch } : draft,
      ),
    );
  };

  const removeDraft = (index: number) => {
    setDrafts((previous) => previous.filter((_, position) => position !== index));
  };

  const applyTemplate = async () => {
    try {
      const result = await apiPost<{ plan: DataPlan }>(
        `/api/admin/problems/${problemId}/data-plan/template`,
        { template },
      );
      setBasePlan(result.plan);
      setDrafts(toGroupDrafts(result.plan));
      setJsonText(JSON.stringify(result.plan, null, 2));
      setIssues([]);
      message.success('已生成模板，请确认分值与参数后保存');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '模板生成失败');
    }
  };

  const validate = async () => {
    if (!draftPlan) return;
    setValidating(true);
    try {
      const result = await apiPost<{
        valid: boolean;
        issues: DataPlanIssue[];
      }>(`/api/admin/problems/${problemId}/data-plan/validate`, {
        plan: draftPlan,
      });
      setIssues(result.issues);
      if (result.valid) message.success('数据计划通过校验');
      else message.warning('数据计划存在问题');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '校验失败');
    } finally {
      setValidating(false);
    }
  };

  const save = async () => {
    if (!draftPlan) return;
    setSaving(true);
    try {
      const saved = await apiPut<{ plan: DataPlan; version: number }>(
        `/api/admin/problems/${problemId}/data-plan`,
        { plan: draftPlan },
      );
      setBasePlan(saved.plan);
      setDrafts(toGroupDrafts(saved.plan));
      setJsonText(JSON.stringify(saved.plan, null, 2));
      setIssues([]);
      message.success(`数据计划已保存（v${saved.version}）`);
      void queryClient.invalidateQueries({ queryKey: ['data-plan', problemId] });
    } catch (error) {
      message.error(error instanceof Error ? error.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    if (!draftPlan) return;
    setStarting(true);
    try {
      const result = await apiPost<{ id: number; total: number }>(
        `/api/admin/problems/${problemId}/generation-jobs`,
        { plan: draftPlan },
      );
      setJobId(result.id);
      message.success(`已启动生成任务 #${result.id}，共 ${result.total} 个测试点`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '启动生成失败');
    } finally {
      setStarting(false);
    }
  };

  const cancelJob = async () => {
    if (!job) return;
    try {
      await apiPost(
        `/api/admin/problems/${problemId}/generation-jobs/${job.id}/cancel`,
      );
      message.success('已请求取消，当前测试点结束后生效');
      void jobQuery.refetch();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '取消失败');
    }
  };

  const openPreview = async (row: GenerationJobCase) => {
    if (!job) return;
    setPreviewLoading(true);
    try {
      const data = await apiGet<GenerationJobPreview>(
        `/api/admin/problems/${problemId}/generation-jobs/${job.id}/cases/${row.id}/preview?lines=100`,
      );
      setPreview({ ...data, title: `${row.groupId}-${row.index}` });
      setPreviewOpen(true);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '读取预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  const applyJson = () => {
    const parsed = parsePlanJson(jsonText);
    if (!parsed.ok) {
      message.error(parsed.message);
      return;
    }
    setBasePlan(parsed.plan);
    setDrafts(toGroupDrafts(parsed.plan));
    setIssues([]);
    message.success('JSON 已应用到表单');
  };

  const groupColumns: TableColumnsType<PlanGroupDraft> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 110,
      render: (value: string, _row, index) => (
        <Input
          value={value}
          onChange={(event) => updateDraft(index, { id: event.target.value })}
        />
      ),
    },
    {
      title: '名称',
      dataIndex: 'name',
      width: 150,
      render: (value: string, _row, index) => (
        <Input
          value={value}
          onChange={(event) => updateDraft(index, { name: event.target.value })}
        />
      ),
    },
    {
      title: '测试点数',
      dataIndex: 'count',
      width: 110,
      render: (value: number, _row, index) => (
        <InputNumber
          min={1}
          max={100}
          precision={0}
          value={value}
          onChange={(next) =>
            updateDraft(index, { count: typeof next === 'number' ? next : 1 })
          }
        />
      ),
    },
    {
      title: '分值',
      dataIndex: 'points',
      width: 100,
      render: (value: number, _row, index) => (
        <InputNumber
          min={0}
          precision={0}
          value={value}
          onChange={(next) =>
            updateDraft(index, { points: typeof next === 'number' ? next : 0 })
          }
        />
      ),
    },
    {
      title: 'seed 起始',
      dataIndex: 'seedStart',
      width: 120,
      render: (value: number, _row, index) => (
        <InputNumber
          min={0}
          precision={0}
          value={value}
          onChange={(next) =>
            updateDraft(index, { seedStart: typeof next === 'number' ? next : 0 })
          }
        />
      ),
    },
    {
      title: 'generator 参数',
      dataIndex: 'argsText',
      render: (value: string, _row, index) => (
        <Select
          mode="tags"
          value={value.split(/\s+/).filter(Boolean)}
          onChange={(next: string[]) =>
            updateDraft(index, { argsText: next.join(' ') })
          }
          tokenSeparators={[' ']}
          placeholder="--n=10 --max-v=100"
          style={{ minWidth: 220 }}
        />
      ),
    },
    {
      title: '依赖',
      dataIndex: 'dependsOn',
      width: 180,
      render: (value: string[], row, index) => (
        <Select
          mode="multiple"
          value={value}
          onChange={(next: string[]) => updateDraft(index, { dependsOn: next })}
          options={drafts
            .filter((candidate) => candidate.id !== row.id)
            .map((candidate) => ({ value: candidate.id, label: candidate.id }))}
          placeholder="无"
          style={{ width: '100%' }}
        />
      ),
    },
    {
      title: '',
      width: 70,
      render: (_value, _row, index) => (
        <Popconfirm
          title="删除这个子任务？"
          onConfirm={() => removeDraft(index)}
        >
          <Button danger size="small" type="text">
            删除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  const caseColumns: TableColumnsType<GenerationJobCase> = [
    { title: '子任务', dataIndex: 'groupId', width: 90 },
    { title: '#', dataIndex: 'index', width: 50 },
    {
      title: 'seed',
      dataIndex: 'seed',
      width: 80,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (value: string) => <Tag color={STATUS_COLOR[value]}>{value}</Tag>,
    },
    {
      title: '用时',
      dataIndex: 'stdTimeMs',
      width: 80,
      render: (value: number) => `${value} ms`,
    },
    {
      title: '内存',
      dataIndex: 'stdMemoryKb',
      width: 90,
      render: (value: number) => formatBytes(value * 1024),
    },
    {
      title: '输入',
      dataIndex: 'inputBytes',
      width: 90,
      render: (value: number) => formatBytes(value),
    },
    {
      title: '失败点',
      dataIndex: 'message',
      render: (value: string) =>
        value ? (
          <span className="mono data-plan-case-message">{value}</span>
        ) : (
          <span className="muted">—</span>
        ),
    },
    {
      title: '预览',
      width: 90,
      render: (_value, row) => (
        <Button
          size="small"
          icon={<EyeOutlined />}
          disabled={!row.inputPath}
          loading={previewLoading}
          onClick={() => void openPreview(row)}
        >
          查看
        </Button>
      ),
    },
  ];

  if (planQuery.isLoading) {
    return (
      <div className="inline-loading">
        <Spin />
      </div>
    );
  }

  if (planQuery.isError) {
    return <Alert type="error" showIcon message="加载数据计划失败" />;
  }

  return (
    <div className="data-plan-panel">
      <Card
        className="oij-card"
        title="数据计划"
        extra={
          <Space>
            <AiPromptDrawer problem={problem} plan={draftPlan} />
            <Button
              icon={<ReloadOutlined />}
              loading={validating}
              disabled={!draftPlan}
              onClick={() => void validate()}
            >
              校验
            </Button>
            <Button
              type="primary"
              loading={saving}
              disabled={!draftPlan}
              onClick={() => void save()}
            >
              保存计划
            </Button>
          </Space>
        }
      >
        <div className="data-plan-toolbar">
          <Space>
            <Select<DataPlanTemplateId>
              value={template}
              onChange={setTemplate}
              options={TEMPLATE_OPTIONS}
              style={{ width: 260 }}
            />
            <Button icon={<ThunderboltOutlined />} onClick={() => void applyTemplate()}>
              生成模板
            </Button>
          </Space>
          <span className="data-plan-summary">
            测试点 <strong>{count}</strong> 个 · 总分{' '}
            <strong className={points === 100 ? 'score-ok' : 'score-bad'}>
              {points}
            </strong>{' '}
            / 100
          </span>
        </div>

        {draftPlan ? (
          <>
            <Table<PlanGroupDraft>
              className="oij-table data-plan-groups"
              rowKey={(row) => `${row.id}-${row.seedStart}`}
              size="small"
              columns={groupColumns}
              dataSource={drafts}
              pagination={false}
              scroll={{ x: 1180 }}
            />
            <Button
              className="data-plan-add-group"
              icon={<PlusOutlined />}
              onClick={() =>
                setDrafts((previous) => [
                  ...previous,
                  newGroupDraft(
                    previous.length + 1,
                    previous.reduce(
                      (max, group) => Math.max(max, group.seedStart + group.count),
                      0,
                    ) + 1,
                  ),
                ])
              }
            >
              添加子任务
            </Button>
          </>
        ) : (
          <Empty description="还没有数据计划">
            <Button type="primary" onClick={() => void applyTemplate()}>
              从模板创建
            </Button>
          </Empty>
        )}

        <Collapse
          className="data-plan-json"
          items={[
            {
              key: 'json',
              label: '高级 JSON',
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input.TextArea
                    value={jsonText}
                    onChange={(event) => setJsonText(event.target.value)}
                    rows={12}
                    className="mono"
                  />
                  <Space>
                    <Button onClick={applyJson}>应用 JSON</Button>
                    <Button
                      disabled={!draftPlan}
                      onClick={() =>
                        setJsonText(JSON.stringify(draftPlan, null, 2))
                      }
                    >
                      从表单生成 JSON
                    </Button>
                  </Space>
                </Space>
              ),
            },
          ]}
        />

        {issues.length > 0 ? (
          <Alert
            className="data-plan-issues"
            type={issues.some((issue) => issue.severity === 'error') ? 'error' : 'warning'}
            showIcon
            message="数据计划校验结果"
            description={
              <ul>
                {issues.map((issue) => (
                  <li key={`${issue.path}-${issue.code}`}>
                    <span className="mono">{issue.path}</span>：{issue.message}
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}
      </Card>

      <Card
        className="oij-card data-plan-job-card"
        title="生成任务"
        extra={
          job ? (
            <Space>
              <Tag color={STATUS_COLOR[job.status]}>{job.status}</Tag>
              {job.status === 'queued' || job.status === 'running' ? (
                <Popconfirm title="取消当前生成任务？" onConfirm={() => void cancelJob()}>
                  <Button danger icon={<StopOutlined />}>
                    取消
                  </Button>
                </Popconfirm>
              ) : null}
            </Space>
          ) : null
        }
      >
        {!job ? (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Empty description="保存计划后启动生成" />
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              loading={starting}
              disabled={!draftPlan}
              onClick={() => void start()}
            >
              启动生成
            </Button>
          </Space>
        ) : (
          <>
            <Descriptions
              size="small"
              column={4}
              items={[
                { key: 'id', label: '任务', children: `#${job.id}` },
                {
                  key: 'progress',
                  label: '进度',
                  children: `${job.completed} / ${job.total}`,
                },
                { key: 'failed', label: '失败', children: job.failed },
                { key: 'message', label: '状态', children: job.message || '—' },
              ]}
            />
            <Table<GenerationJobCase>
              className="oij-table data-plan-cases"
              rowKey="id"
              size="small"
              columns={caseColumns}
              dataSource={job.cases}
              pagination={false}
              scroll={{ x: 980, y: 360 }}
            />
          </>
        )}
      </Card>

      <Modal
        title={`测试点预览 · ${preview?.title ?? ''}`}
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={null}
        width={1000}
      >
        {preview ? (
          <Tabs
            items={[
              {
                key: 'input',
                label: `输入${preview.inputTruncated ? '（已截断）' : ''}`,
                children: <pre className="data-plan-preview">{preview.input}</pre>,
              },
              {
                key: 'output',
                label: `输出${preview.outputTruncated ? '（已截断）' : ''}`,
                children: <pre className="data-plan-preview">{preview.output}</pre>,
              },
            ]}
          />
        ) : null}
      </Modal>
    </div>
  );
}
