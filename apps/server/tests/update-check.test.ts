import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureDataDirs, loadConfig, type Config } from '../src/config.js';
import { hashPassword } from '../src/security/password.js';
import { signSession } from '../src/security/session.js';
import { listAuditLogs } from '../src/storage/repos/audit.js';
import { createUser } from '../src/storage/repos/users.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';
import { listBackups, type BackupEntry } from '../src/services/system-ops.js';
import {
  checkForUpdate,
  compareSemver,
  resetUpdateCheckCache,
  UPDATE_CHECK_CACHE_TTL_MS,
  UPDATE_CHECK_TIMEOUT_MS,
  type UpdateCheckResult,
  type UpdateFetch,
  type UpdateFetchResponse,
} from '../src/services/update-check.js';

const NOW = 1_700_000_000_000;
const ROOT_VERSION = (
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version;
const RELEASES_URL =
  'https://api.github.com/repos/LEOOOOOOOOOISME/oi-local-judge/releases?per_page=20';

function jsonResponse(body: unknown, status = 200): UpdateFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

interface FetchCall {
  url: string;
  init: { headers: Record<string, string>; signal: AbortSignal };
}

/** One GitHub release entry; never touches the network. */
function release(
  tagName: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    tag_name: tagName,
    html_url: `https://github.com/LEOOOOOOOOOISME/oi-local-judge/releases/tag/${tagName}`,
    published_at: '2026-01-02T03:04:05Z',
    body: '## 更新内容\n- 修复若干问题',
    draft: false,
    prerelease: tagName.includes('-'),
    ...extra,
  };
}

/** Fake GitHub release-list endpoint; never touches the network. */
function releasesFetch(
  releases: unknown = [release('v1.1.0-rc.7')],
): { fetch: UpdateFetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetch: UpdateFetch = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse(releases);
  };
  return { fetch, calls };
}

function expectSuccess(result: UpdateCheckResult): Extract<UpdateCheckResult, { latest: string }> {
  if ('error' in result) throw new Error(`期望检查成功，实际失败：${result.error}`);
  return result;
}

function expectFailure(result: UpdateCheckResult): Extract<UpdateCheckResult, { error: string }> {
  if (!('error' in result)) throw new Error('期望检查失败，实际成功');
  return result;
}

beforeEach(() => {
  resetUpdateCheckCache();
});

describe('compareSemver', () => {
  it('orders core versions numerically', () => {
    expect(compareSemver('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.1')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
    expect(compareSemver('v1.1.0', '1.1.0')).toBe(0);
  });

  it('applies prerelease precedence (including numeric identifiers)', () => {
    expect(compareSemver('1.1.0', '1.1.0-rc.7')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-rc.7', '1.1.0-rc.6')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-rc.10', '1.1.0-rc.2')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-rc.1', '1.1.0-beta.9')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0-alpha', '1.1.0-alpha.1')).toBeLessThan(0);
  });
});

