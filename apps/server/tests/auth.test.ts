import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { registerAuthRoutes } from '../src/http/auth.js';
import { requireRole } from '../src/security/auth.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';
import { signSession, verifySession } from '../src/security/session.js';
import { openDatabase } from '../src/storage/db.js';
import { migrate } from '../src/storage/migrate.js';
import {
  createUser,
  getUserByUsername,
  type Role,
} from '../src/storage/repos/users.js';

const config: Config = {
  host: '127.0.0.1',
  port: 0,
  dataDir: join(tmpdir(), 'oij-auth-data'),
  judgeConcurrency: 1,
  gxx: 'g++',
  runnerPath: '',
  adminUsername: 'admin',
  adminPassword: 'admin123',
  sessionSecret: 'test-session-secret',
  sessionTtlSec: 3600,
};

let db: DatabaseSync;
let app: FastifyInstance;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'oij-auth-'));
  db = openDatabase(join(tmpDir, 'test.db'));
  migrate(db);
  app = Fastify();
  await registerAuthRoutes(app, { db, config });
  app.get(
    '/api/admin/ping',
    { preHandler: requireRole('admin', { db, config }) },
    async () => ({ ok: true, data: { admin: true } }),
  );
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedUser(
  username = 'alice',
  password = 'secret123',
  role: Role = 'contestant',
): number {
  return createUser(db, {
    username,
    passwordHash: hashPassword(password),
    realName: 'Alice',
    className: '1班',
    role,
  });
}

function cookieHeader(response: { headers: Record<string, unknown> }): string {
  const raw = response.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  expect(typeof header).toBe('string');
  return String(header).split(';')[0];
}

async function loginCookie(username = 'alice', password = 'secret123'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  expect(response.statusCode).toBe(200);
  return cookieHeader(response);
}

describe('password hashing', () => {
  it('stores scrypt metadata and verifies the password', () => {
    const stored = hashPassword('s3cret!');
    const parts = stored.split('$');

    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    expect(parts[1]).toBe('16384');
    expect(parts[2]).toBe('8');
    expect(parts[3]).toBe('1');
    expect(stored).not.toContain('s3cret!');
    expect(verifyPassword('s3cret!', stored)).toBe(true);
  });

  it('rejects wrong passwords, malformed hashes and unsupported params', () => {
    const stored = hashPassword('s3cret!');

    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword('s3cret!', 'not-a-hash')).toBe(false);
    expect(verifyPassword('s3cret!', 'scrypt$16384$8$1$onlyfive')).toBe(false);
    expect(verifyPassword('s3cret!', 'scrypt$999999$8$1$c2FsdA$aGFzaA')).toBe(false);
    expect(verifyPassword('s3cret!', 'bcrypt$16384$8$1$c2FsdA$aGFzaA')).toBe(false);
  });

  it('uses a fresh random salt for every hash', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });
});

describe('session tokens', () => {
  it('signs and verifies a session token', () => {
    const token = signSession({ userId: 7, version: 3 }, config.sessionSecret, 3600);
    expect(token).toContain('.');
    expect(verifySession(token, config.sessionSecret)).toEqual({ userId: 7, version: 3 });
  });

  it('rejects a token signed with another secret', () => {
    const token = signSession({ userId: 7, version: 3 }, config.sessionSecret, 3600);
    expect(verifySession(token, 'another-secret')).toBeNull();
  });

  it('rejects tampered payloads and tampered signatures', () => {
    const token = signSession({ userId: 7, version: 3 }, config.sessionSecret, 3600);
    const [encodedPayload, signature] = token.split('.');
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
      userId: number;
    };
    payload.userId = 8;
    const forgedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    expect(verifySession(`${forgedPayload}.${signature}`, config.sessionSecret)).toBeNull();

    // Flip a byte in the decoded signature. Changing the last base64url
    // character is not reliable: its low padding bits can decode to the same
    // bytes, making this test fail about 1/64 of the time.
    const forgedSignatureBytes = Buffer.from(signature, 'base64url');
    forgedSignatureBytes[0] ^= 0x01;
    const forgedSignature = forgedSignatureBytes.toString('base64url');
    expect(verifySession(`${encodedPayload}.${forgedSignature}`, config.sessionSecret)).toBeNull();
  });

  it('rejects expired tokens', () => {
    const token = signSession({ userId: 7, version: 3 }, config.sessionSecret, -1);
    expect(verifySession(token, config.sessionSecret)).toBeNull();
  });

  it('rejects malformed tokens', () => {
    expect(verifySession('', config.sessionSecret)).toBeNull();
    expect(verifySession('no-dot', config.sessionSecret)).toBeNull();
    expect(verifySession('a.', config.sessionSecret)).toBeNull();
  });
});

