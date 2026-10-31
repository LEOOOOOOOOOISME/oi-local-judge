// Stateless HMAC-SHA256 session tokens.
//
// Token format: base64url(JSON payload) + "." + base64url(HMAC-SHA256)
// Payload: { userId, version, exp } with exp in whole Unix seconds.
// The signing input is exactly the encoded payload segment, so verification
// never needs to re-serialize JSON.
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionPayload {
  userId: number;
  version: number;
  exp: number;
}

export type SessionIdentity = Pick<SessionPayload, 'userId' | 'version'>;

const MAX_TOKEN_LENGTH = 4096;

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function signSession(
  identity: SessionIdentity,
  secret: string,
  ttlSec: number,
): string {
  if (!Number.isInteger(identity.userId) || identity.userId <= 0) {
    throw new Error('signSession: userId must be a positive integer');
  }
  if (!Number.isInteger(identity.version) || identity.version < 0) {
    throw new Error('signSession: version must be a non-negative integer');
  }
  if (!Number.isFinite(ttlSec)) {
    throw new Error('signSession: ttlSec must be finite');
  }

  const payload: SessionPayload = {
    userId: identity.userId,
    version: identity.version,
    exp: Math.floor(Date.now() / 1000) + Math.floor(ttlSec),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, secret)}`;
}

export function verifySession(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): SessionIdentity | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  const separator = token.lastIndexOf('.');
  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }

  const encodedPayload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  const expectedSignature = sign(encodedPayload, secret);

  const provided = Buffer.from(providedSignature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }

  const payload = parsed as Partial<SessionPayload>;
  if (
    !Number.isInteger(payload.userId) ||
    (payload.userId as number) <= 0 ||
    !Number.isInteger(payload.version) ||
    (payload.version as number) < 0 ||
    !Number.isInteger(payload.exp)
  ) {
    return null;
  }

  const nowSec = Math.floor(nowMs / 1000);
  if (nowSec >= (payload.exp as number)) {
    return null;
  }

  return { userId: payload.userId as number, version: payload.version as number };
}
