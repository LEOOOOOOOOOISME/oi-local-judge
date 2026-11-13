// Windows worker-account isolation helpers.
//
// The optional low-privilege worker account limits what contestant code can
// read/touch. The native runner creates the contestant with
// CreateProcessWithLogonW; these helpers only manage credentials, ACLs and the
// environment that is handed to the native helpers.
import { execFileSync } from 'node:child_process';
import type { Config } from '../config.js';
import { createJudgeWorkdir } from './isolation.js';

export interface WorkerRunOptions {
  user: string;
  password: string;
  required: boolean;
}

export function workerRunOptions(config: Config): WorkerRunOptions | undefined {
  if (!config.workerUser || !config.workerPassword) return undefined;
  return {
    user: config.workerUser,
    password: config.workerPassword,
    required: config.workerIsolation === 'required',
  };
}

/** Environment handed to ojrunner.exe. Credentials never go on argv. */
export function runnerWorkerEnv(config: Config): Record<string, string> {
  const options = workerRunOptions(config);
  if (!options) return {};
  return {
    OIJ_RUNNER_WORKER_USER: options.user,
    OIJ_RUNNER_WORKER_PASSWORD: options.password,
  };
}

/** Environment handed to ojinteract.exe (contestant child only). */
export function interactWorkerEnv(config: Config): Record<string, string> {
  const options = workerRunOptions(config);
  if (!options) return {};
  return {
    OIJ_INTERACT_WORKER_USER: options.user,
    OIJ_INTERACT_WORKER_PASSWORD: options.password,
  };
}

/** `icacls` arguments granting the worker account access to one work directory. */
export function buildWorkdirGrantArgs(workdir: string, user: string): string[] {
  return [workdir, '/grant', `${user}:(OI)(CI)M`, '/T', '/C', '/Q'];
}

/** `icacls` arguments denying the worker account read access to the data dir. */
export function buildDataDirDenyArgs(dataDir: string, user: string): string[] {
  return [dataDir, '/deny', `${user}:(OI)(CI)R`, '/C', '/Q'];
}

function runIcacls(args: string[]): string | null {
  try {
    execFileSync('icacls.exe', args, { stdio: 'ignore', windowsHide: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Grants the worker read/write access to one freshly created work directory
 * (compiled binary, input/output files). Returns an error string on failure.
 */
export function grantWorkerWorkdir(workdir: string, user: string): string | null {
  return runIcacls(buildWorkdirGrantArgs(workdir, user));
}

/**
 * Creates a judge work directory and, when a worker account is configured,
 * grants only that run's directory to it. Required mode fails closed when the
 * ACL cannot be applied.
 */
export function createIsolatedJudgeWorkdir(config: Config, prefix: string): string {
  const workdir = createJudgeWorkdir(config.dataDir, prefix);
  const options = workerRunOptions(config);
  if (!options) return workdir;
  const error = grantWorkerWorkdir(workdir, options.user);
  if (!error) return workdir;
  if (config.workerIsolation === 'required') {
    throw new Error(`could not grant the worker account access to ${workdir}: ${error}`);
  }
  console.warn(`[worker] could not grant the worker account access to ${workdir}: ${error}`);
  return workdir;
}

/**
 * Applies the data-directory deny ACE (secrets, database, answers are not
 * readable by the worker). Inherited ACEs cover existing children.
 */
export function ensureWorkerDataDirAcl(config: Config): string | null {
  const options = workerRunOptions(config);
  if (!options) return null;
  return runIcacls(buildDataDirDenyArgs(config.dataDir, options.user));
}
