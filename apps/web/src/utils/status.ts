import type { Contest, ProblemType, Role, SubmissionStatus, Verdict } from '../api/types';
import { formatDuration } from './format';

export type ContestPhase = 'upcoming' | 'running' | 'frozen' | 'ended';

export const CONTEST_PHASE_LABEL: Record<ContestPhase, string> = {
  upcoming: '未开始',
  running: '进行中',
  frozen: '已封榜',
  ended: '已结束',
};

/** 管理端直接展示数据库中的比赛状态。 */
export const ADMIN_CONTEST_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  running: '进行中',
  frozen: '已封榜',
  ended: '已结束',
};

export function contestStatusLabel(status: string): string {
  return ADMIN_CONTEST_STATUS_LABEL[status] ?? status;
}

/** 比赛阶段以起止时间为准；status 只用于封榜等人工状态。 */
export function contestPhase(
  contest: Pick<Contest, 'start_at' | 'end_at' | 'status'>,
  now: number,
): ContestPhase {
  if (contest.status === 'ended') return 'ended';
  if (contest.end_at !== null && now >= contest.end_at) return 'ended';
  if (contest.start_at !== null && now < contest.start_at) return 'upcoming';
  if (contest.status === 'frozen') return 'frozen';
  return 'running';
}

export function contestCountdownText(
  contest: Pick<Contest, 'start_at' | 'end_at' | 'status'>,
  now: number,
): string {
  const phase = contestPhase(contest, now);
  if (phase === 'ended') return '已结束';
  if (phase === 'upcoming') {
    return contest.start_at === null ? '开始时间待定' : `距开始 ${formatDuration(contest.start_at - now)}`;
  }
  if (contest.end_at === null) return phase === 'frozen' ? '已封榜' : '进行中';
  return `${phase === 'frozen' ? '已封榜 · ' : ''}距结束 ${formatDuration(contest.end_at - now)}`;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  AC: '通过',
  WA: '答案错误',
  TLE: '运行超时',
  MLE: '内存超限',
  RE: '运行错误',
  CE: '编译错误',
  OLE: '输出超限',
  PE: '格式错误',
  PC: '部分正确',
  SK: '跳过',
  SE: '系统错误',
  UKE: '未知错误',
};

export function verdictTitle(verdict: Verdict | null | undefined): string {
  return verdict ? `${verdict} · ${VERDICT_LABEL[verdict] ?? verdict}` : '暂无评测结果';
}

export const SUBMISSION_STATUS_LABEL: Record<SubmissionStatus, string> = {
  queued: '排队中',
  compiling: '编译中',
  running: '评测中',
  finished: '已评测',
  failed: '评测失败',
  canceled: '已取消',
};

export function isPendingStatus(status: SubmissionStatus | undefined): boolean {
  return status === 'queued' || status === 'compiling' || status === 'running';
}

export function languageLabel(language: string): string {
  if (language === 'cpp17') return 'C++17';
  if (language === 'c11') return 'C11';
  if (language === 'objective') return '客观题';
  return language.toUpperCase();
}

const DIFFICULTY_LABEL: Record<number, string> = {
  1: '入门',
  2: '普及-',
  3: '普及+/提高-',
  4: '提高+/省选-',
  5: '省选/NOI-',
  6: 'NOI/NOI+/CTSC',
};

export function difficultyLabel(difficulty: number | null | undefined): string {
  if (difficulty === null || difficulty === undefined || !Number.isFinite(difficulty)) return '—';
  return DIFFICULTY_LABEL[Math.min(6, Math.max(1, Math.round(difficulty)))] ?? '—';
}

export const PROBLEM_TYPE_LABEL: Record<ProblemType, string> = {
  standard: '传统题',
  'file-io': '文件 IO',
  interactive: '交互题',
  'output-only': '提交答案',
  objective: '客观题',
};

export function problemTypeLabel(type: ProblemType): string {
  return PROBLEM_TYPE_LABEL[type] ?? type;
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员',
  setter: '出题人',
  contestmanager: '比赛管理员',
  contestant: '选手',
};

export function contestModeLabel(mode: string): string {
  const normalized = mode.toUpperCase();
  return normalized === 'OI' || normalized === 'ACM' ? normalized : mode;
}

/** 比赛题号：A-Z，超过 26 题用 P27 形式。 */
export function problemLetter(index: number): string {
  if (!Number.isInteger(index) || index < 0) return '?';
  return index < 26 ? String.fromCharCode(65 + index) : `P${index + 1}`;
}
