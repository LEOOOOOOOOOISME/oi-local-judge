// Persisted system settings (Settings Center v1.1).
//
// Only a small whitelist of fields may be persisted: secrets such as
// `sessionSecret`/`adminPassword` are never written to or read from
// `settings.json`. Values are validated on write and sanitized on read so a
// hand-edited or truncated file cannot break server startup (invalid keys are
// simply ignored, and the defaults apply).
//
// Writes are atomic: the new content goes to `settings.json.tmp` and is then
// renamed over `settings.json`.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';

export interface PersistedSettings {
  host?: string;
  port?: number;
  judgeConcurrency?: number;
  gxx?: string;
  sessionTtlSec?: number;
}

export interface SettingsView {
  effective: Pick<Config, 'host' | 'port' | 'judgeConcurrency' | 'gxx' | 'sessionTtlSec'>;
  persisted: PersistedSettings;
  envOverrides: string[];
}

const SETTINGS_FILE_NAME = 'settings.json';

/** Whitelisted setting field -> environment variable that overrides it. */
const ENV_OVERRIDES: ReadonlyArray<readonly [keyof PersistedSettings, string]> = [
  ['host', 'OIJ_HOST'],
  ['port', 'OIJ_PORT'],
  ['judgeConcurrency', 'OIJ_JUDGE_CONCURRENCY'],
  ['gxx', 'OIJ_GXX'],
  ['sessionTtlSec', 'OIJ_SESSION_TTL'],
];

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}

export function settingsFilePath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE_NAME);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateHost(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SettingsValidationError('host must be a string');
  }
  const host = value.trim();
  if (host.length === 0 || host.length > 255) {
    throw new SettingsValidationError('host must be a non-empty string of at most 255 characters');
  }
  return host;
}

function validatePort(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new SettingsValidationError('port must be an integer between 1 and 65535');
  }
  return value;
}

function validateJudgeConcurrency(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 8) {
    throw new SettingsValidationError('judgeConcurrency must be an integer between 1 and 8');
  }
  return value;
}

function validateGxx(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SettingsValidationError('gxx must be a string');
  }
  const gxx = value.trim();
  if (gxx.length === 0 || gxx.length > 1024) {
    throw new SettingsValidationError('gxx must be a non-empty string of at most 1024 characters');
  }
  return gxx;
}

function validateSessionTtlSec(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 300 || value > 604_800) {
    throw new SettingsValidationError('sessionTtlSec must be an integer between 300 and 604800');
  }
  return value;
}

const VALIDATORS: {
  [K in keyof Required<PersistedSettings>]: (value: unknown) => Required<PersistedSettings>[K];
} = {
  host: validateHost,
  port: validatePort,
  judgeConcurrency: validateJudgeConcurrency,
  gxx: validateGxx,
  sessionTtlSec: validateSessionTtlSec,
};

/**
 * Validates a partial patch and returns a copy containing only whitelisted
 * fields. Unknown keys are rejected so secrets can never be persisted, and
 * absent (`undefined`) fields are omitted so they keep their stored value.
 */
function sanitizePatch(patch: unknown): PersistedSettings {
  if (!isPlainObject(patch)) {
    throw new SettingsValidationError('settings must be a JSON object');
  }
  const result: PersistedSettings = {};
  for (const key of Object.keys(patch)) {
    if (!(key in VALIDATORS)) {
      throw new SettingsValidationError(`unknown setting: ${key}`);
    }
  }
  for (const [key, validate] of Object.entries(VALIDATORS) as Array<
    [keyof PersistedSettings, (value: unknown) => unknown]
  >) {
    if (patch[key] === undefined) continue;
    // Each validator throws SettingsValidationError for its own field.
    (result as Record<string, unknown>)[key] = validate(patch[key]);
  }
  return result;
}

/**
 * Reads and sanitizes `<dataDir>/settings.json`. A missing, unreadable or
 * malformed file yields `{}`; individually invalid fields are dropped so the
 * server can still start with defaults.
 */
export function readPersistedSettings(dataDir: string): PersistedSettings {
  const file = settingsFilePath(dataDir);
  if (!existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
  if (!isPlainObject(parsed)) return {};
  const result: PersistedSettings = {};
  for (const [key, validate] of Object.entries(VALIDATORS) as Array<
    [keyof PersistedSettings, (value: unknown) => unknown]
  >) {
    if (parsed[key] === undefined) continue;
    try {
      (result as Record<string, unknown>)[key] = validate(parsed[key]);
    } catch {
      // Drop only the invalid field; the rest of the file still applies.
    }
  }
  return result;
}

/**
 * Validates `patch`, merges it over the currently persisted settings and writes
 * the result atomically (tmp file + rename). Returns the full persisted set.
 */
export function writePersistedSettings(dataDir: string, patch: PersistedSettings): PersistedSettings {
  const clean = sanitizePatch(patch);
  const merged: PersistedSettings = { ...readPersistedSettings(dataDir), ...clean };
  const file = settingsFilePath(dataDir);
  const tmp = `${file}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } finally {
    // A failed rename must not leave a stale temp file behind.
    rmSync(tmp, { force: true });
  }
  return merged;
}

/**
 * Builds the admin-facing settings view: effective values (already merged by
 * `loadConfig`), the persisted file contents, and the fields whose environment
 * variable is explicitly set. Secret fields are never part of the view.
 */
export function settingsView(
  config: Config,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): SettingsView {
  return {
    effective: {
      host: config.host,
      port: config.port,
      judgeConcurrency: config.judgeConcurrency,
      gxx: config.gxx,
      sessionTtlSec: config.sessionTtlSec,
    },
    persisted: readPersistedSettings(dataDir),
    envOverrides: ENV_OVERRIDES.filter(([, envKey]) => env[envKey] !== undefined).map(
      ([field]) => field,
    ),
  };
}
