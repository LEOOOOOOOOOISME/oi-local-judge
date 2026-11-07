import { describe, expect, it } from 'vitest';
import {
  formatInitialAdminNotice,
  type InitialAdminNotice,
} from '../apps/desktop/src/first-run.js';

describe('desktop first-run admin notice', () => {
  it('shows the generated username and one-time password for a new install', () => {
    const notice: InitialAdminNotice = {
      username: 'admin',
      password: 'R4ndom-OneTime-Pass',
      reason: 'created',
    };
    const text = formatInitialAdminNotice(notice);
    expect(text).toContain('admin');
    expect(text).toContain('R4ndom-OneTime-Pass');
    expect(text).toContain('只会显示一次');
    expect(text).toContain('修改密码');
  });

  it('explains that a legacy default password must be changed without exposing it again', () => {
    const text = formatInitialAdminNotice({
      username: 'admin',
      password: null,
      reason: 'legacy-default',
    });
    expect(text).toContain('admin');
    expect(text).toContain('默认密码');
    expect(text).toContain('必须修改');
    expect(text).not.toContain('admin123');
  });
});
