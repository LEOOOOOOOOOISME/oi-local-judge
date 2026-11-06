import type { RegistrationMode, RegistrationStatus, TeamMode } from '../api/types';
import { ApiError } from '../api/client';
import { formatDateTime } from './format';

/** 报名方式在管理端/比赛页的展示文案。 */
export const REGISTRATION_MODE_LABEL: Record<RegistrationMode, string> = {
  manual: '管理员导入',
  open: '自由报名',
  approval: '报名审核',
};

export const REGISTRATION_MODE_OPTIONS: Array<{ value: RegistrationMode; label: string }> = [
  { value: 'manual', label: REGISTRATION_MODE_LABEL.manual },
  { value: 'open', label: REGISTRATION_MODE_LABEL.open },
  { value: 'approval', label: REGISTRATION_MODE_LABEL.approval },
];

interface RegistrationModeCarrier {
  registration_mode?: RegistrationMode | null;
  registrationMode?: RegistrationMode | null;
}

/**
 * 读取比赛的报名方式。
 *
 * 后端比赛列表/详情返回数据库行（snake_case `registration_mode`）；已做 DTO 映射的
 * 接口可能返回 camelCase `registrationMode`。旧后端与旧比赛没有该字段，按 manual 处理，
 * 保持“管理员导入”的旧行为。
 */
export function resolveRegistrationMode(
  contest: RegistrationModeCarrier | null | undefined,
): RegistrationMode {
  const mode = contest?.registration_mode ?? contest?.registrationMode;
  return mode === 'open' || mode === 'approval' ? mode : 'manual';
}

export function registrationModeLabel(mode: RegistrationMode | string | null | undefined): string {
  return REGISTRATION_MODE_LABEL[(mode as RegistrationMode) ?? 'manual'] ?? String(mode);
}

/** 该比赛是否允许选手自助报名（open / approval）。 */
export function allowsSelfRegistration(mode: RegistrationMode): boolean {
  return mode !== 'manual';
}

/**
 * 是否显示个人自助报名入口。
 *
 * `manual` 由管理员导入名单；纯团队赛（`team_mode = 'team'`）只能由队长完成
 * 团队报名，个人自助报名会被后端以 `TEAM_REGISTRATION_REQUIRED` 拒绝。
 * `both` 仍保留个人自助报名。
 */
export function allowsIndividualSelfRegistration(
  registrationMode: RegistrationMode,
  teamMode: TeamMode,
): boolean {
  return allowsSelfRegistration(registrationMode) && teamMode !== 'team';
}

/** 报名窗口状态：未配置 / 未开始 / 开放中 / 已截止。 */
export type RegistrationWindowState = 'unrestricted' | 'before-open' | 'open' | 'closed';

interface RegistrationWindowCarrier {
  registration_open_at?: number | null;
  registration_close_at?: number | null;
  registrationOpenAt?: number | null;
  registrationCloseAt?: number | null;
}

interface AcceptedCancelCarrier extends RegistrationWindowCarrier {
  start_at?: number | null;
  end_at?: number | null;
  status?: string;
  archived_at?: number | null;
}

export interface RegistrationWindow {
  openAt: number | null;
  closeAt: number | null;
}

/** 读取报名窗口（兼容 snake_case 数据库行与 camelCase DTO）；缺省即不限制。 */
export function resolveRegistrationWindow(
  contest: RegistrationWindowCarrier | null | undefined,
): RegistrationWindow {
  return {
    openAt: contest?.registration_open_at ?? contest?.registrationOpenAt ?? null,
    closeAt: contest?.registration_close_at ?? contest?.registrationCloseAt ?? null,
  };
}

/** 按当前时间判断报名窗口状态。时间边界与后端一致：now < open 未开始，now > close 已截止。 */
export function registrationWindowState(
  contest: RegistrationWindowCarrier | null | undefined,
  now: number,
): RegistrationWindowState {
  const { openAt, closeAt } = resolveRegistrationWindow(contest);
  if (openAt === null && closeAt === null) return 'unrestricted';
  if (openAt !== null && now < openAt) return 'before-open';
  if (closeAt !== null && now > closeAt) return 'closed';
  return 'open';
}

/** 报名窗口的展示文案；未配置时显示“不限制”。 */
export function registrationWindowText(
  contest: RegistrationWindowCarrier | null | undefined,
): string {
  const { openAt, closeAt } = resolveRegistrationWindow(contest);
  if (openAt === null && closeAt === null) return '不限制';
  return `${formatDateTime(openAt)} 至 ${formatDateTime(closeAt)}`;
}

/**
 * 已通过（accepted）的选手能否自助取消：仅在比赛开始前且未结束时可以。
 * 与后端 cancelRegistration 的判定保持一致。
 */
export function canCancelAcceptedRegistration(
  contest: AcceptedCancelCarrier | null | undefined,
  now: number,
): boolean {
  if (!contest) return false;
  const status = contest.status;
  if (status === 'running' || status === 'frozen' || status === 'ended' || status === 'archived') {
    return false;
  }
  if (contest.archived_at !== null && contest.archived_at !== undefined) return false;
  if (contest.start_at !== null && contest.start_at !== undefined && now >= contest.start_at) {
    return false;
  }
  if (contest.end_at !== null && contest.end_at !== undefined && now >= contest.end_at) {
    return false;
  }
  return true;
}

export const REGISTRATION_STATUS_LABEL: Record<RegistrationStatus, string> = {
  pending: '待审核',
  accepted: '已通过',
  rejected: '已拒绝',
};

export const REGISTRATION_STATUS_COLOR: Record<RegistrationStatus, string> = {
  pending: 'gold',
  accepted: 'green',
  rejected: 'red',
};

export function registrationStatusLabel(
  status: RegistrationStatus | string | null | undefined,
): string {
  return REGISTRATION_STATUS_LABEL[(status as RegistrationStatus) ?? 'pending'] ?? String(status);
}

export function registrationStatusColor(
  status: RegistrationStatus | string | null | undefined,
): string {
  return REGISTRATION_STATUS_COLOR[(status as RegistrationStatus) ?? 'pending'] ?? 'default';
}

/** 把报名/审核/签到接口的错误码翻译成可直接展示的提示。 */
export function describeRegistrationError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'REGISTRATION_DISABLED':
        return '本场比赛未开放自助报名';
      case 'TEAM_REGISTRATION_REQUIRED':
        return '本场比赛仅限团队报名，请由队长完成团队报名';
      case 'REGISTRATION_NOT_OPEN':
        return '报名尚未开始';
      case 'REGISTRATION_CLOSED':
        return '报名已截止';
      case 'INVALID_REGISTRATION_WINDOW':
        return '报名开始时间必须早于截止时间';
      case 'ALREADY_REGISTERED':
        return '你已报名本场比赛';
      case 'NOT_REGISTERED':
        return '该选手没有报名记录';
      case 'CANNOT_CANCEL':
        return '当前状态不能取消报名';
      case 'CONTEST_NOT_FOUND':
        return '比赛不存在';
      case 'NOT_PENDING':
        return '该报名已不是待审核状态，请刷新后重试';
      case 'NOT_ACCEPTED':
        return '只有已通过报名的选手才能签到';
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : '报名操作失败';
}
