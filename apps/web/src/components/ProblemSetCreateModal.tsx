import { App, Form, Input, Modal, Radio, Select } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '../api/client';
import type {
  CreateProblemSetRequest,
  CreateProblemSetResult,
  ProblemSetVisibility,
  TeamSummary,
} from '../api/types';
import { captainTeams } from '../utils/teamContest';
import { PROBLEM_SET_VISIBILITY_LABEL, describeProblemSetError } from '../utils/problemSets';

interface CreateProblemSetFormValues {
  title: string;
  description?: string;
  ownerType: 'user' | 'team';
  teamId?: number;
  visibility: ProblemSetVisibility;
}

/**
 * 创建题单弹窗。
 *
 * 个人题单省略 ownerId（服务端默认取当前用户）；团队题单只能选择自己担任队长的团队，
 * 与后端 ACL 保持一致。fixedOwner 用于团队详情页固定归属。
 */
export function ProblemSetCreateModal({
  open,
  onClose,
  teams,
  fixedOwner,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  teams: TeamSummary[];
  fixedOwner?: { ownerId: number; name: string };
  onCreated: (id: number) => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CreateProblemSetFormValues>();
  const ownerType = Form.useWatch('ownerType', form) ?? (fixedOwner ? 'team' : 'user');
  const manageableTeams = captainTeams(teams);

  const createMutation = useMutation({
    mutationFn: (values: CreateProblemSetFormValues) => {
      // fixedOwner 模式下 ownerType 字段不渲染，不能依赖表单返回值。
      const ownerType = fixedOwner ? 'team' : values.ownerType;
      const payload: CreateProblemSetRequest = {
        title: values.title.trim(),
        description: values.description?.trim() ?? '',
        ownerType,
        visibility: values.visibility,
      };
      if (ownerType === 'team') {
        payload.ownerId = fixedOwner ? fixedOwner.ownerId : values.teamId;
      }
      return apiPost<CreateProblemSetResult>('/api/problem-sets', payload);
    },
    onSuccess: (data) => {
      message.success('题单已创建');
      void queryClient.invalidateQueries({ queryKey: ['problem-sets'] });
      form.resetFields();
      onClose();
      onCreated(data.id);
    },
    onError: (error) => {
      message.error(describeProblemSetError(error, '创建题单失败'));
    },
  });

  return (
    <Modal
      title={fixedOwner ? `创建团队题单 · ${fixedOwner.name}` : '创建题单'}
      open={open}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={() => form.submit()}
      okText="创建"
      cancelText="取消"
      confirmLoading={createMutation.isPending}
      destroyOnHidden
    >
      <Form<CreateProblemSetFormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          ownerType: fixedOwner ? 'team' : 'user',
          visibility: 'private',
        }}
        onFinish={(values) => createMutation.mutate(values)}
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
          <Input placeholder="例如：寒假集训 · 图论专题" maxLength={100} />
        </Form.Item>

        <Form.Item label="描述" name="description">
          <Input.TextArea
            placeholder="可选，简单说明题单用途或训练目标"
            autoSize={{ minRows: 2, maxRows: 4 }}
            maxLength={500}
          />
        </Form.Item>

        {fixedOwner ? null : (
          <Form.Item label="归属" name="ownerType">
            <Radio.Group
              options={[
                { value: 'user', label: '个人题单' },
                {
                  value: 'team',
                  label:
                    manageableTeams.length === 0
                      ? '团队题单（需担任队长）'
                      : '团队题单',
                  disabled: manageableTeams.length === 0,
                },
              ]}
            />
          </Form.Item>
        )}

        {!fixedOwner && ownerType === 'team' ? (
          <Form.Item
            label="团队"
            name="teamId"
            rules={[{ required: true, message: '请选择团队' }]}
          >
            <Select
              placeholder="选择你担任队长的团队"
              options={manageableTeams.map((team) => ({
                value: team.id,
                label: team.name,
              }))}
            />
          </Form.Item>
        ) : null}

        <Form.Item label="可见性" name="visibility">
          <Radio.Group
            options={[
              {
                value: 'private',
                label: `${PROBLEM_SET_VISIBILITY_LABEL.private}（仅所有者、成员与被分享者）`,
              },
              {
                value: 'public',
                label: `${PROBLEM_SET_VISIBILITY_LABEL.public}（所有登录用户可读）`,
              },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
