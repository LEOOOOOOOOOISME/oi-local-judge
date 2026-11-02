export type AuthoringHelpKey = 'std-generator' | 'data-plan' | 'ai-prompts';

export interface AuthoringHelpEntry {
  key: AuthoringHelpKey;
  title: string;
  /** 文档中必须出现的标题片段，测试用它确认路径没有指错。 */
  article: string;
  /** 相对仓库根目录的 Markdown 路径。 */
  path: string;
  summary: string;
  bullets: readonly string[];
}

export const AUTHORING_HELP: Record<AuthoringHelpKey, AuthoringHelpEntry> = {
  'std-generator': {
    key: 'std-generator',
    title: 'std / generator 契约',
    article: 'std / generator 契约',
    path: 'docs/help/authoring/std-generator-contract.md',
    summary: 'std 与 generator 的最小输入、testlib 参数、安全边界与常见错误。',
    bullets: [
      'generator 必须支持 --seed/--group/--index',
      '只使用 rnd，禁止 rand()/random_device/time()',
      'std 与 generator 都不读写文件、不联网',
    ],
  },
  'data-plan': {
    key: 'data-plan',
    title: '数据计划（Data Plan）',
    article: '数据计划',
    path: 'docs/help/authoring/data-plan.md',
    summary: '子任务、测试点数、seed、generator 参数、分值与依赖的配置方式。',
    bullets: [
      '所有子任务分值之和必须等于 100',
      '依赖必须无环',
      'args 按 argv 传递，不做 shell 拼接',
    ],
  },
  'ai-prompts': {
    key: 'ai-prompts',
    title: 'AI 提示词库',
    article: 'AI 提示词库',
    path: 'docs/help/authoring/ai-prompts.md',
    summary: '可复制的 std/generator/validator/checker 提示词；AI 代码必须人工审核。',
    bullets: [
      '只复制提示词，不默认调用外部 API',
      'AI 生成代码必须编译、试跑、审核',
      '不把学生代码或个人信息发给外部 AI',
    ],
  },
};

export function getAuthoringHelp(key: AuthoringHelpKey): AuthoringHelpEntry {
  return AUTHORING_HELP[key];
}