describe('checkForUpdate', () => {
  it('requests the release list and reports an available update with release metadata', async () => {
    const fake = releasesFetch();
    const result = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        fetch: fake.fetch,
        now: NOW,
        env: {},
      }),
    );

    expect(result).toEqual({
      current: '1.1.0-rc.6',
      latest: '1.1.0-rc.7',
      tagName: 'v1.1.0-rc.7',
      isPrerelease: true,
      updateAvailable: true,
      url: 'https://github.com/LEOOOOOOOOOISME/oi-local-judge/releases/tag/v1.1.0-rc.7',
      publishedAt: Date.parse('2026-01-02T03:04:05Z'),
      notes: '## 更新内容\n- 修复若干问题',
      checkedAt: NOW,
    });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe(RELEASES_URL);
    expect(fake.calls[0].url).not.toContain('/releases/latest');
    expect(fake.calls[0].init.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
    });
    expect(fake.calls[0].init.headers['User-Agent']).toBeTruthy();
  });

  it('allows OIJ_UPDATE_REPO to override the repository', async () => {
    const fake = releasesFetch();
    await checkForUpdate({
      currentVersion: '1.0.0',
      fetch: fake.fetch,
      now: NOW,
      env: { OIJ_UPDATE_REPO: 'acme/forked-judge' },
    });
    expect(fake.calls[0].url).toBe(
      'https://api.github.com/repos/acme/forked-judge/releases?per_page=20',
    );
  });

  it('does not rely on the /releases/latest endpoint', async () => {
    const calls: string[] = [];
    const fetch: UpdateFetch = async (url) => {
      calls.push(url);
      // The old implementation used this endpoint; it must no longer be called.
      if (url.endsWith('/releases/latest')) {
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      return jsonResponse([release('v1.1.1')]);
    };

    const result = expectSuccess(
      await checkForUpdate({ currentVersion: '1.1.0', fetch, now: NOW, env: {} }),
    );

    expect(result.latest).toBe('1.1.1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('/releases/latest');
  });

  it('reports no update when the current version is equal or newer', async () => {
    const equal = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.1.0',
        fetch: releasesFetch([release('v1.1.0')]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(equal.updateAvailable).toBe(false);
    expect(equal.latest).toBe('1.1.0');
    expect(equal.isPrerelease).toBe(false);

    resetUpdateCheckCache();
    // A prerelease is older than the corresponding final release.
    const newer = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.1.0',
        fetch: releasesFetch([release('v1.1.0-rc.7')]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(newer.updateAvailable).toBe(false);
    expect(newer.latest).toBe('1.1.0-rc.7');
    expect(newer.isPrerelease).toBe(true);
  });

  it('detects a prerelease update when the current version is a prerelease', async () => {
    const result = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        fetch: releasesFetch([release('v1.1.0-rc.6'), release('v1.1.0-rc.7')]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toBe('1.1.0-rc.7');
    expect(result.tagName).toBe('v1.1.0-rc.7');
    expect(result.isPrerelease).toBe(true);
  });

  it('detects an update when only prereleases exist', async () => {
    const result = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.0.0',
        fetch: releasesFetch([release('v1.2.0-beta.1'), release('v1.1.0-rc.1')]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(result.updateAvailable).toBe(true);
    expect(result.latest).toBe('1.2.0-beta.1');
    expect(result.isPrerelease).toBe(true);
  });

  it('selects the highest semver across stable and prerelease tags', async () => {
    const result = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.0.0',
        fetch: releasesFetch([
          release('v1.1.0'),
          release('v1.2.0-beta.2'),
          release('v1.2.0-beta.10'),
          release('v1.3.0-rc.1'),
        ]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(result.latest).toBe('1.3.0-rc.1');
    expect(result.isPrerelease).toBe(true);

    resetUpdateCheckCache();
    // A final release outranks prereleases with the same core version.
    const stable = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.0.0',
        fetch: releasesFetch([
          release('v1.1.0-rc.7'),
          release('v1.1.0'),
          release('v1.1.0-rc.10'),
        ]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(stable.latest).toBe('1.1.0');
    expect(stable.isPrerelease).toBe(false);
  });

  it('excludes draft releases', async () => {
    const result = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.0.0',
        fetch: releasesFetch([
          release('v9.9.9', { draft: true }),
          release('v1.2.0'),
          release('v1.1.0'),
        ]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(result.latest).toBe('1.2.0');
    expect(result.tagName).toBe('v1.2.0');
  });

  it('can restrict the check to final releases with OIJ_UPDATE_INCLUDE_PRERELEASE=0', async () => {
    const withPrerelease = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.1.0',
        fetch: releasesFetch([release('v1.2.0-rc.1'), release('v1.1.0')]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(withPrerelease.latest).toBe('1.2.0-rc.1');
    expect(withPrerelease.updateAvailable).toBe(true);

    resetUpdateCheckCache();
    const stableOnly = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.1.0',
        fetch: releasesFetch([release('v1.2.0-rc.1'), release('v1.1.0')]).fetch,
        now: NOW,
        env: { OIJ_UPDATE_INCLUDE_PRERELEASE: '0' },
      }),
    );
    expect(stableOnly.latest).toBe('1.1.0');
    expect(stableOnly.isPrerelease).toBe(false);
    expect(stableOnly.updateAvailable).toBe(false);

    resetUpdateCheckCache();
    // `false` is accepted as well, and GitHub's prerelease flag is honoured
    // even when the tag looks like a final release.
    const flagged = expectSuccess(
      await checkForUpdate({
        currentVersion: '1.1.0',
        fetch: releasesFetch([
          release('v1.2.0', { prerelease: true }),
          release('v1.1.1'),
        ]).fetch,
        now: NOW,
        env: { OIJ_UPDATE_INCLUDE_PRERELEASE: 'false' },
      }),
    );
    expect(flagged.latest).toBe('1.1.1');
    expect(flagged.updateAvailable).toBe(true);
  });

  it('returns a structured error when the network request fails', async () => {
    const result = expectFailure(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        fetch: async () => {
          throw new Error('network down');
        },
        now: NOW,
        env: {},
      }),
    );
    expect(result.error).toContain('network down');
    expect(result.current).toBe('1.1.0-rc.6');
    expect(result.checkedAt).toBe(NOW);
  });

  it('returns a structured timeout error instead of hanging', async () => {
    const result = expectFailure(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        // Never resolves and ignores the abort signal: the timeout must still win.
        fetch: () => new Promise<UpdateFetchResponse>(() => {}),
        timeoutMs: 20,
        now: NOW,
        env: {},
      }),
    );
    expect(result.error).toContain('超时');
    expect(UPDATE_CHECK_TIMEOUT_MS).toBe(5_000);
  });

  it('returns a structured error for a non-2xx GitHub response', async () => {
    const result = expectFailure(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        fetch: async () => jsonResponse({ message: 'Not Found' }, 404),
        now: NOW,
        env: {},
      }),
    );
    expect(result.error).toContain('404');
  });

  it('returns a structured error for an invalid payload', async () => {
    const notAList = expectFailure(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        fetch: async () => jsonResponse({ message: 'no tag' }),
        now: NOW,
        env: {},
      }),
    );
    expect(notAList.error).toContain('格式');

    const badTag = expectFailure(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        fetch: releasesFetch([release('not-a-version')]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(badTag.error).toContain('无法解析');

    const draftsOnly = expectFailure(
      await checkForUpdate({
        currentVersion: '1.1.0-rc.6',
        fetch: releasesFetch([release('v9.9.9', { draft: true })]).fetch,
        now: NOW,
        env: {},
      }),
    );
    expect(draftsOnly.error).toContain('无法解析');
  });

  it('caches a successful result for one hour', async () => {
    const fake = releasesFetch();
    const options = {
      currentVersion: '1.1.0-rc.6',
      fetch: fake.fetch,
      env: {},
    } as const;

    await checkForUpdate({ ...options, now: NOW });
    const cached = expectSuccess(
      await checkForUpdate({ ...options, now: NOW + UPDATE_CHECK_CACHE_TTL_MS - 1 }),
    );
    expect(cached.checkedAt).toBe(NOW);
    expect(fake.calls).toHaveLength(1);

    await checkForUpdate({ ...options, now: NOW + UPDATE_CHECK_CACHE_TTL_MS });
    expect(fake.calls).toHaveLength(2);
  });

  it('does not cache failures', async () => {
    let calls = 0;
    const fetch: UpdateFetch = async () => {
      calls += 1;
      throw new Error('offline');
    };
    await checkForUpdate({ currentVersion: '1.0.0', fetch, now: NOW, env: {} });
    await checkForUpdate({ currentVersion: '1.0.0', fetch, now: NOW + 1, env: {} });
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'oij-update-check-http-'));
ensureDataDirs(root);
const db = openDatabase(join(root, 'db', 'oijudge.db'));
const config: Config = {
  ...loadConfig({
    ...process.env,
    OIJ_DATA_DIR: root,
    OIJ_SESSION_SECRET: 'test-secret',
    OIJ_UPDATE_REPO: '',
  }),
  dataDir: root,
};
const cookies: Record<'admin' | 'student', string> = { admin: '', student: '' };
let adminId = 0;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  migrate(db);
  adminId = createUser(db, {
    username: 'admin',
    passwordHash: hashPassword('admin123'),
    role: 'admin',
  });
  const studentId = createUser(db, {
    username: 'student',
    passwordHash: hashPassword('student123'),
    role: 'contestant',
  });
  cookies.admin = `oij.sid=${signSession({ userId: adminId, version: 0 }, config.sessionSecret, 3600)}`;
  cookies.student = `oij.sid=${signSession({ userId: studentId, version: 0 }, config.sessionSecret, 3600)}`;
  app = await buildApp({ db, config });
});

