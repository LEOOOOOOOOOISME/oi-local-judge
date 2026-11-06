import { ApiError, defaultErrorMessage } from '../api/client';
import type {
  AdminProblemSummary,
  BatchJobStatus,
  ProblemOwnerType,
} from '../api/types';

/** 与后端 batch-zip.ts 的 MAX_BATCH_ZIP_BYTES 对齐（5 GiB）。 */
export const MAX_BATCH_ZIP_BYTES = 5 * 1024 ** 3;

/** 题目选择器来源：个人 / 团队 / 公共（系统题）。 */
export type BatchProblemScope = 'all' | 'personal' | 'team' | 'public';

export const BATCH_PROBLEM_SCOPE_OPTIONS: Array<{
  value: BatchProblemScope;
  label: string;
}> = [
  { value: 'all', label: '全部' },
  { value: 'personal', label: '个人' },
  { value: 'team', label: '团队' },
  { value: 'public', label: '公共' },
];

/** 题目归属映射到选择器来源：system → 公共。 */
export function problemScope(problem: {
  ownerType: ProblemOwnerType;
}): Exclude<BatchProblemScope, 'all'> {
  if (problem.ownerType === 'team') return 'team';
  if (problem.ownerType === 'user') return 'personal';
  return 'public';
}

export interface ProblemFilterOptions {
  scope?: BatchProblemScope;
  query?: string;
  limit?: number;
}

/**
 * 在管理端题目列表上做来源过滤 + 题号/标题/标签搜索。
 *
 * 后端 P1 还没有 `GET /api/admin/problems/picker?scope=`；`/api/admin/problems`
 * 返回 `ownerType/ownerId/visibility/tags`，因此由前端完成同样的过滤。
 */
export function filterProblems(
  problems: AdminProblemSummary[],
  options: ProblemFilterOptions = {},
): AdminProblemSummary[] {
  const scope = options.scope ?? 'all';
  const query = (options.query ?? '').trim().toLowerCase();
  const limit = options.limit === undefined ? 200 : Math.max(1, Math.floor(options.limit));
  const matched: AdminProblemSummary[] = [];
  for (const problem of problems) {
    if (scope !== 'all' && problemScope(problem) !== scope) continue;
    if (query) {
      const haystacks = [
        String(problem.id),
        `#${problem.id}`,
        problem.title ?? '',
        ...(problem.tags ?? []),
      ];
      if (!haystacks.some((value) => value.toLowerCase().includes(query))) continue;
    }
    matched.push(problem);
    if (matched.length >= limit) break;
  }
  return matched;
}

/** 数字文件夹名自动匹配题目内部 id；非数字或题目不存在时返回 null。 */
export function autoProblemId(folder: string, knownProblemIds: ReadonlySet<number>): number | null {
  const trimmed = folder.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const id = Number(trimmed);
  return Number.isSafeInteger(id) && knownProblemIds.has(id) ? id : null;
}

/**
 * 按选中题目顺序批量绑定：第 i 个文件夹 ← 第 i 道题。
 * 未覆盖的文件夹保留原有手动映射，多出的选择被忽略。
 */
export function applyOrderedMapping(
  folders: string[],
  orderedProblemIds: number[],
  current: Record<string, number | undefined> = {},
): Record<string, number | undefined> {
  const next: Record<string, number | undefined> = { ...current };
  const count = Math.min(folders.length, orderedProblemIds.length);
  for (let index = 0; index < count; index += 1) {
    next[folders[index]!] = orderedProblemIds[index]!;
  }
  return next;
}

export interface FolderMappingValidation {
  unmapped: string[];
  unknown: string[];
  /** 被多个文件夹映射到的题目 id；后端导入时会按学生-题目去重。 */
  duplicateProblems: number[];
  complete: boolean;
}

