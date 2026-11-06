import { useState } from 'react';
import { App, Button, Card, Form, Input, Modal, Space, Switch, Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '../api/client';
import type { ClassSummary, CreateClassResult } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AllowContestTag, ClassRoleTag } from '../components/ClassTags';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import { describeClassError } from '../utils/classes';
import { formatDateTime } from '../utils/format';
import '../styles/classes.css';

interface CreateClassFormValues {
  name: string;
  allowContest: boolean;
}

export function ClassesPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<CreateClassFormValues>();

  // 创建班级仅对管理员与比赛管理员开放（后端同样会校验）。
  const canCreateClass = user?.role === 'admin' || user?.role === 'contestmanager';

  const classesQuery = useQuery({
    queryKey: ['classes'],
    queryFn: () => apiGet<ClassSummary[]>('/api/classes'),
  });

  const createMutation = useMutation({
    mutationFn: (values: CreateClassFormValues) =>
      apiPost<CreateClassResult>('/api/admin/classes', {
        name: values.name.trim(),
        allowContest: values.allowContest,
      }),
    onSuccess: (data) => {
      message.success('班级已创建');
      void queryClient.invalidateQueries({ queryKey: ['classes'] });
      setCreateOpen(false);
      navigate(`/classes/${data.id}`);
    },
    onError: (error) => {
      message.error(describeClassError(error, '创建班级失败'));
    },
  });

  const columns: TableColumnsType<ClassSummary> = [
    {
      title: '班级名称',
      dataIndex: 'name',
      render: (value: string, row) => (
        <Link to={`/classes/${row.id}`} className="class-name-link">
          {value}
        </Link>
      ),
    },
    {
      title: '成员数',
      dataIndex: 'memberCount',
      width: 90,
      render: (value: number) => <span className="mono">{value}</span>,
    },
    {
      title: '我的身份',
      dataIndex: 'role',
      width: 110,
      render: (value: ClassSummary['role']) => <ClassRoleTag role={value} />,
    },
    {
      title: '是否允许参赛',
      dataIndex: 'allowContest',
      width: 130,
      render: (value: boolean) => <AllowContestTag allow={value} />,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      width: 110,
      render: (_value, row) => (
        <Link to={`/classes/${row.id}`}>
          <Button size="small">查看详情</Button>
        </Link>
      ),
    },
  ];

  return (
    <div>
      <PageHead
        breadcrumb={[{ label: '首页', to: '/contests' }, { label: '班级' }]}
        title="班级"
        subtitle="班级由管理员或比赛管理员创建；教练可以维护学生名单，并在班级详情页查看学习统计、错题本与训练入口。"
        extra={
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={classesQuery.isFetching}
              onClick={() => void classesQuery.refetch()}
            >
              刷新
            </Button>
            {canCreateClass ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreateOpen(true)}
              >
                创建班级
              </Button>
            ) : null}
          </Space>
        }
      />

      <Card className="oij-card">
        {classesQuery.isPending ? (
          <PageLoading tip="正在加载我的班级…" />
        ) : classesQuery.isError ? (
          <ErrorResult error={classesQuery.error} onRetry={() => void classesQuery.refetch()} />
        ) : (
          <Table<ClassSummary>
            className="oij-table"
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={classesQuery.data ?? []}
            pagination={false}
            locale={{
              emptyText: (
                <div className="class-empty">
                  <div>你还没有加入任何班级。</div>
                  <div className="muted">
                    {canCreateClass
                      ? '可以创建班级，或让教练在班级详情页添加你的用户名。'
                      : '如需加入班级，请联系教练或管理员在班级详情页添加你的用户名。'}
                  </div>
                </div>
              ),
            }}
          />
        )}
      </Card>

      <Modal
        title="创建班级"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => form.submit()}
        okText="创建"
        cancelText="取消"
        confirmLoading={createMutation.isPending}
        afterClose={() => form.resetFields()}
        destroyOnHidden
      >
        <Form<CreateClassFormValues>
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{ allowContest: true }}
          onFinish={(values) => createMutation.mutate(values)}
        >
          <Form.Item
            label="班级名称"
            name="name"
            rules={[
              { required: true, message: '请输入班级名称' },
              {
                validator: (_rule, value: string | undefined) => {
                  const length = Array.from((value ?? '').trim()).length;
                  if (length < 2 || length > 40) {
                    return Promise.reject(new Error('班级名称长度为 2~40 个字符'));
                  }
                  return Promise.resolve();
                },
              },
            ]}
          >
            <Input placeholder="例如：高一(1)班" maxLength={40} />
          </Form.Item>
          <Form.Item
            label="允许以班级为单位参赛"
            name="allowContest"
            valuePropName="checked"
            extra="关闭后，班级仅用于教学管理，学生不会因加入班级而获得班级参赛资格。"
          >
            <Switch />
          </Form.Item>
          <div className="muted class-create-tip">
            创建后你将成为班级创建者（第一位教练），可继续添加教练与学生。班级名称唯一，长度为 2~40
            个字符。
          </div>
        </Form>
      </Modal>
    </div>
  );
}