afterAll(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function getUpdateCheck(cookie?: string) {
  return app.inject({
    method: 'GET',
    url: '/api/admin/system/update-check',
    headers: cookie ? { cookie } : {},
  });
}

async function prepareUpgrade(cookie?: string) {
  return app.inject({
    method: 'POST',
    url: '/api/admin/system/update/prepare',
    headers: cookie ? { cookie } : {},
  });
}

describe('GET /api/admin/system/update-check', () => {
  it('requires an admin session', async () => {
    const anonymous = await getUpdateCheck();
    expect(anonymous.statusCode).toBe(401);

    const student = await getUpdateCheck(cookies.student);
    expect(student.statusCode).toBe(403);
  });

  it('returns the update result for admins without hitting the real GitHub API', async () => {
    resetUpdateCheckCache();
    vi.stubGlobal('fetch', async () =>
      jsonResponse([
        release('v1.1.0-rc.999', { html_url: 'https://example.test/release' }),
        release('v1.1.0-rc.6'),
      ]),
    );

    const response = await getUpdateCheck(cookies.admin);
    expect(response.statusCode, response.body).toBe(200);
    const result = (response.json() as { data: UpdateCheckResult }).data;
    expect(result).toMatchObject({
      current: ROOT_VERSION,
      latest: '1.1.0-rc.999',
      tagName: 'v1.1.0-rc.999',
      isPrerelease: true,
      updateAvailable: true,
      url: 'https://example.test/release',
      notes: '## 更新内容\n- 修复若干问题',
    });
  });

  it('returns 200 with a structured error when GitHub is unreachable', async () => {
    resetUpdateCheckCache();
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });

    const response = await getUpdateCheck(cookies.admin);
    expect(response.statusCode, response.body).toBe(200);
    const result = (response.json() as { data: UpdateCheckResult }).data;
    expect('error' in result && result.error).toContain('offline');
  });
});

