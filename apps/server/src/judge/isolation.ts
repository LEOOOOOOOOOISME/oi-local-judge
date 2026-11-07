// Isolation helpers for processes that execute contestant (or author) code.
//
// The judge never hands its own environment to a child: `OIJ_SESSION_SECRET`,
// `OIJ_ADMIN_PASSWORD`, `OIJ_DATA_DIR` and `NODE_OPTIONS` would let submitted
// code read secrets, locate answers or inject modules. Only the variables a
// Windows executable needs to start are passed through.
//
// Work directories live outside `<dataDir>` so a contestant process cannot walk
// up from its cwd into the database, problem tests or secrets.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

const PASSTHROUGH_ENV = new Set([
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_ARCHITEW6432',
  'OS',
  'LANG',
  'LC_ALL',
]);

/**
 * Minimal environment for a judged/compiled process. `TEMP`/`TMP` are pointed
 * at the run's work directory so temp files never land next to the data.
 */
export function judgeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  workdir?: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && PASSTHROUGH_ENV.has(key)) result[key] = value;
  }
  if (workdir) {
    result.TEMP = workdir;
    result.TMP = workdir;
  }
  return result;
}

/**
 * Root for transient judge work directories. It is a sibling of `dataDir`,
 * explicitly verified not to be inside it. A sibling (instead of the OS temp
 * directory) keeps the same filesystem permissions/integrity label as the
 * application tree, which low-integrity sandbox builds need, while still hiding
 * the database, test data and secrets from a contestant's cwd.
 */
export function judgeWorkRoot(dataDir: string): string {
  const data = resolve(dataDir);
  const candidate = resolve(dirname(data), `${basename(data)}-judge-tmp`);
  if (candidate === data || candidate.startsWith(`${data}${sep}`)) {
    // Extremely defensive fallback when dataDir is a drive root.
    return resolve(join(tmpdir(), 'oij-judge'));
  }
  return candidate;
}

/** Creates a unique work directory outside `dataDir`. */
export function createJudgeWorkdir(dataDir: string, prefix: string): string {
  const root = judgeWorkRoot(dataDir);
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, prefix));
}