describe('POST /api/auth/login', () => {
  it('returns the user and an HttpOnly SameSite=Lax session cookie', async () => {
    seedUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: boolean;
      data: { user: { username: string; role: string; password_hash?: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.user.username).toBe('alice');
    expect(body.data.user.role).toBe('contestant');
    expect(body.data.user.password_hash).toBeUndefined();

    const raw = response.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : String(raw);
    expect(header).toMatch(/^oij\.sid=/);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=3600');
  });

  it('returns 401 for a wrong password', async () => {
    seedUser();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
    const body = response.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 401 for an unknown account', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'secret123' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for an inactive account', async () => {
    const userId = seedUser();
    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(userId);
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice', password: 'secret123' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 400 when credentials are missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'alice' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('INVALID_INPUT');
  });
});

describe('GET /api/me', () => {
  it('returns 401 without a session cookie', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
    const body = response.json() as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('returns the current user and permissions with a valid cookie', async () => {
    seedUser();
    const cookie = await loginCookie();
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: boolean;
      data: { user: { username: string }; permissions: string[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.user.username).toBe('alice');
    expect(body.data.permissions).toContain('judge.submit');
    expect(body.data.permissions).not.toContain('system.settings');
  });

  it('returns 401 for a tampered cookie', async () => {
    seedUser();
    const cookie = await loginCookie();
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `${cookie}tampered` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns 401 for an expired session token', async () => {
    const userId = seedUser();
    const token = signSession(
      { userId, version: 0 },
      config.sessionSecret,
      -1,
    );
    const response = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: `oij.sid=${token}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('clears the cookie and invalidates all older tokens', async () => {
    seedUser();
    const cookie = await loginCookie();

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
    expect(logoutResponse.statusCode).toBe(200);
    const logoutBody = logoutResponse.json() as { ok: boolean; data: { loggedOut: boolean } };
    expect(logoutBody.data.loggedOut).toBe(true);

    const raw = logoutResponse.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0] : String(raw);
    expect(header).toContain('Max-Age=0');

    expect(getUserByUsername(db, 'alice')?.session_version).toBe(1);

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(meResponse.statusCode).toBe(401);
  });

  it('returns 401 when called without a session', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/auth/logout' });
    expect(response.statusCode).toBe(401);
  });
});

describe('POST /api/auth/register', () => {
  it('creates a contestant and logs in automatically', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'new_student', password: 'password123' },
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as {
      ok: boolean;
      data: { user: { username: string; role: string }; permissions: string[] };
    };
    expect(body.data.user).toMatchObject({ username: 'new_student', role: 'contestant' });
    expect(body.data.permissions).toContain('judge.submit');

    const cookie = cookieHeader(response);
    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(meResponse.statusCode).toBe(200);
    const stored = getUserByUsername(db, 'new_student')!;
    expect(verifyPassword('password123', stored.password_hash)).toBe(true);
  });

  it('rejects duplicate usernames and invalid input', async () => {
    seedUser('taken', 'secret123');
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'taken', password: 'password123' },
    });
    expect(duplicate.statusCode).toBe(409);
    expect((duplicate.json() as { error: { code: string } }).error.code).toBe('USERNAME_TAKEN');

    const shortPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'validname', password: '123' },
    });
    expect(shortPassword.statusCode).toBe(400);

    const badName = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bad name!', password: 'password123' },
    });
    expect(badName.statusCode).toBe(400);
  });

  it('rate limits registrations per IP', async () => {
    const remoteAddress = '10.20.30.40';
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress,
        payload: { username: `rate_user_${i}`, password: 'password123' },
      });
      expect(response.statusCode, `attempt ${i}: ${response.body}`).toBe(201);
    }
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress,
      payload: { username: 'rate_user_5', password: 'password123' },
    });
    expect(blocked.statusCode).toBe(429);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe(
      'TOO_MANY_REGISTRATIONS',
    );
  });
});

describe('requireRole guard', () => {
  it('allows an admin and rejects a contestant', async () => {
    seedUser('admin1', 'secret123', 'admin');
    const adminCookie = await loginCookie('admin1', 'secret123');
    const adminResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/ping',
      headers: { cookie: adminCookie },
    });
    expect(adminResponse.statusCode).toBe(200);

    seedUser('student1', 'secret123', 'contestant');
    const studentCookie = await loginCookie('student1', 'secret123');
    const studentResponse = await app.inject({
      method: 'GET',
      url: '/api/admin/ping',
      headers: { cookie: studentCookie },
    });
    expect(studentResponse.statusCode).toBe(403);
    const body = studentResponse.json() as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns 401 without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/admin/ping' });
    expect(response.statusCode).toBe(401);
  });
});
