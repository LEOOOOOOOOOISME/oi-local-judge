import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig } from '../src/config.js';
import {
  SettingsValidationError,
  readPersistedSettings,
  settingsFilePath,
  settingsView,
  writePersistedSettings,
} from '../src/services/settings.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oij-settings-unit-'));
  ensureDataDirs(dir);
  return dir;
}

describe('writePersistedSettings / readPersistedSettings', () => {
  it('writes settings.json atomically and reads the values back', () => {
    const dir = makeDataDir();
    try {
      const saved = writePersistedSettings(dir, {
        host: '127.0.0.1',
        port: 8788,
        judgeConcurrency: 3,
        gxx: 'C:/mingw64/bin/g++.exe',
        sessionTtlSec: 3600,
      });
      expect(saved).toEqual({
        host: '127.0.0.1',
        port: 8788,
        judgeConcurrency: 3,
        gxx: 'C:/mingw64/bin/g++.exe',
        sessionTtlSec: 3600,
      });
      expect(existsSync(settingsFilePath(dir))).toBe(true);
      // The atomic write must not leave its temporary file behind.
      expect(existsSync(`${settingsFilePath(dir)}.tmp`)).toBe(false);
      expect(readPersistedSettings(dir)).toEqual(saved);
      expect(JSON.parse(readFileSync(settingsFilePath(dir), 'utf8'))).toEqual(saved);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges a partial patch with the stored settings', () => {
    const dir = makeDataDir();
    try {
      writePersistedSettings(dir, { host: '127.0.0.1', port: 8788 });
      const merged = writePersistedSettings(dir, { port: 8789, judgeConcurrency: 2 });
      expect(merged).toEqual({ host: '127.0.0.1', port: 8789, judgeConcurrency: 2 });
      expect(readPersistedSettings(dir)).toEqual(merged);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const invalidPatches: Array<[string, Record<string, unknown>]> = [
    ['host empty', { host: '' }],
    ['host too long', { host: 'h'.repeat(256) }],
    ['port zero', { port: 0 }],
    ['port too large', { port: 65536 }],
    ['port not an integer', { port: 87.5 }],
    ['port as string', { port: '8787' }],
    ['concurrency zero', { judgeConcurrency: 0 }],
    ['concurrency too large', { judgeConcurrency: 9 }],
    ['ttl too small', { sessionTtlSec: 299 }],
    ['ttl too large', { sessionTtlSec: 604_801 }],
    ['gxx empty', { gxx: '' }],
    ['gxx too long', { gxx: 'g'.repeat(1025) }],
    ['unknown key', { sessionSecret: 'leak' }],
    ['admin password key', { adminPassword: 'leak' }],
  ];
  it.each(invalidPatches)(
    'rejects an invalid patch: %s and keeps the file unchanged',
    (_label, patch) => {
      const dir = makeDataDir();
      try {
        writePersistedSettings(dir, { port: 8787 });
        const before = readFileSync(settingsFilePath(dir), 'utf8');
        expect(() =>
          writePersistedSettings(
            dir,
            patch as unknown as Parameters<typeof writePersistedSettings>[1],
          ),
        ).toThrow(SettingsValidationError);
        expect(readFileSync(settingsFilePath(dir), 'utf8')).toBe(before);
        expect(readPersistedSettings(dir)).toEqual({ port: 8787 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('ignores a malformed or partially invalid settings file instead of throwing', () => {
    const dir = makeDataDir();
    try {
      writeFileSync(settingsFilePath(dir), '{not json', 'utf8');
      expect(readPersistedSettings(dir)).toEqual({});
      // Defaults still apply when the file cannot be parsed.
      expect(loadConfig({ OIJ_DATA_DIR: dir }).port).toBe(8787);

      writeFileSync(
        settingsFilePath(dir),
        JSON.stringify({ port: 0, host: '127.0.0.1', sessionSecret: 'leak' }),
        'utf8',
      );
      expect(readPersistedSettings(dir)).toEqual({ host: '127.0.0.1' });
      const config = loadConfig({ OIJ_DATA_DIR: dir });
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(8787);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadConfig priority', () => {
  it('uses settings.json values when the matching env var is absent', () => {
    const dir = makeDataDir();
    try {
      writePersistedSettings(dir, {
        host: '127.0.0.1',
        port: 9000,
        judgeConcurrency: 2,
        gxx: 'C:/from-file/g++.exe',
        sessionTtlSec: 600,
      });
      const env = { OIJ_DATA_DIR: dir };
      const config = loadConfig(env);
      expect(config.host).toBe('127.0.0.1');
      expect(config.port).toBe(9000);
      expect(config.judgeConcurrency).toBe(2);
      expect(config.gxx).toBe('C:/from-file/g++.exe');
      expect(config.sessionTtlSec).toBe(600);

      const view = settingsView(config, dir, env);
      expect(view.effective).toEqual({
        host: '127.0.0.1',
        port: 9000,
        judgeConcurrency: 2,
        gxx: 'C:/from-file/g++.exe',
        sessionTtlSec: 600,
      });
      expect(view.persisted).toEqual({
        host: '127.0.0.1',
        port: 9000,
        judgeConcurrency: 2,
        gxx: 'C:/from-file/g++.exe',
        sessionTtlSec: 600,
      });
      // OIJ_DATA_DIR is not a persistable setting, so it is not an override.
      expect(view.envOverrides).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets explicit env vars win over settings.json and lists only those keys', () => {
    const dir = makeDataDir();
    try {
      writePersistedSettings(dir, {
        host: '127.0.0.1',
        port: 9000,
        judgeConcurrency: 2,
        gxx: 'C:/from-file/g++.exe',
        sessionTtlSec: 600,
      });
      const envGxx = join(dir, 'env-g++.exe');
      writeFileSync(envGxx, '');
      const env = {
        OIJ_DATA_DIR: dir,
        OIJ_HOST: '0.0.0.0',
        OIJ_PORT: '9100',
        OIJ_JUDGE_CONCURRENCY: '5',
        OIJ_GXX: envGxx,
        OIJ_SESSION_TTL: '1200',
      };
      const config = loadConfig(env);
      expect(config.host).toBe('0.0.0.0');
      expect(config.port).toBe(9100);
      expect(config.judgeConcurrency).toBe(5);
      expect(config.gxx).toBe(envGxx);
      expect(config.sessionTtlSec).toBe(1200);

      const view = settingsView(config, dir, env);
      expect(view.envOverrides).toEqual([
        'host',
        'port',
        'judgeConcurrency',
        'gxx',
        'sessionTtlSec',
      ]);
      // The persisted file is reported separately: it still holds the old values.
      expect(view.persisted.port).toBe(9000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a single env override win without disturbing the other persisted values', () => {
    const dir = makeDataDir();
    try {
      writePersistedSettings(dir, { host: '127.0.0.1', port: 9000, sessionTtlSec: 600 });
      const env = { OIJ_DATA_DIR: dir, OIJ_PORT: '9100' };
      const config = loadConfig(env);
      expect(config.port).toBe(9100);
      expect(config.host).toBe('127.0.0.1');
      expect(config.sessionTtlSec).toBe(600);
      expect(settingsView(config, dir, env).envOverrides).toEqual(['port']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('admin system settings routes', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'oij-settings-http-'));
  ensureDataDirs(dataDir);
  const db = openDatabase(join(dataDir, 'db', 'oijudge.db'));
  const config = loadConfig({ OIJ_DATA_DIR: dataDir, OIJ_SESSION_SECRET: 'test-session-secret-0123456789-abcdef' });
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie = '';

  beforeAll(async () => {
    migrate(db);
    const adminId = createUser(db, {
      username: 'admin',
      passwordHash: hashPassword('admin123'),
      role: 'admin',
    });
    cookie = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
    app = await buildApp({ db, config });
  });

  afterAll(async () => {
    await app.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('requires an admin session', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/admin/system/settings' });
    expect(get.statusCode).toBe(401);
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/system/settings',
      payload: { port: 8788 },
    });
    expect(put.statusCode).toBe(401);
    expect(existsSync(settingsFilePath(dataDir))).toBe(false);
  });

  it('GET returns the effective values, persisted values and env overrides', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/admin/system/settings',
      headers: { cookie },
    });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json().data as ReturnType<typeof settingsView>;
    expect(data.effective).toEqual({
      host: config.host,
      port: config.port,
      judgeConcurrency: config.judgeConcurrency,
      gxx: config.gxx,
      sessionTtlSec: config.sessionTtlSec,
    });
    expect(data.persisted).toEqual({});
    expect(Array.isArray(data.envOverrides)).toBe(true);
  });

  it('PUT persists a partial patch and reports restartRequired', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/admin/system/settings',
      headers: { cookie },
      payload: {
        host: '127.0.0.1',
        port: 8899,
        judgeConcurrency: 3,
        gxx: 'C:/tools/g++.exe',
        sessionTtlSec: 1200,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json().data as {
      settings: ReturnType<typeof settingsView>;
      restartRequired: boolean;
    };
    expect(data.restartRequired).toBe(true);
    expect(data.settings.persisted).toEqual({
      host: '127.0.0.1',
      port: 8899,
      judgeConcurrency: 3,
      gxx: 'C:/tools/g++.exe',
      sessionTtlSec: 1200,
    });
    // Nothing is applied to the running process: a restart is required.
    expect(data.settings.effective.port).toBe(config.port);
    expect(data.settings.effective.host).toBe(config.host);
    expect(readPersistedSettings(dataDir)).toEqual(data.settings.persisted);

    // A second partial PUT only touches the supplied fields.
    const partial = await app.inject({
      method: 'PUT',
      url: '/api/admin/system/settings',
      headers: { cookie },
      payload: { port: 8898 },
    });
    expect(partial.statusCode, partial.body).toBe(200);
    const partialSettings = (
      partial.json() as { data: { settings: ReturnType<typeof settingsView> } }
    ).data.settings;
    expect(partialSettings.persisted).toEqual({
      host: '127.0.0.1',
      port: 8898,
      judgeConcurrency: 3,
      gxx: 'C:/tools/g++.exe',
      sessionTtlSec: 1200,
    });

    // GET now round-trips the persisted values while effective stays stale.
    const read = await app.inject({
      method: 'GET',
      url: '/api/admin/system/settings',
      headers: { cookie },
    });
    expect(read.statusCode, read.body).toBe(200);
    const view = read.json().data as ReturnType<typeof settingsView>;
    expect(view.persisted).toEqual(partialSettings.persisted);
    expect(view.effective.port).toBe(config.port);
  });

  const invalidPayloads: Array<[string, Record<string, unknown>]> = [
    ['host empty', { host: '' }],
    ['host too long', { host: 'h'.repeat(256) }],
    ['port out of range', { port: 70000 }],
    ['concurrency out of range', { judgeConcurrency: 0 }],
    ['ttl out of range', { sessionTtlSec: 1 }],
    ['gxx empty', { gxx: '' }],
    ['unknown setting', { dataDir: 'C:/elsewhere' }],
    ['secret field', { sessionSecret: 'leak' }],
  ];
  it.each(invalidPayloads)(
    'rejects %s with 400 and keeps the stored settings',
    async (_label, payload) => {
      const before = readFileSync(settingsFilePath(dataDir), 'utf8');
      const response = await app.inject({
        method: 'PUT',
        url: '/api/admin/system/settings',
        headers: { cookie },
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      const error = response.json() as { ok: boolean; error: { code: string } };
      expect(error.ok).toBe(false);
      expect(error.error.code).toBe('BAD_REQUEST');
      expect(readFileSync(settingsFilePath(dataDir), 'utf8')).toBe(before);
    },
  );

  it('never exposes sessionSecret or adminPassword', async () => {
    const get = await app.inject({
      method: 'GET',
      url: '/api/admin/system/settings',
      headers: { cookie },
    });
    const put = await app.inject({
      method: 'PUT',
      url: '/api/admin/system/settings',
      headers: { cookie },
      payload: { port: 8897 },
    });
    for (const response of [get, put]) {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain('sessionSecret');
      expect(response.body).not.toContain('adminPassword');
      expect(response.body).not.toContain(config.sessionSecret);
      expect(response.body).not.toContain(config.adminPassword);
      const body = response.json() as {
        data: {
          effective?: Record<string, unknown>;
          settings?: { effective?: Record<string, unknown> };
        };
      };
      const effective = body.data.effective ?? body.data.settings?.effective;
      expect(effective).toBeDefined();
      expect(Object.keys(effective ?? {}).sort()).toEqual([
        'gxx',
        'host',
        'judgeConcurrency',
        'port',
        'sessionTtlSec',
      ]);
    }
  });
});
