import { useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { LockOutlined, PushpinOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiGet, apiPost } from '../api/client';
import type {
  CreatePostRequest,
  CreatePostResult,
  PostCategory,
  PostSummary,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { formatDateTime } from '../utils/format';
import '../styles/community.css';

const CATEGORY_LABEL: Record<PostCategory, string> = {
  discuss: '讨论',
  solution: '题解',
  announcement: '公告',
};

const ROLE_CAN_ANNOUNCE = ['admin', 'setter', 'contestmanager'];

interface PostFormValues {
  category: PostCategory;
  title: string;
  body: string;
  problemId?: number | null;
  contestId?: number | null;
}

export function DiscussPage() {
  const { user } = useAuth();
  const { message } = App.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<PostCategory>('discuss');
  const [modalOpen, setModalOpen] = useState(false);
  const [form] = Form.useForm<PostFormValues>();

  const categoryOptions = useMemo(() => {
    const values: PostCategory[] = ['discuss', 'solution'];
    if (user && ROLE_CAN_ANNOUNCE.includes(user.role)) values.push('announcement');
    return values.map((value) => ({ value, label: CATEGORY_LABEL[value] }));
  }, [user]);

  const postsQuery = useQuery({
    queryKey: ['posts', category],
    queryFn: () => apiGet<PostSummary[]>(`/api/posts?category=${category}&limit=50`),
  });

  const createMutation = useMutation({
    mutationFn: (values: PostFormValues) => {
      const payload: CreatePostRequest = {
        category: values.category,
        title: values.title.trim(),
        body: values.body,
        problemId: values.problemId ?? null,
        contestId: values.contestId ?? null,
      };
      return apiPost<CreatePostResult>('/api/posts', payload);
    },
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['posts'] });
      setModalOpen(false);
      form.resetFields();
      if (data.status === 'pending') {
        message.warning('题解已提交，等待管理员审核后公开。');
        return;
      }
      message.success('帖子已发布');
      navigate(`/discuss/${data.id}`);
    },
    onError: (error) => {
      let text = error instanceof Error ? error.message : '发帖失败';
      if (error instanceof ApiError) {
        if (error.code === 'RATE_LIMITED') text = '发帖过于频繁，请稍后再试（5 次/分钟）';
        if (error.code === 'FORBIDDEN') text = '当前角色不能发布该分类';
        if (error.code === 'EMPTY_POST') text = '标题和正文不能为空';
      }
      message.error(text);
    },
  });

  const columns: TableColumnsType<PostSummary> = [
    {
      title: '标题',
      dataIndex: 'title',
      render: (title: string, record) => (
        <span className="discuss-title-cell">
          {record.pinned ? <PushpinOutlined className="discuss-pin" /> : null}
          {record.locked ? <LockOutlined className="muted" /> : null}
          <Link to={`/discuss/${record.id}`}>{title}</Link>
        </span>
      ),
    },
    {
      title: '作者',
      dataIndex: 'author',
      width: 150,
      render: (_value, record) => record.author.realName ?? record.author.username,
    },
    {
      title: '分类',
      dataIndex: 'category',
      width: 86,
      render: (value: PostCategory) => <Tag>{CATEGORY_LABEL[value] ?? value}</Tag>,
    },
    {
      title: '关联',
      width: 150,
      render: (_value, record) => (
        <Space size={8} wrap>
          {record.problemId !== null ? (
            <Link to={`/problem/${record.problemId}`}>题目 #{record.problemId}</Link>
          ) : null}
          {record.contestId !== null ? (
            <Link to={`/contest/${record.contestId}`}>比赛 #{record.contestId}</Link>
          ) : null}
          {record.problemId === null && record.contestId === null ? (
            <span className="muted">—</span>
          ) : null}
        </Space>
      ),
    },
    {
      title: '发布时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
  ];

  const openCreate = () => {
    form.resetFields();
    form.setFieldsValue({ category, title: '', body: '' });
    setModalOpen(true);
  };

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '讨论' }]}
        title="讨论区"
        subtitle="交流题目与比赛、阅读题解和公告；题解由选手提交后需管理员审核。"
        extra={
          user ? (
            <Space>
              {ROLE_CAN_ANNOUNCE.includes(user.role) ? (
                <Link to="/admin/posts">
                  <Button>审核管理</Button>
                </Link>
              ) : null}
              <Button type="primary" onClick={openCreate}>
                发帖
              </Button>
            </Space>
          ) : (
            <Link to={`/login?next=${encodeURIComponent('/discuss')}`}>
              <Button type="primary">登录后发帖</Button>
            </Link>
          )
        }
      />

      <Card className="oij-card">
        <Tabs
          className="problem-tabs"
          activeKey={category}
          onChange={(key) => setCategory(key as PostCategory)}
          items={(Object.keys(CATEGORY_LABEL) as PostCategory[]).map((key) => ({
            key,
            label: CATEGORY_LABEL[key],
            children:
              key === category ? (
                <PostTable
                  posts={postsQuery.data ?? []}
                  columns={columns}
                  loading={postsQuery.isPending}
                  error={postsQuery.isError ? postsQuery.error : null}
                  onRetry={() => void postsQuery.refetch()}
                />
              ) : null,
          }))}
        />
      </Card>

      <Modal
        title="发布帖子"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        okText="发布"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        width={680}
        destroyOnHidden
      >
        <Form<PostFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item label="分类" name="category" rules={[{ required: true }]}>
            <Select options={categoryOptions} />
          </Form.Item>
          <Form.Item
            label="标题"
            name="title"
            rules={[{ required: true, message: '请输入标题' }]}
          >
            <Input maxLength={200} showCount />
          </Form.Item>
          <Form.Item
            label="正文（Markdown）"
            name="body"
            rules={[{ required: true, message: '请输入正文' }]}
            extra="支持 Markdown；渲染由服务端完成并禁用原始 HTML。"
          >
            <Input.TextArea rows={10} maxLength={50000} showCount />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item label="关联题目 ID（可选）" name="problemId" style={{ marginBottom: 0 }}>
              <InputNumber min={1} precision={0} placeholder="题目 ID" />
            </Form.Item>
            <Form.Item label="关联比赛 ID（可选）" name="contestId" style={{ marginBottom: 0 }}>
              <InputNumber min={1} precision={0} placeholder="比赛 ID" />
            </Form.Item>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}

function PostTable({
  posts,
  columns,
  loading,
  error,
  onRetry,
}: {
  posts: PostSummary[];
  columns: TableColumnsType<PostSummary>;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (loading) return <PageLoading tip="正在加载帖子…" />;
  if (error) return <ErrorResult error={error} onRetry={onRetry} />;
  return (
    <Table<PostSummary>
      className="oij-table"
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={posts}
      pagination={false}
      locale={{ emptyText: '该分类下还没有帖子' }}
    />
  );
}