/** 校验每个题目文件夹都有映射，且映射到当前题目目录中存在的题目。 */
export function validateFolderMapping(
  folders: string[],
  problemMap: Record<string, number | undefined>,
  knownProblemIds: ReadonlySet<number>,
): FolderMappingValidation {
  const unmapped: string[] = [];
  const unknown: string[] = [];
  const counts = new Map<number, number>();
  for (const folder of folders) {
    const id = problemMap[folder];
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      unmapped.push(folder);
      continue;
    }
    if (!knownProblemIds.has(id)) {
      unknown.push(folder);
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const duplicateProblems = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((left, right) => left - right);
  return {
    unmapped,
    unknown,
    duplicateProblems,
    complete: unmapped.length === 0 && unknown.length === 0,
  };
}

export interface SubmissionEstimate {
  /** 预计提交数；映射不完整或存在重复题目时是上界，而非精确值。 */
  submissions: number;
  exact: boolean;
  /** 多个文件夹映射到同一题目的 id。 */
  collisions: number[];
}

/**
 * “学生 × 题目 = 提交数”预览。
 *
 * `validCount` 来自后端预览（结构有效的源码数，不要求映射）。当所有文件夹
 * 都映射到不同题目时它就是精确提交数；映射不完整或多个文件夹指向同一题时
 * 会因导入去重而偏小，只能作为上界。
 */
export function estimateSubmissions(input: {
  validCount: number;
  multiProblem: boolean;
  folders: string[];
  problemMap: Record<string, number | undefined>;
}): SubmissionEstimate {
  if (!input.multiProblem) {
    return { submissions: Math.max(0, input.validCount), exact: true, collisions: [] };
  }
  if (input.folders.length === 0) {
    return { submissions: 0, exact: true, collisions: [] };
  }
  const counts = new Map<number, number>();
  let mapped = 0;
  for (const folder of input.folders) {
    const id = input.problemMap[folder];
    if (typeof id !== 'number') continue;
    mapped += 1;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const collisions = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((left, right) => left - right);
  return {
    submissions: Math.max(0, input.validCount),
    exact: mapped === input.folders.length && collisions.length === 0,
    collisions,
  };
}

export interface TreeSampleRow {
  path: string;
  /** 0 为顶层。 */
  depth: number;
  name: string;
}

/** 把预览的 treeSample 转成带缩进层级的树行。 */
export function treeSampleRows(sample: string[], limit = 80): TreeSampleRow[] {
  const rows: TreeSampleRow[] = [];
  const seen = new Set<string>();
  for (const raw of sample) {
    const path = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    rows.push({ path, depth: parts.length - 1, name: parts[parts.length - 1]! });
    if (rows.length >= limit) break;
  }
  return rows;
}

export interface LevelExample {
  path: string;
  student: string;
  /** 单题目模式（problemLevel = 0）为 null。 */
  problemFolder: string | null;
}

/**
 * 从 treeSample 里挑一条路径，按当前层级展示“路径 → 学生（+ 题目文件夹）”。
 * 只选择比学生层级/题目层级都深的路径（源码文件位于目录层级之下）。
 */
export function levelExample(
  sample: string[],
  studentLevel: number,
  problemLevel: number,
): LevelExample | null {
  if (studentLevel < 1) return null;
  const maxLevel = Math.max(studentLevel, problemLevel);
  for (const raw of sample) {
    const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length <= maxLevel) continue;
    const student = parts[studentLevel - 1];
    if (!student) continue;
    return {
      path: parts.join('/'),
      student,
      problemFolder: problemLevel > 0 ? (parts[problemLevel - 1] ?? null) : null,
    };
  }
  return null;
}

/** 上传前校验（扩展名/空文件/5 GiB 上限）；通过时返回 null。 */
export function validateZipFile(file: { name: string; size: number }): string | null {
  if (!file.name.toLowerCase().endsWith('.zip')) return '请选择 .zip 文件';
  if (file.size === 0) return 'zip 文件为空';
  if (file.size > MAX_BATCH_ZIP_BYTES) return 'zip 超过 5 GB 限制';
  return null;
}

export function isBatchActive(status: string | null | undefined): boolean {
  return (
    status === 'importing' ||
    status === 'queued' ||
    status === 'judging' ||
    status === 'running'
  );
}

export function batchStatusLabel(status: BatchJobStatus | string): string {
  switch (status) {
    case 'importing':
      return '导入中';
    case 'queued':
      return '排队中';
    case 'judging':
      return '评测中';
    case 'running':
      return '评测中';
    case 'finished':
      return '已完成';
    case 'failed':
      return '失败';
    case 'canceled':
      return '已取消';
    default:
      return status || '未知';
  }
}

export function batchStatusColor(status: BatchJobStatus | string): string {
  switch (status) {
    case 'finished':
      return 'green';
    case 'failed':
      return 'red';
    case 'canceled':
      return 'orange';
    case 'importing':
      return 'blue';
    default:
      return 'geekblue';
  }
}

const BATCH_ERROR_MESSAGES: Record<string, string> = {
  BAD_ZIP: '无法解析 zip 文件',
  EMPTY_BODY: '上传内容为空',
  LENGTH_REQUIRED: '浏览器未能提供文件大小，请重试或更换浏览器',
  BATCH_ZIP_TOO_LARGE: 'zip 超过 5 GB 上限',
  BATCH_DISK_FULL: '服务器磁盘空间不足，无法保存上传文件',
  BATCH_ENTRY_LIMIT: 'zip 内条目数量超过上限',
  BATCH_FILE_TOO_LARGE: 'zip 内存在超过 512 MB 的单个文件',
  BATCH_UNCOMPRESSED_LIMIT: 'zip 解压后总大小超过上限',
  INCOMPLETE_UPLOAD: '上传未完成（连接中断或文件被截断）',
  UPLOAD_NOT_FOUND: '上传记录不存在或已过期，请重新上传',
  BAD_UPLOAD_ID: 'uploadId 无效，请重新上传',
  BATCH_ALREADY_RUNNING: '该上传已有未完成的批次，请等待完成或先取消',
  NOT_STANDALONE_BATCH: '比赛批次由比赛管理，不能在批量评测页取消',
  CANNOT_CANCEL: '批次已结束，无法取消',
  BAD_PROBLEM_MAP: '题目映射包含不存在的题目，请刷新题目列表后重试',
  PROBLEM_NOT_FOUND: '题目不存在或已被删除',
  BAD_REQUEST: '请求参数有误',
  NO_SOURCES: '没有识别到可提交的源码，请检查目录层级或题目映射',
  UNMAPPED_PROBLEM: '存在未映射的题目文件夹',
  UNMAPPED_PROBLEMS: '存在未映射的题目文件夹',
  BATCH_IMPORT_FAILED: '批量导入失败',
  BATCH_IMPORT_INTERRUPTED: '服务重启导致导入中断，请重新上传并运行',
  BATCH_CANCELED: '批量任务已取消',
};

export function describeBatchError(error: unknown): string {
  if (error instanceof ApiError) {
    const label = error.code ? BATCH_ERROR_MESSAGES[error.code] : undefined;
    if (label) {
      // 服务端只回 { code } 时 apiRequest 会填默认 HTTP 文案；此时只展示中文指引。
      const generic = error.message === defaultErrorMessage(error.status);
      return error.message && !generic && error.message !== label
        ? `${label}：${error.message}`
        : label;
    }
    return error.message || '批量评测请求失败';
  }
  if (error instanceof Error) return error.message || '批量评测请求失败';
  return '批量评测请求失败';
}
