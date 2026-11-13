import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { ensureAdmin } from '../src/services/bootstrap.js';
import {
  loadOrCreateSessionSecret,
  secretsFilePath,
} from '../src/services/secrets.js';
import { judgeChildEnv, judgeWorkRoot } from '../src/judge/isolation.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';
import { createUser, getUserByUsername } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('session secret bootstrapping', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function dir(): string {
    const created = tempDir('oij-secret-');
    dirs.push(created);
    return created;
  }

  it('generates a random secret once and reuses it on the next start', () => {
    const root = dir();
    const first = loadOrCreateSessionSecret(root, {});
    expect(first.secret).not.toBe('dev-only-change-me');
    expect(first.secret.length).toBeGreaterThanOrEqual(32);
    expect(first.source).toBe('generated');
    expect(existsSync(secretsFilePath(root))).toBe(true);

    const second = loadOrCreateSessionSecret(root, {});
    expect(second.secret).toBe(first.secret);
    expect(second.source).toBe('file');
  });

  it('replaces the legacy default secret and invalidates old tokens', () => {
    const root = dir();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      secretsFilePath(root),
      JSON.stringify({ sessionSecret: 'dev-only-change-me' }),
      'utf8',
    );
    const result = loadOrCreateSessionSecret(root, {});
    expect(result.secret).not.toBe('dev-only-change-me');
    expect(result.source).toBe('migrated');
    const persisted = JSON.parse(readFileSync(secretsFilePath(root), 'utf8')) as {
      sessionSecret: string;
    };
    expect(persisted.sessionSecret).toBe(result.secret);
    expect(loadOrCreateSessionSecret(root, {}).secret).toBe(result.secret);
  });

  it('rejects explicit environment secrets that are weak or legacy', () => {
    expect(() =>
      loadOrCreateSessionSecret(dir(), { OIJ_SESSION_SECRET: 'too-short' }),
    ).toThrow(/at least 32/);
    expect(() =>
      loadOrCreateSessionSecret(dir(), { OIJ_SESSION_SECRET: 'dev-only-change-me' }),
    ).toThrow(/at least 32|legacy/);
  });

  it('honours an explicit environment secret and does not persist it', () => {
    const root = dir();
    const result = loadOrCreateSessionSecret(root, {
      OIJ_SESSION_SECRET: 'explicit-secret-from-env-0123456789',
    });
    expect(result.secret).toBe('explicit-secret-from-env-0123456789');
    expect(result.source).toBe('env');
    expect(existsSync(secretsFilePath(root))).toBe(false);
  });

  it('loadConfig defaults to loopback, a random secret and no default admin password', () => {
    const root = dir();
    const config = loadConfig({ OIJ_DATA_DIR: root });
    expect(config.host).toBe('127.0.0.1');
    expect(config.sessionSecret).not.toBe('dev-only-change-me');
    expect(config.adminPassword).toBeUndefined();
  });

  it('loadConfig honours an explicit LAN host', () => {
    const root = dir();
    const config = loadConfig({ OIJ_DATA_DIR: root, OIJ_HOST: '0.0.0.0' });
    expect(config.host).toBe('0.0.0.0');
  });

  it('maps OIJ_LAN=1 to a LAN listener for the CLI as well as the desktop', () => {
    const root = dir();
    expect(loadConfig({ OIJ_DATA_DIR: root, OIJ_LAN: '1' }).host).toBe('0.0.0.0');
  });

  it('requires both TLS files and marks cookies Secure with TLS', () => {
    const root = dir();
    const cert = join(root, 'cert.pem');
    const key = join(root, 'key.pem');
    writeFileSync(cert, 'cert');
    writeFileSync(key, 'key');
    const config = loadConfig({
      OIJ_DATA_DIR: root,
      OIJ_TLS_CERT: cert,
      OIJ_TLS_KEY: key,
    });
    expect(config.tlsCertPath).toBe(cert);
    expect(config.secureCookies).toBe(true);
    expect(() =>
      loadConfig({ OIJ_DATA_DIR: root, OIJ_TLS_CERT: cert }),
    ).toThrow(/together/);
  });
});

