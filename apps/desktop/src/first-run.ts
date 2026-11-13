/**
 * Pure presentation helper for the desktop first-run administrator dialog.
 *
 * Kept free of Electron imports so it can be unit tested with vitest.
 */
export interface InitialAdminNotice {
  username: string;
  /** Present only when this launch generated the password. */
  password: string | null;
  reason: 'created' | 'legacy-default';
}

export function formatInitialAdminNotice(notice: InitialAdminNotice): string {
  if (notice.reason === 'created' && notice.password) {
    return [
      '已生成管理员账号，请立即登录并修改密码。',
      '',
      `用户名：${notice.username}`,
      `初始密码：${notice.password}`,
      '',
      '该密码只会显示一次；首次登录后会强制修改密码。',
    ].join('\n');
  }
  return [
    `检测到管理员 ${notice.username} 仍在使用旧的默认密码。`,
    '',
    '默认密码不安全，首次登录后必须修改密码。',
  ].join('\n');
}

/**
 * F-07 defence in depth: even though the embedded server no longer prints the
 * bootstrap password, the desktop log captures server stdout. Redact anything
 * that looks like an initial-password line so desktop.log can never contain a
 * credential.
 */
export function redactInitialPassword(line: string): string {
  return line
    .replace(/(初始密码\s*[:：]\s*)(\S+)/g, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(
      /(initial\s+password\s*[:=]\s*)(\S+)/gi,
      (_match, prefix: string) => `${prefix}[REDACTED]`,
    );
}
