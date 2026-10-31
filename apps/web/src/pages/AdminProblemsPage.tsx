import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type {
  AdminProblemSummary,
  CreateProblemRequest,
  CreateProblemResult,
  ProblemType,
} from '../api/types';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatMemoryLimit, formatTimeLimit } from '../utils/format';
import { PROBLEM_TYPE_LABEL, difficultyLabel, problemTypeLabel } from '../utils/status';
import '../styles/admin.css';

interface CreateProblemFormValues {
  title: string;
  type: ProblemType;
  timeMs: number;
  memoryMb: number;
  difficulty?: number | null;
  tags?: string[];
  ioMode: 'stdio' | 'file';
  inputFile?: string;
  outputFile?: string;
  statement?: string;
}

const TYPE_OPTIONS = (Object.keys(PROBLEM_TYPE_LABEL) as ProblemType[]).map((value) => ({
  value,
  label: PROBLEM_TYPE_LABEL[value],
}));

const DEFAULT_FORM_VALUES: Partial<CreateProblemFormValues> = {
  type: 'standard',
  timeMs: 1000,
  memoryMb: 256,
  ioMode: 'stdio',
  tags: [],
  statement: '',
};

export function AdminProblemsPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form] = Form.useForm<CreateProblemFormValues>();
  const ioMode = Form.useWatch('ioMode', form);

  const problemsQuery = useQuery({
    queryKey: ['admin-problems'],
    queryFn: () => apiGet<AdminProblemSummary[]>('/api/admin/problems'),
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateProblemFormValues) => {
      const payload: CreateProblemRequest = {
        title: values.title.trim(),
        type: values.type,
        timeMs: Number(values.timeMs),
        memoryMb: Number(values.memoryMb),
        difficulty: values.difficulty ?? null,
        tags: (values.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0),
        ioMode: values.ioMode,
        inputFile: values.ioMode === 'file' ? values.inputFile?.trim() || null : null,
        outputFile: values.ioMode === 'file' ? values.outputFile?.trim() || null : null,
        statement: values.statement ?? '',
        ...(values.type === 'objective' ? { objective: { questions: [] } } : {}),
      };
      return apiPost<CreateProblemResult>('/api/admin/problems', payload);
    },
    onSuccess: (data) => {
      message.success(`题目 #${data.id} 已创建`);
      void queryClient.invalidateQueries({ queryKey: ['problems'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-problems'] });
      setDrawerOpen(false);
      form.resetFields();
      navigate(`/admin/problems/${data.id}`);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '创建题目失败');
    },
  });

  const openCreate = () => {
    form.resetFields();
    setDrawerOpen(true);
  };

  const columns: TableColumnsType<AdminProblemSummary> = [
    {
      title: 'ID',
      dataIndex: 'id',
      width: 64,
      render: (id: number) => <span className="mono">#{id}</span>,
    },
    {
      title: '题目',
      dataIndex: 'title',
      render: (_value, record) => (
        <Link to={`/admin/problems/${record.id}`} className="problem-link">
          {record.title}
        </Link>
      ),
    },
    {
      title: '可见性',
      dataIndex: 'visibility',
      width: 90,
      render: (visibility: AdminProblemSummary['visibility']) =>
        visibility === 'hidden' ? (
          <Tag color="gold">隐藏</Tag>
        ) : (
          <Tag color="green">公开</Tag>
        ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 100,
      render: (type: ProblemType) => problemTypeLabel(type),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 112,
      render: (value: number | null) => difficultyLabel(value),
    },
    {
      title: '限制',
      width: 160,
      render: (_value, record) => (
        <span className="mono">
          {formatTimeLimit(record.timeMs)} / {formatMemoryLimit(record.memoryMb)}
        </span>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      render: (tags: string[]) =>
        tags.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <span className="tag-list">
            {tags.map((tag) => (
              <Tag key={tag} bordered={false}>
                {tag}
              </Tag>
            ))}
          </span>
        ),
    },
    {
      title: '操作',
      width: 150,
      align: 'center',
      render: (_value, record) => (
        <Space size={12}>
          <Link to={`/admin/problems/${record.id}`}>编辑</Link>
          {record.visibility === 'public' ? (
            <Link to={`/problem/${record.id}`}>前台</Link>
          ) : (
            <span className="muted">前台不可见</span>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '管理' }]}
        title="题目管理"
        subtitle="包含公开与隐藏题目；创建题目并维护标准程序、校验器、测试数据等资产。"
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => void problemsQuery.refetch()}
              loading={problemsQuery.isFetching}
            >
              刷新
            </Button>
            <Button type="primary" onClick={openCreate}>
              新建题目
            </Button>
          </Space>
        }
      />

      <Card className="oij-card">
        {problemsQuery.isPending ? (
          <div className="inline-loading">
            <PageLoading tip="正在加载题目…" />
          </div>
        ) : problemsQuery.isError ? (
          <ErrorResult error={problemsQuery.error} onRetry={() => void problemsQuery.refetch()} />
        ) : (
          <Table<AdminProblemSummary>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={problemsQuery.data ?? []}
            pagination={false}
            locale={{ emptyText: '还没有题目，点击右上角“新建题目”开始。' }}
          />
        )}
      </Card>

      <Drawer
        title="新建题目"
        width={560}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        footer={
          <Space style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={() => setDrawerOpen(false)}>取消</Button>
            <Button type="primary" loading={createMutation.isPending} onClick={() => form.submit()}>
              创建
            </Button>
          </Space>
        }
      >
        <Form<CreateProblemFormValues>
          form={form}
          layout="vertical"
          initialValues={DEFAULT_FORM_VALUES}
          requiredMark={false}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            label="标题"
            name="title"
            rules={[{ required: true, message: '请输入题目标题' }]}
          >
            <Input placeholder="例如：A+B Problem" maxLength={120} showCount />
          </Form.Item>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="题目类型" name="type" rules={[{ required: true }]}>
                <Select options={TYPE_OPTIONS} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="时间限制 (ms)"
                name="timeMs"
                rules={[{ required: true, message: '请输入时限' }]}
              >
                <InputNumber min={1} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={6}>
              <Form.Item
                label="内存限制 (MB)"
                name="memoryMb"
                rules={[{ required: true, message: '请输入内存' }]}
              >
                <InputNumber min={1} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="难度（1-6，可空）" name="difficulty">
                <InputNumber min={1} max={6} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="IO 模式" name="ioMode">
                <Select
                  options={[
                    { value: 'stdio', label: '标准输入输出' },
                    { value: 'file', label: '文件 IO' },
                  ]}
                />
              </Form.Item>
            </Col>
          </Row>

          {ioMode === 'file' ? (
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item
                  label="输入文件名"
                  name="inputFile"
                  rules={[{ required: true, message: '请输入输入文件名' }]}
                >
                  <Input placeholder="例如 input.txt" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  label="输出文件名"
                  name="outputFile"
                  rules={[{ required: true, message: '请输入输出文件名' }]}
                >
                  <Input placeholder="例如 output.txt" />
                </Form.Item>
              </Col>
            </Row>
          ) : null}

          <Form.Item label="标签" name="tags">
            <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="输入后回车" />
          </Form.Item>

          <Form.Item
            label="题面（HTML）"
            name="statement"
            extra="后端将题面作为 HTML 原样保存；请填写合法 HTML。"
          >
            <Input.TextArea
              rows={7}
              placeholder={'<h1>题目名称</h1>\n<p>题目描述……</p>'}
            />
          </Form.Item>
        </Form>
      </Drawer>
    </div>
  );
}
