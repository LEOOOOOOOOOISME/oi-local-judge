// Update check against GitHub Releases.
//
// The check is best-effort: any network, HTTP or payload problem is reported as a
// structured `{ error }` result so the admin page can explain it instead of the
// API returning a 500. Successful results are cached for one hour; failures are
// not cached so a transient outage does not hide a later retry.
//
// `/releases/latest` ignores prereleases, which is wrong for this project: the
// current version can itself be a prerelease (e.g. `1.1.0-rc.6`). Instead the
// release list is fetched and the highest semver release is selected; drafts are
// always skipped. `OIJ_UPDATE_INCLUDE_PRERELEASE=0` restricts the selection to
// final releases.
//
// This service never downloads or installs anything.
const DEFAULT_UPDATE_REPO = 'LEOOOOOOOOOISME/oi-local-judge';
const GITHUB_API_BASE = 'https://api.github.com/repos';
const USER_AGENT = 'oi-local-judge-update-check';
/** GitHub's default page size is 30; 20 keeps the payload small but sufficient. */
const RELEASES_PER_PAGE = 20;
/** A hung GitHub request must not occupy the admin request for long. */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;
export const UPDATE_CHECK_CACHE_TTL_MS = 60 * 60 * 1000;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Minimal response surface needed from `fetch`, so tests can inject a fake. */
export interface UpdateFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type UpdateFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<UpdateFetchResponse>;

export interface UpdateCheckSuccess {
  current: string;
  latest: string;
  /** The selected release's tag as returned by GitHub (e.g. `v1.1.0-rc.7`). */
  tagName: string;
  /** Whether the selected release is a prerelease (semver or GitHub flag). */
  isPrerelease: boolean;
  updateAvailable: boolean;
  /** Release page (not a direct asset download). */
  url: string | null;
  /** Release publication time in epoch milliseconds, or null when absent. */
  publishedAt: number | null;
  notes: string;
  checkedAt: number;
}

export interface UpdateCheckFailure {
  error: string;
  current: string;
  checkedAt: number;
}

export type UpdateCheckResult = UpdateCheckSuccess | UpdateCheckFailure;

export interface CheckForUpdateOptions {
  currentVersion: string;
  /** Defaults to `OIJ_UPDATE_REPO`, then to {@link DEFAULT_UPDATE_REPO}. */
  repo?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: UpdateFetch;
  now?: number;
  /** The production timeout is {@link UPDATE_CHECK_TIMEOUT_MS}; tests may lower it. */
  timeoutMs?: number;
  /**
   * Defaults to the process environment. `OIJ_UPDATE_INCLUDE_PRERELEASE=0`
   * (or `false`) restricts the check to final releases.
   */
  env?: NodeJS.ProcessEnv;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

/** A release entry from the GitHub release list that can be compared. */
interface ReleaseCandidate {
  payload: Record<string, unknown>;
  tag: string;
  version: string;
  isPrerelease: boolean;
}

interface CacheEntry {
  key: string;
  expiresAt: number;
  value: UpdateCheckSuccess;
}

// One entry is enough: the admin page checks the same repo/version repeatedly.
let cache: CacheEntry | null = null;

/** Clears the in-memory cache. Exposed for tests; production restarts are rare. */
export function resetUpdateCheckCache(): void {
  cache = null;
}

function normalizeVersion(value: string): string {
  return value.trim().replace(/^[vV]/, '');
}

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(normalizeVersion(value));
  if (!match) return null;
  const prerelease = match[4] ? match[4].split('.') : [];
  // An empty identifier (e.g. `1.0.0-alpha..1`) is not valid semver.
  if (prerelease.some((identifier) => identifier.length === 0)) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compares two semantic versions, including prerelease precedence:
 * `1.0.0 > 1.0.0-rc.2 > 1.0.0-rc.1 > 1.0.0-beta`.
 * Throws for a value that is not a semantic version.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) {
    throw new Error(`无法解析版本号：${!left ? a : b}`);
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    const difference = left[key] - right[key];
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  // A final release has higher precedence than any prerelease of the same core.
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  for (let index = 0; index < Math.min(left.prerelease.length, right.prerelease.length); index += 1) {
    const difference = compareIdentifier(left.prerelease[index], right.prerelease[index]);
    if (difference !== 0) return difference;
  }
  return left.prerelease.length - right.prerelease.length;
}

function resolveRepo(options: CheckForUpdateOptions): string {
  const configured = options.repo ?? options.env?.OIJ_UPDATE_REPO ?? DEFAULT_UPDATE_REPO;
  const repo = configured.trim();
  return repo.length > 0 ? repo : DEFAULT_UPDATE_REPO;
}