describe('POST /api/admin/system/update/prepare', () => {
  it('requires an admin session', async () => {
    const anonymous = await prepareUpgrade();
    expect(anonymous.statusCode).toBe(401);

    const student = await prepareUpgrade(cookies.student);
    expect(student.statusCode, student.body).toBe(403);

    expect(listBackups(config)).toHaveLength(0);
  });

  it('creates a pre-upgrade backup and records an audit entry', async () => {
    const response = await prepareUpgrade(cookies.admin);
    expect(response.statusCode, response.body).toBe(201);

    const data = (
      response.json() as {
        data: { backup: BackupEntry; currentVersion: string };
      }
    ).data;
    expect(data.currentVersion).toBe(ROOT_VERSION);
    expect(data.backup.kind).toBe('pre-upgrade');
    expect(data.backup.manifest.kind).toBe('pre-upgrade');
    expect(existsSync(join(data.backup.path, 'manifest.json'))).toBe(true);
    expect(existsSync(join(data.backup.path, 'db', 'oijudge.db'))).toBe(true);

    // The backup is listed with its kind preserved.
    const listed = listBackups(config).find((entry) => entry.id === data.backup.id);
    expect(listed?.kind).toBe('pre-upgrade');

    const audit = listAuditLogs(db).find((row) => row.action === 'update.prepare');
    expect(audit).toBeDefined();
    expect(audit?.actor_id).toBe(adminId);
    expect(JSON.parse(audit!.detail_json)).toMatchObject({
      backupId: data.backup.id,
      currentVersion: ROOT_VERSION,
    });
  });
});
