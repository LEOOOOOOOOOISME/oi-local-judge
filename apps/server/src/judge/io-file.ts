import { isAbsolute, resolve, sep } from 'node:path';

/** File-IO names are plain basenames; no separators, drive letters or dot-dot. */
const SAFE_IO_FILE_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeIoFileName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    SAFE_IO_FILE_NAME.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !isAbsolute(name)
  );
}

/**
 * Resolves a stored file-IO name inside the per-run work directory. Returns
 * null when the name is unsafe or escapes the directory, so a legacy database
 * row can never turn into an arbitrary read/write path.
 */
export function resolveWorkdirFile(workdir: string, name: unknown): string | null {
  if (!isSafeIoFileName(name)) return null;
  const root = resolve(workdir);
  const full = resolve(root, name);
  return full.startsWith(`${root}${sep}`) ? full : null;
}