describe('administrator bootstrap', () => {
  it('creates a random one-time admin password and requires a change', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const root = tempDir('oij-admin-');
    const config: Config = { ...loadConfig({ OIJ_DATA_DIR: root }), adminUsername: 'admin' };
    const created = ensureAdmin(db, config);
    expect(created).not.toBeNull();
    expect(created!.reason).toBe('created');
    expect(created!.username).toBe('admin');
    expect(created!.password).toBeTruthy();
    expect(created!.password!.length).toBeGreaterThanOrEqual(16);

    const row = getUserByUsername(db, 'admin')!;
    expect(row.must_change_password).toBe(1);
    expect(verifyPassword(created!.password!, row.password_hash)).toBe(true);

    // The one-time password is only emitted once.
    expect(ensureAdmin(db, config)).toBeNull();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('flags every legacy admin even when the configured bootstrap username differs', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const root = tempDir('oij-admin-legacy-other-');
    const config: Config = { ...loadConfig({ OIJ_DATA_DIR: root }), adminUsername: 'root' };
    createUser(db, {
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      role: 'admin',
    });
    const forced = ensureAdmin(db, config);
    expect(forced?.reason).toBe('legacy-default');
    expect(forced?.username).toBe('admin');
    const row = getUserByUsername(db, 'admin')!;
    expect(row.must_change_password).toBe(1);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('flags an existing admin that still uses the legacy default password', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const root = tempDir('oij-admin-legacy-');
    const config: Config = { ...loadConfig({ OIJ_DATA_DIR: root }), adminUsername: 'admin' };
    createUser(db, {
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      role: 'admin',
    });
    const before = getUserByUsername(db, 'admin')!;
    const forced = ensureAdmin(db, config);
    expect(forced?.reason).toBe('legacy-default');
    expect(forced?.password).toBeNull();
    const after = getUserByUsername(db, 'admin')!;
    expect(after.must_change_password).toBe(1);
    expect(after.session_version).toBe(before.session_version + 1);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('forced password change over HTTP', () => {
  const root = tempDir('oij-force-change-');
  const db: DatabaseSync = openDatabase(join(root, 'test.db'));
  let app: Awaited<ReturnType<typeof buildApp>>;
  let initialPassword = '';

  beforeAll(async () => {
    ensureDataDirs(root);
    migrate(db);
    const config: Config = { ...loadConfig({ OIJ_DATA_DIR: root }), adminUsername: 'admin' };
    const initial = ensureAdmin(db, config);
    initialPassword = initial!.password!;
    app = await buildApp({ db, config });
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('blocks protected APIs until the first password change and then allows them', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: initialPassword },
    });
    expect(login.statusCode).toBe(200);
    const loginBody = login.json() as {
      data: { mustChangePassword: boolean };
    };
    expect(loginBody.data.mustChangePassword).toBe(true);
    const cookie = String(login.headers['set-cookie']);

    const blocked = await app.inject({
      method: 'GET',
      url: '/api/admin/problems',
      headers: { cookie },
    });
    expect(blocked.statusCode).toBe(403);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe(
      'PASSWORD_CHANGE_REQUIRED',
    );

    const changed = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: initialPassword, newPassword: 'NewStrongPass-2026' },
    });
    expect(changed.statusCode).toBe(200);
    expect((changed.json() as { data: { mustChangePassword: boolean } }).data.mustChangePassword).toBe(
      false,
    );

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: initialPassword },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'NewStrongPass-2026' },
    });
    expect(newLogin.statusCode).toBe(200);
    expect((newLogin.json() as { data: { mustChangePassword: boolean } }).data.mustChangePassword).toBe(
      false,
    );
    const newCookie = String(newLogin.headers['set-cookie']);
    const allowed = await app.inject({
      method: 'GET',
      url: '/api/admin/problems',
      headers: { cookie: newCookie },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('rejects a weak or unchanged new password', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'NewStrongPass-2026' },
    });
    const cookie = String(login.headers['set-cookie']);
    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: { cookie },
      payload: { currentPassword: 'NewStrongPass-2026', newPassword: 'admin123' },
    });
    expect(weak.statusCode).toBe(400);
    expect((weak.json() as { error: { code: string } }).error.code).toBe('WEAK_PASSWORD');
  });
});

describe('judge isolation helpers', () => {
  it('strips service secrets and node options from contestant processes', () => {
    const env = judgeChildEnv({
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      OIJ_SESSION_SECRET: 'secret',
      OIJ_ADMIN_PASSWORD: 'password',
      OIJ_DATA_DIR: 'D:\\data',
      OIJ_RUNNER: 'runner.exe',
      OIJ_HOST: '0.0.0.0',
      NODE_OPTIONS: '--require evil.js',
    });
    expect(env.Path).toBe('C:\\Windows');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.OIJ_SESSION_SECRET).toBeUndefined();
    expect(env.OIJ_ADMIN_PASSWORD).toBeUndefined();
    expect(env.OIJ_DATA_DIR).toBeUndefined();
    expect(env.OIJ_RUNNER).toBeUndefined();
    expect(env.OIJ_HOST).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it('keeps judge work directories outside the data directory', () => {
    const dataDir = resolve(tmpdir(), 'oij-data-dir');
    const workRoot = resolve(judgeWorkRoot(dataDir));
    expect(workRoot === dataDir || workRoot.startsWith(`${dataDir}${sep}`)).toBe(false);
  });
});

describe('legacy database migration', () => {
  it('adds must_change_password to an old users table', () => {
    const db = openDatabase(':memory:');
    db.exec(
      `CREATE TABLE users(
         id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
         real_name TEXT, class_name TEXT, role TEXT NOT NULL DEFAULT 'contestant',
         status TEXT NOT NULL DEFAULT 'active', session_version INTEGER NOT NULL DEFAULT 0,
         created_at INTEGER NOT NULL
       )`,
    );
    db.prepare(
      "INSERT INTO users(username, password_hash, role, created_at) VALUES ('admin', 'x', 'admin', 1)",
    ).run();
    migrate(db);
    const columns = db.prepare('PRAGMA table_info(users)').all() as unknown as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const column = columns.find((entry) => entry.name === 'must_change_password');
    expect(column).toBeDefined();
    expect(column!.dflt_value).toBe('0');
    const row = db.prepare("SELECT must_change_password FROM users WHERE username='admin'").get() as {
      must_change_password: number;
    };
    expect(row.must_change_password).toBe(0);
    db.close();
  });
});
