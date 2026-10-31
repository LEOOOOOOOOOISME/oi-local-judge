// Password hashing for OiJudge.
//
// Storage format: `scrypt$N$r$p$salt$hash`
//  - salt / hash are base64url encoded
//  - N=16384, r=8, p=1, 64-byte key, 32-byte random salt (see design 8)
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SCRYPT_N = 16_384;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEY_BYTES = 64;
export const SCRYPT_SALT_BYTES = 32;
export const SCRYPT_PREFIX = 'scrypt';

const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

function maxmemFor(N: number, r: number): number {
  // scrypt needs roughly 128 * N * r bytes; leave headroom for the runtime.
  return Math.max(32 * 1024 * 1024, 128 * N * r * 2);
}

export function hashPassword(
  password: string,
  params: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params.N, params.r),
  });
  return [
    SCRYPT_PREFIX,
    params.N,
    params.r,
    params.p,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) {
    return false;
  }

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ||
    (N & (N - 1)) !== 0 ||
    N > MAX_N ||
    r < 1 ||
    r > MAX_R ||
    p < 1 ||
    p > MAX_P
  ) {
    return false;
  }

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'base64url');
    expected = Buffer.from(parts[5], 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }

  let actual: Buffer;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
