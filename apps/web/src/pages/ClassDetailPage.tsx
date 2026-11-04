import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Switch,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined, SettingOutlined, DeleteOutlined } from '@ant-design/icons';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '../api/client';
import type { ClassDetail, ClassMember, ClassRole, UpdateClassRequest } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { AllowContestTag, ClassRoleTag } from '../components/ClassTags';
import { ClassWorkbench } from '../components/ClassWorkbench';
import { PageHead } from '../components/PageHead';
import { ErrorResult, PageLoading } from '../components/PageStates';
import {
  CLASS_MEMBER_ROLE_OPTIONS,
  addableClassRoles,
  canManageClassCoaches,
  canManageClassSettings,
  canManageClassStudents,
  countClassMembers,
  describeClassError,
} from '../utils/classes';
import { formatDateTime } from '../utils/format';
import { canViewClassLearning, studentLearningPath } from '../utils/learning';
import '../styles/classes.css';

interface AddMemberFormValues {
  username: string;
  role: ClassRole;
}

interface ClassSettingsFormValues {
  name: string;
  allowContest: boolean;
}

export function ClassDetailPage() {
  const { message } = App.useApp();
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const classId = Number(params.id);
  const validClassId = Number.isInteger(classId) && classId > 0;
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addForm] = Form.useForm<AddMemberFormValues>();
  const [settingsForm] = Form.useForm<ClassSettingsFormValues>();

  const detailQuery = useQuery({
    queryKey: ['class', classId],
    queryFn: () => apiGet<ClassDetail>(`/api/classes/${classId}`),
    enabled: validClassId,
  });

  const invalidateClass = () => {
    void queryClient.invalidateQueries({ queryKey: ['class', classId] });
    void queryClient.invalidateQueries({ queryKey: ['classes'] });
  };

  const addMemberMutation = useMutation({
    mutationFn: (values: AddMemberFormValues) => {
      const username = values.username.trim();
      // 教练有独立接口（且权限更高）；学生/助教走成员接口。
      if (values.role === 'coach') {
        return apiPost<null>(`/api/classes/${classId}/coaches`, { username });
      }
      return apiPost<unknown>(`/api/classes/${classId}/members`, {
        username,
        role: values.role,
      });
    },
    onSuccess: (_data, values) => {
      message.success(values.role === 'coach' ? '教练已添加' : '成员已添加');
      setAddOpen(false);
      invalidateClass();
    },
    onError: (error) => {
      message.error(describeClassError(error, '添加成员失败'));
    },
  });

  const removeStudentMutation = useMutation({
    mutationFn: (userId: number) =>
      apiDelete<null>(`/api/classes/${classId}/members/${userId}`),
    onSuccess: () => {
      message.success('成员已移出班级');
      invalidateClass();
    },
    onError: (error) => {
      message.error(describeClassError(error, '移出成员失败'));
    },
  });

  const removeCoachMutation = useMutation({
    mutationFn: (userId: number) =>
      apiDelete<null>(`/api/classes/${classId}/coaches/${userId}`),
    onSuccess: () => {
      message.success('教练已移出班级');
      invalidateClass();
    },
    onError: (error) => {
      message.error(describeClassError(error, '移出教练失败'));
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: (values: ClassSettingsFormValues) => {
      const body: UpdateClassRequest = {
        name: values.name.trim(),
        allowContest: values.allowContest,
      };
      return apiPatch<null>(`/api/classes/${classId}`, body);
    },
    onSuccess: () => {
      message.success('班级设置已保存');
      setSettingsOpen(false);
      invalidateClass();
    },
    onError: (error) => {
      message.error(describeClassError(error, '保存班级设置失败'));
    },
  });

  const deleteClassMutation = useMutation({
    mutationFn: () => apiDelete<null>(`/api/classes/${classId}`),
    onSuccess: () => {
      message.success('班级已删除');
      queryClient.removeQueries({ queryKey: ['class', classId] });
      void queryClient.invalidateQueries({ queryKey: ['classes'] });
      navigate('/classes');
    },
    onError: (error) => {
      message.error(describeClassError(error, '删除班级失败'));
    },
  });

  const retry = () => void detailQuery.refetch();

  if (!validClassId) {
    return (
      <Result
        status="404"
        title="未找到班级"
        subTitle="班级编号无效。"
        extra={
          <Link to="/classes">
            <Button type="primary">返回班级列表</Button>
          </Link>
        }
      />
    );
  }

  if (detailQuery.isPending) {
    return <PageLoading tip="正在加载班级…" />;
  }

  if (detailQuery.isError) {
    const apiError = detailQuery.error instanceof ApiError ? detailQuery.error : null;
    if (apiError?.status === 404) {
      return (
        <Result
          status="404"
          title="未找到班级"
          subTitle="班级不存在或已被解散。"
          extra={
            <Link to="/classes">
              <Button type="primary">返回班级列表</Button>
            </Link>
          }
        />
      );
    }
    return <ErrorResult error={detailQuery.error} onRetry={retry} />;
  }

  const detail = detailQuery.data;
  if (!detail) {
    return <ErrorResult error={new Error('班级数据为空')} onRetry={retry} />;
  }

  const isAdmin = user?.role === 'admin';
  const viewerRole = detail.viewerRole;
  const permissionInput = {
    viewerRole,
    ownerId: detail.ownerId,
    currentUserId: user?.id,
    isAdmin,
  };
  const canManageStudents = canManageClassStudents(permissionInput);
  const canManageCoaches = canManageClassCoaches(permissionInput);
  const canManageSettings = canManageClassSettings(permissionInput);
  const canAddMembers = canManageStudents || canManageCoaches;
  const canViewLearning = canViewClassLearning({ viewerRole, isAdmin });
  const counts = detail.members ? countClassMembers(detail.members) : null;
  const owner = detail.members?.find((member) => member.userId === detail.ownerId) ?? null;
  const ownerLabel = owner?.username ?? `用户 #${detail.ownerId}`;
  const allowedRoles = addableClassRoles(canManageCoaches);
  const roleOptions = CLASS_MEMBER_ROLE_OPTIONS.filter((option) =>
    allowedRoles.includes(option.value),
  );

  const openSettings = () => {
    settingsForm.setFieldsValue({
      name: detail.name,
      allowContest: detail.allowContest,
    });
    setSettingsOpen(true);
  };

  const memberColumns: TableColumnsType<ClassMember> = [
    {
      title: '用户名',
      dataIndex: 'username',
      render: (value: string, row) => (
        <span className="class-member-name">
          {value}
          {row.userId === user?.id ? <Tag className="class-self-tag">我</Tag> : null}
          {row.userId === detail.ownerId ? <Tag color="geekblue">创建者</Tag> : null}
        </span>
      ),
    },
    {
      title: '姓名',
      dataIndex: 'realName',
      width: 140,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '班级',
      dataIndex: 'className',
      width: 150,
      render: (value: string | null) => value ?? <span className="muted">—</span>,
    },
    {
      title: '身份',
      dataIndex: 'role',
      width: 100,
      render: (value: ClassRole) => <ClassRoleTag role={value} />,
    },
    {
      title: '加入时间',
      dataIndex: 'joinedAt',
      width: 170,
      render: (value: number) => <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '学习',
      width: 80,
      render: (_value, row) =>
        canViewLearning || row.userId === user?.id ? (
          <Link to={studentLearningPath(row.userId, classId)}>
            <Button size="small" type="link">
              学习
            </Button>
          </Link>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  if (canManageStudents || canManageCoaches) {
    memberColumns.push({
      title: '操作',
      width: 110,
      render: (_value, row) => {
        if (row.userId === detail.ownerId || row.userId === user?.id) {
          return <span className="muted">—</span>;
        }
        const isCoach = row.role === 'coach';
        if (isCoach ? !canManageCoaches : !canManageStudents) {
          return <span className="muted">—</span>;
        }
        const removeMutation = isCoach ? removeCoachMutation : removeStudentMutation;
        return (
          <Popconfirm
            title={isCoach ? `移除教练 ${row.username}？` : `移出成员 ${row.username}？`}
            okText="移出"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => removeMutation.mutate(row.userId)}
          >
            <Button
              size="small"
              danger
              loading={removeMutation.isPending && removeMutation.variables === row.userId}
            >
              移出
            </Button>
          </Popconfirm>
        );
      },
    });
  }

  return (
    <div>
      <PageHead
        breadcrumb={[
          { label: '首页', to: '/contests' },
          { label: '班级', to: '/classes' },
          { label: detail.name },
        ]}
        title={detail.name}
        tags={
          <>
            {viewerRole ? <ClassRoleTag role={viewerRole} /> : <Tag>非成员</Tag>}
            <AllowContestTag allow={detail.allowContest} />
            {isAdmin ? <Tag color="red">管理员</Tag> : null}
          </>
        }
        subtitle="班级详情：教练可以查看学习统计与错题本，并添加/移出学生与助教；班级创建者或管理员可以添加/移除教练。"
        extra={
          <Space wrap>
            <Button icon={<ReloadOutlined />} loading={detailQuery.isFetching} onClick={retry}>
              刷新
            </Button>
            {canManageSettings ? (
              <Button icon={<SettingOutlined />} onClick={openSettings}>
                设置
              </Button>
            ) : null}
            {canAddMembers ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setAddOpen(true)}
              >
                添加成员
              </Button>
            ) : null}
          </Space>
        }
      />

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card className="oij-card" title="基本信息">
          <Descriptions
            className="class-detail-descriptions"
            size="small"
            column={{ xs: 1, sm: 2, lg: 3 }}
            items={[
              {
                key: 'id',
                label: '班级编号',
                children: <span className="mono">#{detail.id}</span>,
              },
              { key: 'owner', label: '创建者', children: ownerLabel },
              {
                key: 'createdAt',
                label: '创建时间',
                children: <span className="mono">{formatDateTime(detail.createdAt)}</span>,
              },
              {
                key: 'memberCount',
                label: '成员数',
                children: counts ? (
                  <span className="mono">{counts.memberCount}</span>
                ) : (
                  <span className="muted">仅成员可见</span>
                ),
              },
              {
                key: 'viewerRole',
                label: '我的身份',
                children: viewerRole ? (
                  <ClassRoleTag role={viewerRole} />
                ) : (
                  <span className="muted">非成员</span>
                ),
              },
              {
                key: 'allowContest',
                label: '是否允许参赛',
                children: <AllowContestTag allow={detail.allowContest} />,
              },
            ]}
          />
        </Card>

        {canViewLearning ? <ClassWorkbench classId={classId} /> : null}

        <Card
          className="oij-card"
          title={counts ? `成员（${counts.memberCount}）` : '成员'}
        >
          {detail.members ? (
            <Table<ClassMember>
              className="oij-table"
              rowKey="userId"
              size="small"
              columns={memberColumns}
              dataSource={detail.members}
              pagination={false}
              locale={{ emptyText: '班级还没有成员' }}
            />
          ) : (
            <Alert
              type="info"
              showIcon
              message="成员列表仅对班级成员与管理员可见。"
              description="你是该班级的访客，可以查看班级基础信息；如需加入，请联系教练或管理员添加你的用户名。"
            />
          )}
        </Card>
      </Space>

      <Modal
        title="添加成员"
        open={addOpen}
        onCancel={() => setAddOpen(false)}
        onOk={() => addForm.submit()}
        okText="添加"
        cancelText="取消"
        confirmLoading={addMemberMutation.isPending}
        afterClose={() => addForm.resetFields()}
        destroyOnHidden
      >
        <Form<AddMemberFormValues>
          form={addForm}
          layout="vertical"
          requiredMark={false}
          initialValues={{ role: 'member' }}
          onFinish={(values) => addMemberMutation.mutate(values)}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: '请输入要添加的用户名' }]}
          >
            <Input placeholder="输入已注册用户的用户名" maxLength={64} />
          </Form.Item>
          <Form.Item label="身份" name="role">
            <Select
              options={roleOptions}
              placeholder="选择成员身份"
            />
          </Form.Item>
          <div className="muted class-create-tip">
            用户必须已注册且状态正常；同一用户不能重复加入同一班级。学生加入已报名比赛的班级时会自动同步参赛资格。
            {canManageCoaches ? '' : '添加教练需要班级创建者或管理员权限。'}
          </div>
        </Form>
      </Modal>

      <Modal
        title="班级设置"
        open={settingsOpen}
        onCancel={() => setSettingsOpen(false)}
        onOk={() => settingsForm.submit()}
        okText="保存"
        cancelText="取消"
        confirmLoading={updateSettingsMutation.isPending}
        afterClose={() => settingsForm.resetFields()}
        destroyOnHidden
        footer={(_, { OkBtn, CancelBtn }) => (
          <div className="class-settings-footer">
            <Popconfirm
              title="删除班级？"
              description="将移除全部成员并撤销班级参赛资格，且无法恢复。"
              okText="删除"
              okButtonProps={{ danger: true }}
              cancelText="取消"
              onConfirm={() => deleteClassMutation.mutate()}
            >
              <Button
                danger
                icon={<DeleteOutlined />}
                loading={deleteClassMutation.isPending}
                disabled={updateSettingsMutation.isPending}
              >
                删除班级
              </Button>
            </Popconfirm>
            <Space>
              <CancelBtn />
              <OkBtn />
            </Space>
          </div>
        )}
      >
        <Form<ClassSettingsFormValues>
          form={settingsForm}
          layout="vertical"
          requiredMark={false}
          onFinish={(values) => updateSettingsMutation.mutate(values)}
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
            extra="关闭后不能再以该班级报名新的比赛；已报名的比赛不会被自动取消。"
          >
            <Switch />
          </Form.Item>
        </Form>
        <Alert
          type="warning"
          showIcon
          message="删除班级不可恢复"
          description="删除后会清理全部班级成员、班级报名记录以及由班级授予的参赛资格；管理员导入与自主报名不受影响。"
        />
      </Modal>
    </div>
  );
}
