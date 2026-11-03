import type { RegistrationMode, RegistrationStatus } from '../api/types';
import { ApiError } from '../api/client';

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
      case 'REGISTRATION_CLOSED':
        return '报名已截止';
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
