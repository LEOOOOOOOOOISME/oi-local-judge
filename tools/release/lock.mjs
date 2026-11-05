/**
 * Single-writer build lock.
 *
 * A release build writes a JSON file with the owning PID. Concurrent
 * invocations are refused while that PID is alive; a lock left behind by a
 * crashed build (dead PID, or unreadable content older than the grace period)
 * is removed automatically.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Returns true when the PID exists and can be signalled. `EPERM` means the
 * process exists but belongs to another user, which still counts as alive.
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function readLockFile(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    if (typeof parsed.token !== 'string' || parsed.token === '') return null;
    return parsed;
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath, now) {
  try {
    return now - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Acquires the build lock with exclusive creation (`wx`).
 *
 * @returns {{ path: string, pid: number, token: string, release: () => boolean }}
 */
export function acquireBuildLock(
  lockPath,
  {
    pid = process.pid,
    token = randomUUID(),
    isAlive = isProcessAlive,
    now = Date.now(),
    staleGraceMs = 60_000,
    label = 'release build',
    log = () => {},
  } = {},
) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const payload = {
    pid,
    token,
    startedAt: new Date(now).toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(lockPath, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
      let released = false;
      return {
        path: lockPath,
        pid,
        token,
        release() {
          if (released) return false;
          released = true;
          return releaseBuildLock(lockPath, token);
        },
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }

    const owner = readLockFile(lockPath);
    if (owner && isAlive(owner.pid)) {
      throw new Error(
        `${label} is already running (pid ${owner.pid}, lock ${lockPath}). ` +
          'Wait for it to finish, or remove the lock after confirming that PID is dead.',
      );
    }

    if (!owner) {
      // A partially written or hand-edited lock is only treated as stale after
      // a grace period, so a lock that is being created right now is not stolen.
      const age = lockAgeMs(lockPath, now);
      if (age < staleGraceMs) {
        throw new Error(
          `lock ${lockPath} exists but is unreadable; retry in a moment or remove it manually.`,
        );
      }
    }

    log(
      `removing stale build lock ${lockPath}` +
        (owner ? ` (pid ${owner.pid} is no longer running)` : ' (unreadable lock)'),
    );
    rmSync(lockPath, { force: true });
  }

  throw new Error(`could not acquire ${lockPath}; another process may be racing this build.`);
}

/**
 * Removes the lock only when it is still owned by `token`. Returns true when a
 * file was removed, false when the lock had already disappeared or changed
 * owner.
 */
export function releaseBuildLock(lockPath, token) {
  const owner = readLockFile(lockPath);
  if (!owner || owner.token !== token) return false;
  rmSync(lockPath, { force: true });
  return true;
}
