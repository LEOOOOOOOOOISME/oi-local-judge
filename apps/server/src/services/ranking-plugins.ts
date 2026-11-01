import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { RankingRowResult } from '@oij/shared';
import { getRankingPlugin } from '../storage/repos/ranking-plugins.js';

export interface RankingPluginInput {
  problemIds: number[];
  userIds: number[];
  submissions: Array<{
    userId: number;
    problemId: number;
    verdict: string;
    score: number;
    createdAt: number;
  }>;
  officialScores?: Array<{ userId: number; problemId: number; score: number; verdict: string }>;
  hacks?: Array<{
    hackerId: number;
    targetUserId: number;
    problemId: number;
    status: 'success' | 'failed';
    createdAt: number;
  }>;
  problemPoints?: Record<number, number>;
  contestStartAt?: number | null;
  contestEndAt?: number | null;
  config: Record<string, unknown>;
}

export interface RankingPluginModule {
  apiVersion: 1;
  compute(input: RankingPluginInput): RankingRowResult[];
}

const cache = new Map<string, { sha256: string; module: RankingPluginModule }>();

export async function loadRankingPlugin(
  db: DatabaseSync,
  dataDir: string,
  name: string,
): Promise<RankingPluginModule | null> {
  const row = getRankingPlugin(db, name);
  if (!row || row.enabled !== 1) return null;
  const absolute = isAbsolute(row.js_path) ? row.js_path : join(dataDir, row.js_path);
  const root = resolve(dataDir);
  const resolved = resolve(absolute);
  if (!resolved.startsWith(root) || !existsSync(resolved)) return null;
  const cached = cache.get(name);
  if (cached && cached.sha256 === row.sha256) return cached.module;
  const imported = (await import(`${pathToFileURL(resolved).href}?v=${row.sha256}`)) as Partial<RankingPluginModule>;
  if (imported.apiVersion !== 1 || typeof imported.compute !== 'function') return null;
  const module = imported as RankingPluginModule;
  cache.set(name, { sha256: row.sha256, module });
  return module;
}
