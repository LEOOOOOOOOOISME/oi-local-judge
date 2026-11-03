import { describe, expect, it } from 'vitest';
import {
  allowsSelfRegistration,
  registrationModeLabel,
  registrationStatusColor,
  registrationStatusLabel,
  resolveRegistrationMode,
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
