import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tag,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import { apiPost } from '../api/client';
import type {
  ClassSummary,
  CreateTrainingPlanItemRequest,
  CreateTrainingPlanRequest,
  CreateTrainingPlanResult,
  TeamSummary,
} from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../utils/format';
import {
  describeTrainingPlanError,
  manageableGroups,
} from '../utils/trainingPlans';

interface CreateTrainingPlanFormValues {
  groupId: number;
  title: string;
  description?: string;
  startsAt?: Dayjs | null;
  endsAt?: Dayjs | null;
}

interface DraftTrainingPlanItem {
  problemId: number;
  targetScore?: number;
  dueAt: number | null;
}

/**
 * 创建训练计划弹窗。
 *
 * 组只能从 `/api/classes` 与 `/api/teams` 返回的“我可管理的班级/团队”中选择，
 * 与后端 `canManageGroup` 的权限口径保持一致。题目可以先留空，创建后在详情页补充。
 */
export function TrainingPlanCreateModal({
  open,
  onClose,
  classes,
  teams,
  groupsLoading = false,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  classes: ClassSummary[];
  teams: TeamSummary[];
  groupsLoading?: boolean;
  onCreated: (id: number) => void;
}) {
  const { message } = App.useApp();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CreateTrainingPlanFormValues>();
  const [items, setItems] = useState<DraftTrainingPlanItem[]>([]);
  const [draftProblemId, setDraftProblemId] = useState<number | null>(null);
  const [draftTargetScore, setDraftTargetScore] = useState<number | null>(null);
  const [draftDueAt, setDraftDueAt] = useState<Dayjs | null>(null);

  const groups = manageableGroups(classes, teams, {
    currentUserId: user?.id,
    isAdmin: user?.role === 'admin',
  });

  const resetDraft = () => {
    setItems([]);
    setDraftProblemId(null);
    setDraftTargetScore(null);
    setDraftDueAt(null);
  };

  const close = () => {
    form.resetFields();
    resetDraft();
    onClose();
  };

  const addItem = () => {
    if (draftProblemId === null || !Number.isInteger(draftProblemId) || draftProblemId <= 0) {
      message.warning('请输入有效的题目 ID');
      return;
    }
    if (items.some((item) => item.problemId === draftProblemId)) {
      message.warning('该题目已在计划中');
      return;
    }
    const nextItem: DraftTrainingPlanItem = {
      problemId: draftProblemId,
      dueAt: draftDueAt ? draftDueAt.valueOf() : null,
    };
    if (draftTargetScore !== null) nextItem.targetScore = draftTargetScore;
    setItems((prev) => [...prev, nextItem]);
    setDraftProblemId(null);
    setDraftTargetScore(null);
    setDraftDueAt(null);
  };

  const createMutation = useMutation({
    mutationFn: (values: CreateTrainingPlanFormValues) => {
      const payload: CreateTrainingPlanRequest = {
        groupId: values.groupId,
        title: values.title.trim(),
        description: values.description?.trim() ?? '',
        startsAt: values.startsAt ? values.startsAt.valueOf() : null,
        endsAt: values.endsAt ? values.endsAt.valueOf() : null,
        items: items.map((item) => {
          const requestItem: CreateTrainingPlanItemRequest = {
            problemId: item.problemId,
            dueAt: item.dueAt,
          };
          if (item.targetScore !== undefined) requestItem.targetScore = item.targetScore;
          return requestItem;
        }),
      };
      return apiPost<CreateTrainingPlanResult>('/api/training-plans', payload);
    },
    onSuccess: (data) => {
      message.success('训练计划已创建');
      void queryClient.invalidateQueries({ queryKey: ['training-plans'] });
      form.resetFields();
      resetDraft();
      onClose();
      onCreated(data.id);
    },
    onError: (error) => {
      message.error(describeTrainingPlanError(error, '创建训练计划失败'));
    },
  });

  const itemColumns: TableColumnsType<DraftTrainingPlanItem> = [
    {
      title: '序号',
      width: 60,
      render: (_value, _item, index) => <span className="mono">{index + 1}</span>,
    },
    {
      title: '题目 ID',
      dataIndex: 'problemId',
      width: 110,
      render: (value: number) => <span className="mono">#{value}</span>,
    },
    {
      title: '目标分',
      dataIndex: 'targetScore',
      width: 100,
      render: (value: number | undefined) =>
        value === undefined ? <span className="muted">默认满分</span> : <span className="mono">{value}</span>,
    },
    {
      title: '截止时间',
      dataIndex: 'dueAt',
      render: (value: number | null) =>
        value === null ? <span className="muted">无</span> : <span className="mono">{formatDateTime(value)}</span>,
    },
    {
      title: '操作',
      width: 76,
      render: (_value, item) => (
        <Button
          size="small"
          danger
          icon={<DeleteOutlined />}
          aria-label="移除题目"
          title="移除题目"
          onClick={() =>
            setItems((prev) => prev.filter((row) => row.problemId !== item.problemId))
          }
        />
      ),
    },
  ];

  return (
    <Modal
      title="创建训练计划"
      open={open}
      width={760}
      onCancel={close}
      onOk={() => form.submit()}
      okText="创建"
      cancelText="取消"
      confirmLoading={createMutation.isPending}
      okButtonProps={{ disabled: groups.length === 0 }}
      destroyOnHidden
    >
      <Form<CreateTrainingPlanFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        onFinish={(values) => createMutation.mutate(values)}
      >
        {groups.length === 0 && !groupsLoading ? (
          <Alert
            type="warning"
            showIcon
            message="暂无可管理的班级或团队"
            description="只有班级教练、团队队长、组创建者或管理员可以创建训练计划。请先加入并成为可管理成员。"
            style={{ marginBottom: 16 }}
          />
        ) : null}

        <Form.Item
          label="班级 / 团队"
          name="groupId"
          rules={[{ required: true, message: '请选择班级或团队' }]}
          extra="只列出你当前可以管理的班级与团队。"
        >
          <Select
            showSearch
            optionFilterProp="label"
            loading={groupsLoading}
            placeholder={groupsLoading ? '正在加载可管理的组…' : '选择班级或团队'}
            options={groups.map((group) => ({
              value: group.id,
              label: group.label,
            }))}
          />
        </Form.Item>

        <Form.Item
          label="标题"
          name="title"
          rules={[
            { required: true, message: '请输入训练计划标题' },
            {
              validator: (_rule, value: string | undefined) => {
                const length = Array.from((value ?? '').trim()).length;
                if (length < 1 || length > 200) {
                  return Promise.reject(new Error('标题长度为 1~200 个字符'));
                }
                return Promise.resolve();
              },
            },
          ]}
        >
          <Input placeholder="例如：寒假集训 · 图论专题" maxLength={200} />
        </Form.Item>

        <Form.Item label="描述" name="description">
          <Input.TextArea
            placeholder="可选，说明训练目标或安排"
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={1000}
          />
        </Form.Item>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item label="开始时间" name="startsAt">
              <DatePicker showTime allowClear style={{ width: '100%' }} placeholder="不限制" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="结束时间"
              name="endsAt"
              dependencies={['startsAt']}
              rules={[
                {
                  validator: (_rule, value: Dayjs | null | undefined) => {
                    const startsAt = form.getFieldValue('startsAt') as Dayjs | null | undefined;
                    if (value && startsAt && value.valueOf() < startsAt.valueOf()) {
                      return Promise.reject(new Error('结束时间不能早于开始时间'));
                    }
                    return Promise.resolve();
                  },
                },
              ]}
            >
              <DatePicker showTime allowClear style={{ width: '100%' }} placeholder="不限制" />
            </Form.Item>
          </Col>
        </Row>

        <div className="training-plan-create-section">
          <div className="training-plan-create-head">
            <span>题目（{items.length}）</span>
            <Tag>可选</Tag>
          </div>
          <Space wrap className="training-plan-items-toolbar">
            <InputNumber
              min={1}
              precision={0}
              placeholder="题目 ID"
              value={draftProblemId}
              onChange={(value) => setDraftProblemId(typeof value === 'number' ? value : null)}
              style={{ width: 120 }}
            />
            <InputNumber
              min={0}
              precision={0}
              placeholder="目标分（默认满分）"
              value={draftTargetScore}
              onChange={(value) => setDraftTargetScore(typeof value === 'number' ? value : null)}
              style={{ width: 170 }}
            />
            <DatePicker
              showTime
              placeholder="截止时间（可选）"
              value={draftDueAt}
              onChange={(value) => setDraftDueAt(value)}
              style={{ width: 200 }}
            />
            <Button icon={<PlusOutlined />} onClick={addItem} disabled={draftProblemId === null}>
              添加题目
            </Button>
          </Space>
          <Table<DraftTrainingPlanItem>
            className="oij-table"
            rowKey="problemId"
            size="small"
            columns={itemColumns}
            dataSource={items}
            pagination={false}
            locale={{ emptyText: '还没有添加题目，也可以创建后在详情页继续加题。' }}
          />
        </div>
      </Form>
    </Modal>
  );
}
