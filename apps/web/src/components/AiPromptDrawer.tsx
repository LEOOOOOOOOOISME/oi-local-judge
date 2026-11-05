import { useState } from 'react';
import { App, Alert, Button, Drawer, Input, Select, Space } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import type { DataPlan, ProblemDetail } from '../api/types';

type PromptKind = 'std' | 'generator' | 'validator';

const KIND_OPTIONS: Array<{ value: PromptKind; label: string }> = [
  { value: 'std', label: '标准程序 std' },
  { value: 'generator', label: '数据生成器 generator' },
  { value: 'validator', label: '输入校验器 validator' },
];

export function buildAuthoringPrompt(
  kind: PromptKind,
  problem: ProblemDetail,
  plan: DataPlan | null,
): string {
  const planText = plan
    ? JSON.stringify(
        {
          limits: plan.limits,
          groups: plan.groups.map((group) => ({
            id: group.id,
            name: group.name,
            points: group.points,
            count: group.count,
            args: group.args,
            dependsOn: group.dependsOn,
          })),
        },
        null,
        2,
      )
    : '（尚未配置 Data Plan）';
  const samples = problem.samples
    .map(
      (sample, index) =>
        `样例 ${index + 1}\n输入：\n${sample.input}\n输出：\n${sample.output}`,
    )
    .join('\n\n');

  const role =
    kind === 'std'
      ? '你是一名 OI 出题人，请写一份标准程序（std）。'
      : kind === 'generator'
        ? '你是一名 OI 出题人，请写一份 testlib 数据生成器（generator）。'
        : '你是一名 OI 出题人，请写一份 testlib 输入校验器（validator）。';

  const contract =
    kind === 'generator'
      ? `必须满足：
- C++17，包含 testlib.h，调用 registerGen(argc, argv, 1)
- 支持 --seed=<int>、--group=<string>、--index=<int>
- 只使用 rnd，禁止 rand()/random_device/time()/chrono
- 只写 stdout，不写文件、不联网、不调用系统命令
- 同一 seed 必须产生完全相同的输出`
      : kind === 'std'
        ? `必须满足：
- C++17，从标准输入读、向标准输出写
- 不读写文件、不联网、不调用系统命令
- 不使用随机数、时间、未定义行为
- 使用 long long 或 __int128 防溢出
- 运行时间与内存尽量不超过限制的 50%`
        : `必须满足：
- C++17，包含 testlib.h，调用 registerValidation(argc, argv)
- 从标准输入读取数据并检查题面中的全部约束
- 失败时用 ensuref/quitf 给出可定位的错误信息
- 不写文件、不联网、不调用系统命令`;

  return `${role}

## 题目信息
标题：${problem.title}
题型：${problem.type}
时间限制：${problem.timeMs} ms
内存限制：${problem.memoryMb} MB
输入/输出模式：${problem.ioMode === 'file' ? `${problem.inputFile ?? 'input'} / ${problem.outputFile ?? 'output'} 文件` : '标准输入/标准输出'}

## 数据计划
${planText}

## 样例
${samples || '（题面暂无样例）'}

## 硬性契约
${contract}

## 输出格式
只输出一个 C++17 代码块，不要输出解释、测试代码或 Markdown 之外的文字。

## 自检清单
- [ ] 代码可以编译
- [ ] 样例通过
- [ ] 没有文件 IO / 网络 / system / popen
- [ ] 没有未定义行为
- [ ] 复杂度与限制匹配
- [ ] 已覆盖题面中的边界与子任务`;
}

export function AiPromptDrawer({
  problem,
  plan,
}: {
  problem: ProblemDetail;
  plan: DataPlan | null;
}) {
  const { message } = App.useApp();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<PromptKind>('generator');
  const prompt = buildAuthoringPrompt(kind, problem, plan);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      message.success('提示词已复制');
    } catch {
      message.error('复制失败，请手动选择文本');
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>AI 提示词</Button>
      <Drawer
        title="AI 提示词（仅复制，不调用外部 API）"
        open={open}
        onClose={() => setOpen(false)}
        width={760}
        destroyOnHidden
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Select<PromptKind>
            value={kind}
            onChange={setKind}
            options={KIND_OPTIONS}
            style={{ width: 260 }}
          />
          <Alert
            type="info"
            showIcon
            message="离线优先"
            description="这里只生成可复制的提示词。代码粘回资产编辑器后，必须编译、试跑、审核，不能自动发布。"
          />
          <Input.TextArea value={prompt} readOnly rows={20} className="mono" />
          <Button type="primary" icon={<CopyOutlined />} onClick={() => void copy()}>
            复制提示词
          </Button>
        </Space>
      </Drawer>
    </>
  );
}
