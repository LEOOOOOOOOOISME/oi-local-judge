import { ApiError } from '../api/client';
import type { ClassRole, StudentTagStat, WrongProblemMode } from '../api/types';

/** 与后端 `INACTIVE_DAYS` 保持一致：最近一次提交超过该天数视为未活跃。 */
export const INACTIVE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 解析 URL 中的班级编号；非法或缺失时返回 undefined（不加班级作用域）。 */
export function parseClassId(raw: string | null | undefined): number | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface StudentStatsPathOptions {
  classId?: number;
  includeContest: boolean;
}

/** `GET /api/students/:id/stats` 的请求路径。 */
export function studentStatsPath(userId: number, options: StudentStatsPathOptions): string {
  const params = new URLSearchParams({
    includeContest: String(options.includeContest),
  });
  if (options.classId !== undefined) params.set('classId', String(options.classId));
  return `/api/students/${userId}/stats?${params.toString()}`;
}

export interface StudentWrongProblemsPathOptions extends StudentStatsPathOptions {
  mode: WrongProblemMode;
}

/** `GET /api/students/:id/wrong-problems` 的请求路径。 */
export function studentWrongProblemsPath(
  userId: number,
  options: StudentWrongProblemsPathOptions,
): string {
  const params = new URLSearchParams({
    mode: options.mode,
    includeContest: String(options.includeContest),
  });
  if (options.classId !== undefined) params.set('classId', String(options.classId));
  return `/api/students/${userId}/wrong-problems?${params.toString()}`;
}

/** `GET /api/students/:id/submissions` 的请求路径（提交摘要，不含源码）。 */
export function studentSubmissionsPath(
  userId: number,
  options: { limit?: number; beforeId?: number } = {},
): string {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.beforeId !== undefined) params.set('beforeId', String(options.beforeId));
  const query = params.toString();
  return `/api/students/${userId}/submissions${query ? `?${query}` : ''}`;
}

/** 学生学习统计页路径；带班级编号时由后端校验“教练 + 本班学生”的可见性。 */
export function studentLearningPath(userId: number, classId?: number | null): string {
  return classId ? `/students/${userId}/learning?classId=${classId}` : `/students/${userId}/learning`;
}

/** 训练计划页路径（训练计划页面由训练计划模块提供，这里只负责带班级参数）。 */
export function trainingPlansPath(classId: number): string {
  return `/training-plans?classId=${classId}`;
}

/** 标签掌握度：已 AC 的题目数 / 该标签下练习过的题目数。 */
export function tagMasteryRate(tag: Pick<StudentTagStat, 'solved' | 'totalProblems'>): number {
  if (!Number.isFinite(tag.totalProblems) || tag.totalProblems <= 0) return 0;
  return clampRate(tag.solved / tag.totalProblems);
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}

/** 把 0~1 的比例格式化为百分比；非法值显示为 “—”。 */
export function formatPercent(rate: number, digits = 0): string {
  if (!Number.isFinite(rate)) return '—';
  return `${(clampRate(rate) * 100).toFixed(digits)}%`;
}

/** 距离最近一次提交的天数；从未提交返回 null。 */
export function inactiveDays(lastActiveAt: number | null, now = Date.now()): number | null {
  if (lastActiveAt === null || !Number.isFinite(lastActiveAt)) return null;
  return Math.max(0, Math.floor((now - lastActiveAt) / DAY_MS));
}

/** 未活跃成员的展示文案：从未提交 / 今天活跃 / N 天未提交。 */
export function describeInactive(lastActiveAt: number | null, now = Date.now()): string {
  const days = inactiveDays(lastActiveAt, now);
  if (days === null) return '从未提交';
  if (days <= 0) return '今天活跃';
  return `${days} 天未提交`;
}

export interface ClassLearningPermissionInput {
  viewerRole: ClassRole | null;
  isAdmin?: boolean;
}

/**
 * 是否可查看班级学习统计。
 *
 * 与后端 `canTeachGroup` 对齐：管理员与班级教练可读；助教、学生与访客不可读。
 */
export function canViewClassLearning(input: ClassLearningPermissionInput): boolean {
  if (input.isAdmin) return true;
  return input.viewerRole === 'coach';
}

/** 学生标签列表按掌握度升序（最薄弱在前），同掌握度按尝试次数降序。 */
export function sortTagsByMastery(tags: StudentTagStat[]): StudentTagStat[] {
  return [...tags].sort(
    (a, b) =>
      tagMasteryRate(a) - tagMasteryRate(b) ||
      b.attempts - a.attempts ||
      a.tag.localeCompare(b.tag),
  );
}

/** 把学习统计接口错误码翻译成可读文案；未知错误回退到服务端 message。 */
export function describeLearningError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'STUDENT_FORBIDDEN':
        return '只有学生本人、班级教练或管理员可以查看学习统计';
      case 'STUDENT_NOT_FOUND':
        return '学生不存在';
      case 'STUDENT_NOT_IN_CLASS':
        return '该学生不在当前班级中';
      case 'CLASS_FORBIDDEN':
        return '只有班级教练或管理员可以查看班级学习统计';
      case 'CLASS_NOT_FOUND':
        return '班级不存在或已被解散';
      case 'BAD_REQUEST':
        return '查询参数有误';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : fallback;
}