/** Prereleases are included unless explicitly disabled. */
function resolveIncludePrerelease(options: CheckForUpdateOptions): boolean {
  const raw = (options.env ?? process.env).OIJ_UPDATE_INCLUDE_PRERELEASE;
  if (typeof raw !== 'string') return true;
  const normalized = raw.trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function releaseNotes(payload: Record<string, unknown>): string {
  return typeof payload.body === 'string' ? payload.body : '';
}

function releaseUrl(payload: Record<string, unknown>, repo: string, tag: string): string | null {
  if (typeof payload.html_url === 'string' && /^https?:\/\//.test(payload.html_url)) {
    return payload.html_url;
  }
  return tag.length > 0 ? `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}` : null;
}

function publishedAt(payload: Record<string, unknown>): number | null {
  if (typeof payload.published_at !== 'string') return null;
  const parsed = Date.parse(payload.published_at);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Selects the release with the highest semver from the GitHub release list.
 * Drafts and entries without a parseable tag are ignored; prereleases are
 * skipped when `includePrerelease` is false.
 */
function selectRelease(
  payload: unknown,
  includePrerelease: boolean,
): { release: ReleaseCandidate } | { error: string } {
  if (!Array.isArray(payload)) {
    return { error: 'GitHub Releases 响应格式错误' };
  }

  let best: ReleaseCandidate | null = null;
  for (const entry of payload) {
    if (!isRecord(entry)) continue;
    // Drafts are unpublished: they must never be offered as an update.
    if (entry.draft === true) continue;
    const tag = typeof entry.tag_name === 'string' ? entry.tag_name.trim() : '';
    if (tag.length === 0) continue;
    const version = normalizeVersion(tag);
    const parsed = parseSemver(version);
    if (!parsed) continue;
    // GitHub can mark a release as prerelease even when the tag looks final.
    const isPrerelease = parsed.prerelease.length > 0 || entry.prerelease === true;
    if (isPrerelease && !includePrerelease) continue;
    if (!best || compareSemver(version, best.version) > 0) {
      best = { payload: entry, tag, version, isPrerelease };
    }
  }

  if (!best) {
    return {
      error: includePrerelease
        ? '无法解析任何发布版本号'
        : '没有可比较的正式版本发布（已禁用预发布版本）',
    };
  }
  return { release: best };
}

/**
 * Fetches the GitHub release list, selects the highest semver release (including
 * prereleases by default) and compares it with `currentVersion`.
 * Never throws for network/HTTP/payload failures: those become `{ error }`.
 */
export async function checkForUpdate(
  options: CheckForUpdateOptions,
): Promise<UpdateCheckResult> {
  const now = options.now ?? Date.now();
  const current = normalizeVersion(options.currentVersion);
  if (!parseSemver(current)) {
    return { error: `无法解析当前版本号：${options.currentVersion}`, current, checkedAt: now };
  }

  const repo = resolveRepo(options);
  if (!REPO_PATTERN.test(repo)) {
    return { error: `更新仓库配置无效：${repo}`, current, checkedAt: now };
  }
  const includePrerelease = resolveIncludePrerelease(options);

  // The include flag belongs to the key: toggling it must not reuse a stale result.
  const key = `${repo.toLowerCase()}@${current}@${includePrerelease ? 'pre' : 'stable'}`;
  if (cache && cache.key === key && now < cache.expiresAt) {
    return cache.value;
  }

  const fetcher = options.fetch ?? (globalThis.fetch as unknown as UpdateFetch);
  const timeoutMs = options.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  // Promise.race also covers a fetch implementation that ignores the abort
  // signal: the timeout wins and the admin request cannot hang.
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`检查更新超时（${timeoutMs}ms）`));
    }, timeoutMs);
  });

  let response: UpdateFetchResponse;
  try {
    response = await Promise.race([
      fetcher(`${GITHUB_API_BASE}/${repo}/releases?per_page=${RELEASES_PER_PAGE}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
        signal: controller.signal,
      }),
      timeout,
    ]);
  } catch (error) {
    const message = timedOut
      ? `检查更新超时（${timeoutMs}ms），请检查网络后重试`
      : `检查更新失败：${describeError(error)}`;
    return { error: message, current, checkedAt: now };
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      error: `GitHub Releases 请求失败（HTTP ${response.status}）`,
      current,
      checkedAt: now,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return { error: `GitHub Releases 响应无法解析：${describeError(error)}`, current, checkedAt: now };
  }

  const selected = selectRelease(payload, includePrerelease);
  if ('error' in selected) {
    return { error: selected.error, current, checkedAt: now };
  }

  const { release } = selected;
  let updateAvailable: boolean;
  try {
    updateAvailable = compareSemver(release.version, current) > 0;
  } catch (error) {
    return { error: describeError(error), current, checkedAt: now };
  }

  const result: UpdateCheckSuccess = {
    current,
    latest: release.version,
    tagName: release.tag,
    isPrerelease: release.isPrerelease,
    updateAvailable,
    url: releaseUrl(release.payload, repo, release.tag),
    publishedAt: publishedAt(release.payload),
    notes: releaseNotes(release.payload),
    checkedAt: now,
  };
  cache = { key, expiresAt: now + UPDATE_CHECK_CACHE_TTL_MS, value: result };
  return result;
}
