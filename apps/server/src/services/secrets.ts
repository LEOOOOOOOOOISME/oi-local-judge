// Persistent per-install secrets.
//
// The session-signing secret must never be a hard-coded default: anyone who
// knows it can forge session cookies for any user. It is generated on first
// start (or migrated away from the old `dev-only-change-me` default), stored in
// `<dataDir>/secrets.json` and reused on later starts.
//
// The file is written atomically with mode 0600 and, on Windows, its ACL is
// narrowed to the current user (best effort: a locked-down data directory is
// already the primary protection).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** The old hard-coded secret; persisted values equal to it are migrated. */
export const LEGACY_SESSION_SECRET = 'dev-only-change-me';

const SECRETS_FILE_NAME = 'secrets.json';

export type SessionSecretSource = 'env' | 'file' | 'generated' | 'migrated';

export interface SessionSecretResult {
  secret: string;
  source: SessionSecretSource;
}

export function secretsFilePath(dataDir: string): string {
  return join(dataDir, SECRETS_FILE_NAME);
}

function readStoredSecret(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { sessionSecret?: unknown };
    return typeof parsed.sessionSecret === 'string' && parsed.sessionSecret.length > 0
      ? parsed.sessionSecret
      : null;
  } catch {
    return null;
  }
}

function isUsableSecret(secret: string | null): secret is string {
  return secret !== null && secret !== LEGACY_SESSION_SECRET && secret.length >= 32;
}

/** Narrows the Windows ACL of the secrets file to the current user (best effort). */
function tightenWindowsAcl(file: string): void {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME;
  if (!user) return;
  try {
    execFileSync(
      'icacls.exe',
      [file, '/inheritance:r', '/grant:r', `${user}:F`],
      { stdio: 'ignore', windowsHide: true },
    );
  } catch {
    // ACL hardening is best effort; the data directory itself is user-owned.
  }
}

function writeStoredSecret(dataDir: string, secret: string): void {
  const file = secretsFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ sessionSecret: secret }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tmp, file);
    chmodSync(file, 0o600);
    tightenWindowsAcl(file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Resolves the session secret for this install.
 *
 * Priority: explicit `OIJ_SESSION_SECRET` env > persisted secret > generated.
 * An env value equal to the legacy default is ignored so an old deployment
 * configuration cannot keep the well-known secret alive.
 */
export function loadOrCreateSessionSecret(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionSecretResult {
  const envSecret = env.OIJ_SESSION_SECRET;
  if (typeof envSecret === 'string') {
    if (!isUsableSecret(envSecret)) {
      throw new Error(
        'OIJ_SESSION_SECRET must be at least 32 characters and must not be the legacy default',
      );
    }
    return { secret: envSecret, source: 'env' };
  }

  const stored = readStoredSecret(secretsFilePath(dataDir));
  if (isUsableSecret(stored)) {
    return { secret: stored, source: 'file' };
  }

  const secret = randomBytes(32).toString('base64url');
  writeStoredSecret(dataDir, secret);
  return { secret, source: stored === null ? 'generated' : 'migrated' };
}
