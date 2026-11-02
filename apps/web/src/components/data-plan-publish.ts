import type {
  GateFinding,
  GateLevel,
  PublishGenerationResult,
  QualityGateReport,
} from '../api/types';

/** 从质控报告中挑出需要展示的条目；默认只取 block/warn，pass 一律忽略。 */
export function selectGateFindings(
  report: QualityGateReport | undefined,
  levels: readonly GateLevel[] = ['block', 'warn'],
): GateFinding[] {
  if (!report) return [];
  return report.findings.filter((finding) => levels.includes(finding.level));
}

/** 发布成功后的提示文案。 */
export function publishSuccessText(result: PublishGenerationResult): string {
  return `已发布 ${result.testcases} 个测试点、${result.subtasks} 个子任务`;
}

/** 发布失败时同时展示后端返回的 code 与 message。 */
export function publishErrorText(error: { code?: string; message: string }): string {
  return error.code ? `${error.code}：${error.message}` : error.message;
}
