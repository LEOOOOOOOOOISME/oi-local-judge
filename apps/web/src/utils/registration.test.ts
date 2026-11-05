import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import {
  allowsSelfRegistration,
  canCancelAcceptedRegistration,
  describeRegistrationError,
  registrationModeLabel,
  registrationStatusColor,
  registrationStatusLabel,
  registrationWindowState,
  registrationWindowText,
  resolveRegistrationMode,
  resolveRegistrationWindow,
} from './registration';

describe('resolveRegistrationMode', () => {
  it('defaults missing values to manual', () => {
    expect(resolveRegistrationMode(undefined)).toBe('manual');
    expect(resolveRegistrationMode(null)).toBe('manual');
    expect(resolveRegistrationMode({})).toBe('manual');
  });

  it('reads snake_case registration_mode returned by the API', () => {
    expect(resolveRegistrationMode({ registration_mode: 'manual' })).toBe('manual');
    expect(resolveRegistrationMode({ registration_mode: 'open' })).toBe('open');
    expect(resolveRegistrationMode({ registration_mode: 'approval' })).toBe('approval');
  });

  it('accepts camelCase registrationMode for mapped DTOs', () => {
    expect(resolveRegistrationMode({ registrationMode: 'open' })).toBe('open');
    expect(resolveRegistrationMode({ registrationMode: 'approval' })).toBe('approval');
  });

  it('falls back to manual for unknown or legacy values', () => {
    expect(resolveRegistrationMode({ registration_mode: 'closed' as never })).toBe('manual');
    expect(resolveRegistrationMode({ registrationMode: null })).toBe('manual');
  });
});

describe('registrationModeLabel', () => {
  it('labels every supported mode', () => {
    expect(registrationModeLabel('manual')).toBe('管理员导入');
    expect(registrationModeLabel('open')).toBe('自由报名');
    expect(registrationModeLabel('approval')).toBe('报名审核');
  });
});

describe('allowsSelfRegistration', () => {
  it('only manual contests hide self-registration', () => {
    expect(allowsSelfRegistration('manual')).toBe(false);
    expect(allowsSelfRegistration('open')).toBe(true);
    expect(allowsSelfRegistration('approval')).toBe(true);
  });
});

describe('registration status helpers', () => {
  it('labels and colors every status', () => {
    expect(registrationStatusLabel('pending')).toBe('待审核');
    expect(registrationStatusLabel('accepted')).toBe('已通过');
    expect(registrationStatusLabel('rejected')).toBe('已拒绝');
    expect(registrationStatusColor('pending')).toBe('gold');
    expect(registrationStatusColor('accepted')).toBe('green');
    expect(registrationStatusColor('rejected')).toBe('red');
  });
});

describe('resolveRegistrationWindow', () => {
  it('reads snake_case bounds and defaults to unrestricted', () => {
    expect(resolveRegistrationWindow(undefined)).toEqual({ openAt: null, closeAt: null });
    expect(resolveRegistrationWindow({})).toEqual({ openAt: null, closeAt: null });
    expect(
      resolveRegistrationWindow({ registration_open_at: 1000, registration_close_at: 2000 }),
    ).toEqual({ openAt: 1000, closeAt: 2000 });
  });

  it('accepts camelCase bounds for mapped DTOs', () => {
    expect(
      resolveRegistrationWindow({ registrationOpenAt: 1000, registrationCloseAt: 2000 }),
    ).toEqual({ openAt: 1000, closeAt: 2000 });
  });
});

describe('registrationWindowState', () => {
  it('is unrestricted when neither bound is set', () => {
    expect(registrationWindowState({}, 500)).toBe('unrestricted');
    expect(registrationWindowState({ registration_open_at: null }, 500)).toBe('unrestricted');
  });

  it('uses inclusive boundaries like the server', () => {
    const contest = { registration_open_at: 1000, registration_close_at: 2000 };
    expect(registrationWindowState(contest, 999)).toBe('before-open');
    expect(registrationWindowState(contest, 1000)).toBe('open');
    expect(registrationWindowState(contest, 2000)).toBe('open');
    expect(registrationWindowState(contest, 2001)).toBe('closed');
  });
});

describe('registrationWindowText', () => {
  it('shows an unrestricted label or the formatted range', () => {
    expect(registrationWindowText({})).toBe('不限制');
    expect(
      registrationWindowText({ registration_open_at: 1000, registration_close_at: 2000 }),
    ).toContain(' 至 ');
  });
});

describe('canCancelAcceptedRegistration', () => {
  it('allows cancellation before the start and blocks it afterwards', () => {
    const contest = { start_at: 5000, end_at: 9000, status: 'draft' };
    expect(canCancelAcceptedRegistration(contest, 4999)).toBe(true);
    expect(canCancelAcceptedRegistration(contest, 5000)).toBe(false);
  });

  it('blocks cancellation for running, ended and archived contests', () => {
    expect(canCancelAcceptedRegistration({ start_at: 5000, status: 'running' }, 1000)).toBe(false);
    expect(canCancelAcceptedRegistration({ start_at: 5000, status: 'ended' }, 1000)).toBe(false);
    expect(
      canCancelAcceptedRegistration({ start_at: 5000, status: 'draft', archived_at: 1 }, 1000),
    ).toBe(false);
  });

  it('allows cancellation when the start time is unknown', () => {
    expect(canCancelAcceptedRegistration({ start_at: null, status: 'draft' }, 1000)).toBe(true);
    expect(canCancelAcceptedRegistration(null, 1000)).toBe(false);
  });
});

describe('describeRegistrationError', () => {
  it('explains the registration window errors', () => {
    expect(describeRegistrationError(new ApiError(403, 'x', 'REGISTRATION_NOT_OPEN'))).toBe(
      '报名尚未开始',
    );
    expect(describeRegistrationError(new ApiError(403, 'x', 'REGISTRATION_CLOSED'))).toBe(
      '报名已截止',
    );
    expect(
      describeRegistrationError(new ApiError(400, 'x', 'INVALID_REGISTRATION_WINDOW')),
    ).toBe('报名开始时间必须早于截止时间');
  });
});
