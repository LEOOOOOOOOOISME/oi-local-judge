import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
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
import { apiGet, apiPatch, apiPost, apiUpload } from '../api/client';
import type {
  AdminProblemSummary,
  CreateProblemRequest,
  CreateProblemResult,
  ProblemCategory,
  ProblemOwnerType,
  ProblemType,
  TeamSummary,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatMemoryLimit, formatTimeLimit } from '../utils/format';
import {
  PROBLEM_OWNER_TYPE_LABEL,
  problemOwnerColor,
  problemOwnerLabel,
} from '../utils/problemAcl';
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
  ownerType: ProblemOwnerType;
  teamId?: number;
  /** 题号分类；默认 P。 */
  categoryId?: number;
  /** 手动指定题号；留空自动分配。 */
  displayId?: string;
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
  ownerType: 'user',
};

export function AdminProblemsPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);
  const [form] = Form.useForm<CreateProblemFormValues>();
  const ioMode = Form.useWatch('ioMode', form);
  const ownerType = (Form.useWatch('ownerType', form) ?? 'user') as ProblemOwnerType;
  const [categoryOpen, setCategoryOpen] = useState(false);
  const [categoryForm] = Form.useForm<{ code: string; name?: string; seqStart?: number }>();
  const [renameTarget, setRenameTarget] = useState<ProblemCategory | null>(null);
  const [renameName, setRenameName] = useState('');

  const problemsQuery = useQuery({
    queryKey: ['admin-problems'],
    queryFn: () => apiGet<AdminProblemSummary[]>('/api/admin/problems'),
    staleTime: 30_000,
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
    staleTime: 60_000,
  });
  const categoriesQuery = useQuery({
    queryKey: ['admin-problem-categories'],
    queryFn: () => apiGet<ProblemCategory[]>('/api/admin/problem-categories'),
    staleTime: 60_000,
  });
  const categories = categoriesQuery.data ?? [];
  const createCategoryMutation = useMutation({
    mutationFn: (values: { code: string; name?: string; seqStart?: number }) =>
      apiPost<ProblemCategory>('/api/admin/problem-categories', {
        code: values.code.trim(),
        name: values.name?.trim() || undefined,
        seqStart: values.seqStart ?? undefined,
      }),
    onSuccess: (category) => {
      message.success(`分类 ${category.code} 已创建`);
      void queryClient.invalidateQueries({ queryKey: ['admin-problem-categories'] });
      categoryForm.resetFields();
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '创建分类失败');
    },
  });
  const renameCategoryMutation = useMutation({
    mutationFn: (values: { id: number; name: string }) =>
      apiPatch<ProblemCategory>(`/api/admin/problem-categories/${values.id}`, {
        name: values.name,
      }),
    onSuccess: () => {
      message.success('分类已重命名');
      void queryClient.invalidateQueries({ queryKey: ['admin-problem-categories'] });
      setRenameTarget(null);
    },
    onError: (error) => {
      message.error(error instanceof Error ? error.message : '重命名失败');
    },
  });
  const teams = teamsQuery.data ?? [];
  const teamNames = useMemo(
    () => new Map(teams.map((team) => [team.id, team.name] as const)),
    [teams],
  );
  const ownerTypeOptions = [
    { value: 'user', label: PROBLEM_OWNER_TYPE_LABEL.user },
    {
      value: 'team',
      label:
        teams.length === 0
          ? `${PROBLEM_OWNER_TYPE_LABEL.team}（需先加入团队）`
          : PROBLEM_OWNER_TYPE_LABEL.team,
      disabled: teams.length === 0,
    },
    { value: 'system', label: PROBLEM_OWNER_TYPE_LABEL.system },
  ];

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
        ownerType: values.ownerType,
        // 个人题省略 ownerId，由服务端默认归属当前账号；系统题显式置空。
        ...(values.ownerType === 'team' ? { ownerId: values.teamId ?? null } : {}),
        ...(values.ownerType === 'system' ? { ownerId: null } : {}),
        ...(values.type === 'objective' ? { objective: { questions: [] } } : {}),
        categoryId: values.categoryId,
        displayId: values.displayId?.trim() || undefined,
      };
      return apiPost<CreateProblemResult>('/api/admin/problems', payload);
    },
    onSuccess: (data) => {
      message.success(`题目 ${data.displayId || `#${data.id}`} 已创建`);
      void queryClient.invalidateQueries({ queryKey: ['problems'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-problems'] });
      void queryClient.invalidateQueries({ queryKey: ['admin-problem-categories'] });
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
    const defaultCategory =
      categories.find((category) => category.code === 'P') ?? categories[0];
    form.setFieldsValue({ categoryId: defaultCategory?.id });
    setDrawerOpen(true);
  };

  const columns: TableColumnsType<AdminProblemSummary> = [
    {
      title: '题号',
      dataIndex: 'displayId',
      width: 96,
      render: (_value, record) => (
        <span className="problem-no mono">{record.displayId || `#${record.id}`}</span>
      ),
    },
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
      title: '归属',
      dataIndex: 'ownerType',
      width: 170,
      render: (_value, record) => (
        <Tag color={problemOwnerColor(record.ownerType)}>
          {problemOwnerLabel(record.ownerType, record.ownerId, {
            currentUserId: user?.id,
            teamNames,
          })}
        </Tag>
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
            <Link to={`/problem/${record.displayId || record.id}`}>前台</Link>
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
            <Button
              loading={importing}
              onClick={() => importInputRef.current?.click()}
            >
              导入题包
            </Button>
            {user?.role === 'admin' ? (
              <Button
                onClick={() => {
                  categoryForm.resetFields();
                  setCategoryOpen(true);
                }}
              >
                题号分类
              </Button>
            ) : null}
            <input
              ref={importInputRef}
              type="file"
              accept=".zip,application/zip"
              style={{ display: 'none' }}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                setImporting(true);
                try {
                  const result = await apiUpload<{ id: number }>(
                    '/api/admin/problems/import-zip',
                    file,
                    'application/zip',
                  );
                  message.success(`题目 #${result.id} 已导入`);
                  void queryClient.invalidateQueries({ queryKey: ['admin-problems'] });
                  void queryClient.invalidateQueries({ queryKey: ['problems'] });
                  navigate(`/admin/problems/${result.id}`);
                } catch (error) {
                  message.error(error instanceof Error ? error.message : '导入失败');
                } finally {
                  setImporting(false);
                }
              }}
            />
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
              <Form.Item
                label="题号分类"
                name="categoryId"
                rules={[{ required: true, message: '请选择题号分类' }]}
                extra="自动分配该分类的下一个题号"
              >
                <Select
                  placeholder="选择分类"
                  loading={categoriesQuery.isPending}
                  options={categories.map((category) => ({
                    value: category.id,
                    label: `${category.code} · ${category.name}`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                label="手动题号（可选）"
                name="displayId"
                extra="留空自动分配；格式如 P1001"
              >
                <Input placeholder="例如 P1001" />
              </Form.Item>
            </Col>
          </Row>

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

          <Form.Item
            label="归属"
            name="ownerType"
            extra="个人题归当前账号；团队题需选择你所在的团队；系统题由管理员统一维护。"
          >
            <Radio.Group options={ownerTypeOptions} />
          </Form.Item>

          {ownerType === 'team' ? (
            teams.length === 0 ? (
              <Alert
                type="warning"
                showIcon
                message="还没有可归属的团队"
                description={
                  <span>
                    请先在 <Link to="/teams">团队</Link> 页创建或加入团队，再创建团队题目。
                  </span>
                }
              />
            ) : (
              <Form.Item
                label="团队"
                name="teamId"
                rules={[{ required: true, message: '请选择团队' }]}
              >
                <Select
                  placeholder="选择团队"
                  options={teams.map((team) => ({ value: team.id, label: team.name }))}
                />
              </Form.Item>
            )
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

      <Modal
        title="题号分类"
        open={categoryOpen}
        onCancel={() => setCategoryOpen(false)}
        footer={<Button onClick={() => setCategoryOpen(false)}>关闭</Button>}
        width={720}
      >
        <div className="stack">
          <Table<ProblemCategory>
            className="oij-table"
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={categories}
            loading={categoriesQuery.isPending}
            locale={{ emptyText: '还没有分类' }}
            columns={[
              {
                title: '代码',
                dataIndex: 'code',
                width: 90,
                render: (code: string) => <span className="mono">{code}</span>,
              },
              { title: '名称', dataIndex: 'name' },
              {
                title: '下一个题号',
                width: 130,
                render: (_value, record) => (
                  <span className="mono">
                    {record.code}
                    {record.nextSeq}
                  </span>
                ),
              },
              {
                title: '',
                width: 90,
                render: (_value, record) => (
                  <Button
                    size="small"
                    onClick={() => {
                      setRenameTarget(record);
                      setRenameName(record.name);
                    }}
                  >
                    重命名
                  </Button>
                ),
              },
            ]}
          />
          <Card size="small" title="新建分类">
            <Form<{ code: string; name?: string; seqStart?: number }>
              form={categoryForm}
              layout="inline"
              onFinish={(values) => createCategoryMutation.mutate(values)}
            >
              <Form.Item
                label="代码"
                name="code"
                rules={[
                  { required: true, message: '请输入前缀代码' },
                  { pattern: /^[A-Za-z]{1,8}$/, message: '1-8 个字母，如 B、UVA' },
                ]}
              >
                <Input placeholder="例如 B" style={{ width: 120 }} />
              </Form.Item>
              <Form.Item label="名称" name="name">
                <Input placeholder="例如 B 题库" style={{ width: 160 }} />
              </Form.Item>
              <Form.Item label="起始序号" name="seqStart">
                <InputNumber min={1} precision={0} placeholder="默认 1" style={{ width: 110 }} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={createCategoryMutation.isPending}>
                  新增
                </Button>
              </Form.Item>
            </Form>
            <div className="muted">
              分类前缀按题号独立递增；已有题目重新分配题号请在题目编辑页操作。移除分类不会删除题目。
            </div>
          </Card>
        </div>
      </Modal>

      <Modal
        title={`重命名分类 ${renameTarget?.code ?? ''}`}
        open={renameTarget !== null}
        onCancel={() => setRenameTarget(null)}
        onOk={() =>
          renameTarget &&
          renameCategoryMutation.mutate({ id: renameTarget.id, name: renameName.trim() })
        }
        okText="保存"
        cancelText="取消"
        confirmLoading={renameCategoryMutation.isPending}
      >
        <Input
          value={renameName}
          onChange={(event) => setRenameName(event.target.value)}
          maxLength={60}
        />
      </Modal>
    </div>
  );
}
