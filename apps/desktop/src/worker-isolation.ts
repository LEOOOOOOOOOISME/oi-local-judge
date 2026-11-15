// Optional judge-account isolation requested by the installer.
//
// worker-isolation.ps1 (shared by the NSIS installer and install.ps1) writes
// `<userData>/runtime/worker.json` with `required: true` only after the worker
// account, the ACLs and the outbound firewall rule were applied and verified.
// The server only trusts `OIJ_WORKER_ISOLATION`, so the desktop entry point
// reads this marker and forwards `required` to the server; an explicit
// environment variable always wins so a portable/scripted deployment can
// override the marker.
import { readFileSync } from 'node:fs';

export interface WorkerIsolationOptions {
  /** Path of the installer-managed worker.json. */
  workerFile: string;
  /** Environment to consult first (default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** Injectable reader, for tests. */
  readFile?: (path: string) => string;
}

function defaultReadFile(path: string): string {
  return readFileSync(path, 'utf8');
}

/**
 * Resolves the isolation mode for the embedded server.
 *
 * Returns an explicit `OIJ_WORKER_ISOLATION` value when set; otherwise
 * `'required'` when worker.json says the setup completed; otherwise
 * `undefined` (the server's optional default). A missing, unreadable or
 * malformed worker.json never throws and never upgrades isolation.
 */
export function resolveWorkerIsolationMode(options: WorkerIsolationOptions): string | undefined {
  const env = options.env ?? process.env;
  // An explicitly configured (possibly empty) value wins. The server validates
  // unknown values itself and refuses to start on them.
  if (env.OIJ_WORKER_ISOLATION) return env.OIJ_WORKER_ISOLATION;

  const read = options.readFile ?? defaultReadFile;
  try {
    const raw = read(options.workerFile).replace(/^\uFEFF/, '');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      if ((parsed as { required?: unknown }).required === true) return 'required';
    }
  } catch {
    // No worker.json (or an unreadable one) simply keeps the optional mode.
  }
  return undefined;
}
