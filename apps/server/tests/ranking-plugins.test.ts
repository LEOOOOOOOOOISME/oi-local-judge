import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getOfficialRanking, invalidateOfficialRanking } from '../src/services/official-ranking.js';
import { createContest } from '../src/storage/repos/contests.js';
import { createProblem } from '../src/storage/repos/problems.js';
import {
  upsertRankingPlugin,
  setRankingPluginEnabled,
} from '../src/storage/repos/ranking-plugins.js';
import { migrate } from '../src/storage/migrate.js';
import { openDatabase } from '../src/storage/db.js';

const root = mkdtempSync(join(process.cwd(), 'native/runner/out', 'ranking-plugin-'));
const db = openDatabase(join(root, 'test.db'));
migrate(db);
const problemId = createProblem(db, {
  title: 'Plugin Problem',
  type: 'standard',
  timeMs: 1000,
  memoryMb: 64,
  testcases: [],
});

afterAll(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe('ranking plugins', () => {
  it('loads an enabled plugin and falls back with pluginError when disabled', async () => {
    const pluginDir = join(root, 'plugins');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'reverse.mjs'),
      `export const apiVersion = 1;
export function compute(input) {
  return input.userIds.map((userId, index) => ({
    rank: index + 1,
    userId,
    totalScore: (input.userIds.length - index) * 10,
    solved: 0,
    penalty: 0,
    lastAcAt: null,
    cells: [],
  }));
}
`,
    );
    const plugin = upsertRankingPlugin(db, {
      name: 'reverse',
      jsPath: 'plugins/reverse.mjs',
      sha256: 'reverse-v1',
      uploadedBy: 1,
    });

    const contestId = createContest(db, {
      name: 'Plugin Contest',
      mode: 'oi',
      problemIds: [problemId],
    });
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, 1);
    db.prepare(
      "INSERT INTO contest_participants(contest_id, user_id, status) VALUES (?, ?, 'accepted')",
    ).run(contestId, 2);
    db.prepare('UPDATE contests SET ranking_rule_json = ? WHERE id = ?').run(
      JSON.stringify({ preset: 'plugin:reverse', tie: 'same-rank' }),
      contestId,
    );

    const first = await getOfficialRanking(db, contestId, root);
    expect(first?.preset).toBe('plugin:reverse');
    expect(first?.rows.map((row) => row.totalScore)).toEqual([20, 10]);

    setRankingPluginEnabled(db, plugin.id, false);
    // Disabling a plugin goes through the admin route, which invalidates the
    // cached ranking; this direct repository call must do the same.
    invalidateOfficialRanking(db, contestId);
    const fallback = await getOfficialRanking(db, contestId, root);
    expect(fallback?.preset).toBe('plugin:reverse');
    expect(fallback?.pluginError).toContain('missing or disabled');
    expect(fallback?.rows).toHaveLength(2);
  });
});
