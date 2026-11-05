import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DeleteOutlined,
  PlusOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPost, apiPut } from '../api/client';
import type {
  AddProblemSetShareRequest,
  ProblemSetDetail,
  ProblemSetGranteeType,
  ProblemSetItem,
  ProblemSetShare,
  ProblemSetSharePermission,
  ProblemSetVisibility,
  TeamSummary,
  UpdateProblemSetRequest,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime, formatMemoryLimit, formatTimeLimit } from '../utils/format';
import { problemTypeLabel, difficultyLabel } from '../utils/status';
import {
  PROBLEM_SET_VISIBILITY_LABEL,
  describeProblemSetError,
  isProblemSetOrderDirty,
  moveProblemSetItem,
  problemIdsOf,
} from '../utils/problemSets';
import '../styles/problem-sets.css';

interface EditProblemSetFormValues {
  title: string;
  description?: string;
  visibility: ProblemSetVisibility;
}

const PERMISSION_LABEL: Record<ProblemSetSharePermission, string> = {
  read: '只读',
  edit: '可编辑',
};

const GRANTEE_LABEL: Record<ProblemSetGranteeType, string> = {
  user: '用户',
  team: '团队',
};

export function ProblemSetDetailPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const params = useParams<{ id: string }>();
  const problemSetId = Number(params.id);
  const validId = Number.isInteger(problemSetId) && problemSetId > 0;

  const [editOpen, setEditOpen] = useState(false);
  const [addProblemId, setAddProblemId] = useState<number | null>(null);
  const [shareType, setShareType] = useState<ProblemSetGranteeType>('user');
  const [shareId, setShareId] = useState<number | null>(null);
  const [sharePermission, setSharePermission] =
    useState<ProblemSetSharePermission>('read');
  const [editForm] = Form.useForm<EditProblemSetFormValues>();

  const detailQuery = useQuery({
    queryKey: ['problem-set', problemSetId],
    queryFn: () => apiGet<ProblemSetDetail>(`/api/problem-sets/${problemSetId}`),
    enabled: validId,
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<TeamSummary[]>('/api/teams'),
    enabled: validId,
  });
  const teamNames = useMemo(
    () => new Map((teamsQuery.data ?? []).map((team) => [team.id, team.name] as const)),
    [teamsQuery.data],
  );

  const detail = detailQuery.data;
  const retry = () => {
    void detailQuery.refetch();
  };
  // 题单题目顺序允许本地调整（上移/下移），保存时才提交；数据刷新后回到服务端顺序。
  const [items, setItems] = useState<ProblemSetItem[]>([]);
  useEffect(() => {
    setItems(detail?.items ?? []);
  }, [detail]);

  const invalidateDetail = () => {
    void queryClient.invalidateQueries({ queryKey: ['problem-set', problemSetId] });
    void queryClient.invalidateQueries({ queryKey: ['problem-sets'] });
  };

  const updateMutation = useMutation({
    mutationFn: (values: EditProblemSetFormValues) => {
      const payload: UpdateProblemSetRequest = {
        title: values.title.trim(),
        description: values.description?.trim() ?? '',
      };
      if (detail?.canManage) {
        payload.visibility = values.visibility;
      }
      return apiPut<null>(`/api/problem-sets/${problemSetId}`, payload);
    },
    onSuccess: () => {
      message.success('题单已更新');
      setEditOpen(false);
      invalidateDetail();
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '更新题单失败'));
    },
  });

  const addItemMutation = useMutation({
    mutationFn: (problemId: number) =>
      apiPost<null>(`/api/problem-sets/${problemSetId}/items`, { problemId }),
    onSuccess: () => {
      message.success('题目已添加');
      setAddProblemId(null);
      invalidateDetail();
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '添加题目失败'));
    },
  });

  const removeItemMutation = useMutation({
    mutationFn: (problemId: number) =>
      apiDelete<null>(`/api/problem-sets/${problemSetId}/items/${problemId}`),
    onSuccess: () => {
      message.success('题目已移除');
      invalidateDetail();
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '移除题目失败'));
    },
  });

  const reorderMutation = useMutation({
    mutationFn: (problemIds: number[]) =>
      apiPut<null>(`/api/problem-sets/${problemSetId}/items`, { problemIds }),
    onSuccess: () => {
      message.success('题目顺序已保存');
      invalidateDetail();
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '保存顺序失败'));
    },
  });

  const addShareMutation = useMutation({
    mutationFn: (values: AddProblemSetShareRequest) =>
      apiPost<null>(`/api/problem-sets/${problemSetId}/shares`, values),
    onSuccess: () => {
      message.success('分享已添加');
      setShareId(null);
      invalidateDetail();
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '添加分享失败'));
    },
  });

  const removeShareMutation = useMutation({
    mutationFn: (target: { granteeType: ProblemSetGranteeType; granteeId: number }) =>
      apiDelete<null>(
        `/api/problem-sets/${problemSetId}/shares/${target.granteeType}/${target.granteeId}`,
      ),
    onSuccess: () => {
      message.success('分享已移除');
      invalidateDetail();
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '移除分享失败'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete<null>(`/api/problem-sets/${problemSetId}`),
    onSuccess: () => {
      message.success('题单已删除');
      void queryClient.invalidateQueries({ queryKey: ['problem-sets'] });
      navigate('/problem-sets');
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '删除题单失败'));
    },
  });

  if (!validId) {
    return (
      <Result
        status="404"
        title="未找到题单"
        subTitle="题单编号无效。"
        extra={
          <Link to="/problem-sets">
            <Button type="primary">返回题单列表</Button>
          </Link>
        }
      />
    );
  }

  if (detailQuery.isPending) {
    return <PageLoading tip="正在加载题单…" />;
  }

  if (detailQuery.isError) {
    return <ErrorResult error={detailQuery.error} onRetry={retry} />;
  }

  if (!detail) {
    return <ErrorResult error={new Error('题单数据为空')} onRetry={retry} />;
  }

  const isDirty = isProblemSetOrderDirty(problemIdsOf(detail.items), problemIdsOf(items));
  const ownerLabel =
    detail.ownerType === 'team'
      ? `团队 · ${teamNames.get(detail.ownerId) ?? `#${detail.ownerId}`}`
      : detail.ownerId === user?.id
        ? '我（个人）'
        : `用户 #${detail.ownerId}`;

  const openEdit = () => {
    editForm.setFieldsValue({
      title: detail.title,
      description: detail.description,
      visibility: detail.visibility,
    });
    setEditOpen(true);
  };

  const itemColumns: TableColumnsType<ProblemSetItem> = [
    {
      title: '序号',
      width: 64,
      render: (_value, _item, index) => <span className="mono">{index + 1}</span>,
    },
    {
      title: '题目',
      dataIndex: 'title',
      render: (_value, item) => (
        <div className="problem-set-item-title">
          <Link to={`/problem/${item.problemId}`} className="problem-link">
            {item.title}
          </Link>
          <span className="muted mono"> #{item.problemId}</span>
        </div>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 104,
      render: (value: ProblemSetItem['type']) => problemTypeLabel(value),
    },
    {
      title: '难度',
      dataIndex: 'difficulty',
      width: 118,
      render: (value: number | null) => (
        <span className={`difficulty difficulty-${value ?? 0}`}>{difficultyLabel(value)}</span>
      ),
    },
    {
      title: '标签',
      dataIndex: 'tags',
      width: 176,
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
      title: '限制',
      width: 122,
      render: (_value, item) => (
        <span className="mono">
          {formatTimeLimit(item.timeMs)} / {formatMemoryLimit(item.memoryMb)}
        </span>
      ),
    },
    {
      title: '加入时间',
      dataIndex: 'addedAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
  ];

  if (detail.canEdit) {
    itemColumns.push({
      title: '操作',
      width: 158,
      render: (_value, item, index) => (
        <Space size={4}>
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            aria-label="上移"
            title="上移"
            disabled={index === 0}
            onClick={() => setItems((prev) => moveProblemSetItem(prev, index, -1))}
          />
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            aria-label="下移"
            title="下移"
            disabled={index === items.length - 1}
            onClick={() => setItems((prev) => moveProblemSetItem(prev, index, 1))}
          />
          <Popconfirm
            title="从题单移除该题目？"
            okText="移除"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => removeItemMutation.mutate(item.problemId)}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined />}
              aria-label="移除"
              title="移除"
              loading={
                removeItemMutation.isPending &&
                removeItemMutation.variables === item.problemId
              }
            />
          </Popconfirm>
        </Space>
      ),
    });
  }

  const shareColumns: TableColumnsType<ProblemSetShare> = [
    {
      title: '类型',
      dataIndex: 'granteeType',
      width: 100,
      render: (value: ProblemSetGranteeType) => (
        <Tag color={value === 'team' ? 'purple' : 'blue'}>{GRANTEE_LABEL[value]}</Tag>
      ),
    },
    {
      title: '对象',
      dataIndex: 'granteeId',
      render: (value: number, share) =>
        share.granteeType === 'team' ? (
          <span>
            团队<span className="muted"> · {teamNames.get(value) ?? `#${value}`}</span>
          </span>
        ) : (
          <span>
            用户<span className="muted mono"> #{value}</span>
          </span>
        ),
    },
    {
      title: '权限',
      dataIndex: 'permission',
      width: 110,
      render: (value: ProblemSetSharePermission) => (
        <Tag color={value === 'edit' ? 'gold' : undefined}>{PERMISSION_LABEL[value]}</Tag>
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      width: 96,
      render: (_value, share) => (
        <Popconfirm
          title="移除该分享？"
          okText="移除"
          okButtonProps={{ danger: true }}
          cancelText="取消"
          onConfirm={() =>
            removeShareMutation.mutate({
              granteeType: share.granteeType,
              granteeId: share.granteeId,
            })
          }
        >
          <Button size="small" danger>
            移除
          </Button>
        </Popconfirm>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '首页', to: '/contests' },
          { label: '题单', to: '/problem-sets' },
          { label: detail.title },
        ]}
        title={detail.title}
        tags={
          <>
            <Tag color={detail.visibility === 'public' ? 'green' : undefined}>
              {PROBLEM_SET_VISIBILITY_LABEL[detail.visibility]}
            </Tag>
            <Tag color={detail.ownerType === 'team' ? 'purple' : 'blue'}>{ownerLabel}</Tag>
            {detail.canManage ? (
              <Tag color="gold">可管理</Tag>
            ) : detail.canEdit ? (
              <Tag color="blue">可编辑</Tag>
            ) : (
              <Tag>只读</Tag>
            )}
          </>
        }
        subtitle={detail.description || '暂无描述'}
        extra={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={detailQuery.isFetching}
              onClick={() => void detailQuery.refetch()}
            >
              刷新
            </Button>
            {detail.canEdit ? (
              <Button onClick={openEdit}>编辑题单</Button>
            ) : null}
            {detail.canManage ? (
              <Popconfirm
                title="删除该题单？"
                description="题单及其题目列表、分享都会被删除，且无法恢复。"
                okText="删除"
                okButtonProps={{ danger: true }}
                cancelText="取消"
                onConfirm={() => deleteMutation.mutate()}
              >
                <Button danger loading={deleteMutation.isPending}>
                  删除题单
                </Button>
              </Popconfirm>
            ) : null}
          </Space>
        }
      />

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {!detail.canEdit ? (
          <Alert
            type="info"
            showIcon
            message="只读题单"
            description="你可以查看题目内容与顺序；编辑、题目管理和分享仅对所有者、团队队长或被授权编辑者开放。"
          />
        ) : null}

        <Card className="oij-card" title="基本信息">
          <Descriptions
            className="problem-set-descriptions"
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              {
                key: 'id',
                label: '题单编号',
                children: <span className="mono">#{detail.id}</span>,
              },
              { key: 'owner', label: '归属', children: ownerLabel },
              {
                key: 'visibility',
                label: '可见性',
                children: PROBLEM_SET_VISIBILITY_LABEL[detail.visibility],
              },
              {
                key: 'itemCount',
                label: '题目数',
                children: <span className="mono">{detail.items.length}</span>,
              },
              {
                key: 'createdAt',
                label: '创建时间',
                children: <span className="mono">{formatDateTime(detail.createdAt)}</span>,
              },
              {
                key: 'updatedAt',
                label: '更新时间',
                children: <span className="mono">{formatDateTime(detail.updatedAt)}</span>,
              },
            ]}
          />
        </Card>

        <Card
          className="oij-card"
          title={`题目（${items.length}）`}
          extra={
            detail.canEdit ? (
              <Space wrap size={12}>
                <span className="muted">
                  {isDirty ? '顺序已调整，尚未保存' : '可上移/下移后保存顺序'}
                </span>
                <Button
                  type="primary"
                  disabled={!isDirty}
                  loading={reorderMutation.isPending}
                  onClick={() => reorderMutation.mutate(problemIdsOf(items))}
                >
                  保存顺序
                </Button>
              </Space>
            ) : null
          }
        >
          {detail.canEdit ? (
            <Space wrap className="problem-set-items-toolbar">
              <span className="muted">添加题目：</span>
              <InputNumber
                min={1}
                precision={0}
                placeholder="输入题目 ID"
                value={addProblemId}
                onChange={(value) => setAddProblemId(typeof value === 'number' ? value : null)}
                style={{ width: 150 }}
              />
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={addProblemId === null}
                loading={addItemMutation.isPending}
                onClick={() => {
                  if (addProblemId !== null) addItemMutation.mutate(addProblemId);
                }}
              >
                添加
              </Button>
              <span className="muted">只允许添加当前可见的题目。</span>
            </Space>
          ) : null}
          <Table<ProblemSetItem>
            className="oij-table"
            rowKey="problemId"
            size="small"
            columns={itemColumns}
            dataSource={items}
            pagination={false}
            locale={{
              emptyText: detail.canEdit
                ? '题单还没有题目，使用上方输入框按题目 ID 添加。'
                : '题单还没有题目。',
            }}
          />
        </Card>

        {detail.canManage ? (
          <Card
            className="oij-card"
            title={`分享（${detail.shares.length}）`}
            extra={<span className="muted">仅所有者、团队队长或管理员可管理分享</span>}
          >
            <Space wrap className="problem-set-shares-toolbar">
              <Select<ProblemSetGranteeType>
                style={{ width: 94 }}
                value={shareType}
                onChange={(value) => setShareType(value)}
                options={[
                  { value: 'user', label: '用户' },
                  { value: 'team', label: '团队' },
                ]}
              />
              <InputNumber
                min={1}
                precision={0}
                placeholder={shareType === 'team' ? '团队 ID' : '用户 ID'}
                value={shareId}
                onChange={(value) => setShareId(typeof value === 'number' ? value : null)}
                style={{ width: 150 }}
              />
              <Select<ProblemSetSharePermission>
                style={{ width: 118 }}
                value={sharePermission}
                onChange={(value) => setSharePermission(value)}
                options={[
                  { value: 'read', label: '只读' },
                  { value: 'edit', label: '可编辑' },
                ]}
              />
              <Button
                type="primary"
                icon={<PlusOutlined />}
                disabled={shareId === null}
                loading={addShareMutation.isPending}
                onClick={() => {
                  if (shareId !== null) {
                    addShareMutation.mutate({
                      granteeType: shareType,
                      granteeId: shareId,
                      permission: sharePermission,
                    });
                  }
                }}
              >
                添加分享
              </Button>
            </Space>
            <Table<ProblemSetShare>
              className="oij-table"
              rowKey={(share) => `${share.granteeType}-${share.granteeId}`}
              size="small"
              columns={shareColumns}
              dataSource={detail.shares}
              pagination={false}
              locale={{ emptyText: '还没有分享给任何用户或团队。' }}
            />
          </Card>
        ) : null}
      </Space>

      <Modal
        title="编辑题单"
        open={editOpen}
        forceRender
        onCancel={() => setEditOpen(false)}
        onOk={() => editForm.submit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={updateMutation.isPending}
      >
        <Form<EditProblemSetFormValues>
          form={editForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => updateMutation.mutate(values)}
        >
          <Form.Item
            label="标题"
            name="title"
            rules={[
              { required: true, message: '请输入题单标题' },
              {
                validator: (_rule, value: string | undefined) => {
                  const length = Array.from((value ?? '').trim()).length;
                  if (length < 1 || length > 100) {
                    return Promise.reject(new Error('标题长度为 1~100 个字符'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={500} />
          </Form.Item>
          <Form.Item
            label="可见性"
            name="visibility"
            extra={
              detail.canManage
                ? '公开题单所有登录用户可读；私有题单仅所有者、团队成员与被分享者可见。'
                : '只有所有者、团队队长或管理员可以修改可见性。'
            }
          >
            <Select<ProblemSetVisibility>
              disabled={!detail.canManage}
              options={[
                { value: 'private', label: PROBLEM_SET_VISIBILITY_LABEL.private },
                { value: 'public', label: PROBLEM_SET_VISIBILITY_LABEL.public },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
