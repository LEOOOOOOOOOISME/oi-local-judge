import type { DatabaseSync } from 'node:sqlite';

export const ASSET_KINDS = [
  'std',
  'checker',
  'validator',
  'generator',
  'interactor',
  'judger',
  'brute',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

export interface AssetRow {
  id: number;
  problem_id: number;
  kind: AssetKind;
  name: string;
  path: string;
  language: string | null;
  sha256: string;
  size: number;
  updated_at: number;
}

export interface UpsertAssetInput {
  problemId: number;
  kind: AssetKind;
  name: string;
  path: string;
  language?: string | null;
  sha256: string;
  size: number;
}

export function upsertAsset(db: DatabaseSync, input: UpsertAssetInput): AssetRow {
  db.prepare(
    `INSERT INTO problem_assets(problem_id, kind, name, path, language, sha256, size, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(problem_id, kind) DO UPDATE SET
       name = excluded.name, path = excluded.path, language = excluded.language,
       sha256 = excluded.sha256, size = excluded.size, updated_at = excluded.updated_at`,
  ).run(
    input.problemId,
    input.kind,
    input.name,
    input.path,
    input.language ?? null,
    input.sha256,
    input.size,
    Date.now(),
  );
  return getAsset(db, input.problemId, input.kind)!;
}

export function getAsset(db: DatabaseSync, problemId: number, kind: AssetKind): AssetRow | null {
  return (
    (db
      .prepare('SELECT * FROM problem_assets WHERE problem_id = ? AND kind = ?')
      .get(problemId, kind) as unknown as AssetRow) ?? null
  );
}

export function listAssets(db: DatabaseSync, problemId: number): AssetRow[] {
  return db
    .prepare('SELECT * FROM problem_assets WHERE problem_id = ? ORDER BY kind')
    .all(problemId) as unknown as AssetRow[];
}

export function deleteAsset(db: DatabaseSync, problemId: number, kind: AssetKind): void {
  db.prepare('DELETE FROM problem_assets WHERE problem_id = ? AND kind = ?').run(problemId, kind);
}
