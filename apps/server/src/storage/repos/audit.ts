import type { DatabaseSync } from 'node:sqlite';

export interface AuditRow {
  id: number;
  actor_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail_json: string;
  ip: string | null;
  created_at: number;
}

export function recordAudit(
  db: DatabaseSync,
  input: {
    actorId?: number | null;
    action: string;
    targetType?: string | null;
    targetId?: string | number | null;
    detail?: unknown;
    ip?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit_logs(actor_id, action, target_type, target_id, detail_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.actorId ?? null,
    input.action,
    input.targetType ?? null,
    input.targetId === undefined || input.targetId === null ? null : String(input.targetId),
    JSON.stringify(input.detail ?? {}),
    input.ip ?? null,
    Date.now(),
  );
}

export function listAuditLogs(db: DatabaseSync, limit = 200): AuditRow[] {
  return db
    .prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 500)) as unknown as AuditRow[];
}
