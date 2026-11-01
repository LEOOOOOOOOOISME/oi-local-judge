import type { DatabaseSync } from 'node:sqlite';

export interface RankingPluginRow {
  id: number;
  name: string;
  js_path: string;
  sha256: string;
  enabled: number;
  uploaded_by: number;
  uploaded_at: number;
}

export function listRankingPlugins(db: DatabaseSync): RankingPluginRow[] {
  return db
    .prepare('SELECT * FROM ranking_plugins ORDER BY name')
    .all() as unknown as RankingPluginRow[];
}

export function getRankingPlugin(db: DatabaseSync, name: string): RankingPluginRow | null {
  return (
    (db.prepare('SELECT * FROM ranking_plugins WHERE name = ?').get(name) as unknown as RankingPluginRow) ??
    null
  );
}

export function upsertRankingPlugin(
  db: DatabaseSync,
  input: { name: string; jsPath: string; sha256: string; uploadedBy: number; enabled?: boolean },
): RankingPluginRow {
  db.prepare(
    `INSERT INTO ranking_plugins(name, js_path, sha256, enabled, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       js_path = excluded.js_path,
       sha256 = excluded.sha256,
       enabled = excluded.enabled,
       uploaded_by = excluded.uploaded_by,
       uploaded_at = excluded.uploaded_at`,
  ).run(
    input.name,
    input.jsPath,
    input.sha256,
    input.enabled === false ? 0 : 1,
    input.uploadedBy,
    Date.now(),
  );
  return getRankingPlugin(db, input.name)!;
}

export function setRankingPluginEnabled(
  db: DatabaseSync,
  id: number,
  enabled: boolean,
): void {
  db.prepare('UPDATE ranking_plugins SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}
