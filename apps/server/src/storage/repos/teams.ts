import type { DatabaseSync } from 'node:sqlite';

export type TeamRole = 'captain' | 'coach' | 'assistant' | 'member';

/**
 * Kind discriminator stored on the shared `teams` table.
 *
 * - `team`: self-service contest team, owner is its captain.
 * - `class`: teaching group, owner is its first coach; may have several coaches
 *   and assistants and can be switched out of contest participation.
 */
export type TeamKind = 'team' | 'class';

export interface TeamRow {
  id: number;
  name: string;
  owner_id: number;
  kind: TeamKind;
  allow_contest: number;
  created_at: number;
}

export interface TeamMemberRow {
  team_id: number;
  user_id: number;
  role: TeamRole;
  joined_at: number;
}

export interface TeamDto {
  id: number;
  name: string;
  ownerId: number;
  kind: TeamKind;
  allowContest: boolean;
  createdAt: number;
  memberCount: number;
  role: TeamRole;
}

export interface TeamMemberDto {
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: TeamRole;
  joinedAt: number;
}

export interface TeamDetail {
  id: number;
  name: string;
  ownerId: number;
  kind: TeamKind;
  allowContest: boolean;
  createdAt: number;
  members: TeamMemberDto[];
}

/** 管理员全量团队搜索行（不含 viewerRole，与成员身份无关）。 */
export interface AdminTeamRow {
  id: number;
  name: string;
  owner_id: number;
  kind: TeamKind;
  allow_contest: number;
  created_at: number;
  member_count: number;
}

/** 转义 LIKE 通配符，避免用户输入的 % / _ 被当成模式匹配。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * 管理员全量组搜索：按名称模糊匹配（大小写不敏感），按名称排序。
 * `kind` 可选过滤班级/团队；`limit` 会被夹在 1–100 之间，默认 20。
 */
export function searchTeams(
  db: DatabaseSync,
  filter: { query?: string; limit?: number; kind?: TeamKind } = {},
): AdminTeamRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  const query = filter.query?.trim() ?? '';
  if (query !== '') {
    clauses.push("t.name LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(query)}%`);
  }
  if (filter.kind !== undefined) {
    clauses.push('t.kind = ?');
    params.push(filter.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 20), 1), 100);
  return db
    .prepare(
      `SELECT t.id, t.name, t.owner_id, t.kind, t.allow_contest, t.created_at,
              (SELECT COUNT(*) FROM team_members m WHERE m.team_id = t.id) AS member_count
       FROM teams t
       ${where}
       ORDER BY t.name COLLATE NOCASE, t.id
       LIMIT ?`,
    )
    .all(...params, limit) as unknown as AdminTeamRow[];
}

export function getTeamRow(db: DatabaseSync, teamId: number): TeamRow | null {
  return (db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId) as unknown as TeamRow) ?? null;
}

export function getTeamByName(db: DatabaseSync, name: string): TeamRow | null {
  return (db.prepare('SELECT * FROM teams WHERE name = ?').get(name) as unknown as TeamRow) ?? null;
}

export function insertTeam(
  db: DatabaseSync,
  input: {
    name: string;
    ownerId: number;
    createdAt: number;
    kind?: TeamKind;
    allowContest?: boolean;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO teams(name, owner_id, kind, allow_contest, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.ownerId,
      input.kind ?? 'team',
      input.allowContest === false ? 0 : 1,
      input.createdAt,
    );
  return Number(result.lastInsertRowid);
}

/**
 * Lists the groups of one kind the user belongs to. Classes and teams share a
 * table but are deliberately separated in API responses so a class never leaks
 * into the self-service team UI.
 */
export function listTeamsForUser(
  db: DatabaseSync,
  userId: number,
  kind: TeamKind = 'team',
): TeamDto[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.name, t.owner_id, t.kind, t.allow_contest, t.created_at, m.role,
              (SELECT COUNT(*) FROM team_members c WHERE c.team_id = t.id) AS member_count
       FROM team_members m
       JOIN teams t ON t.id = m.team_id
       WHERE m.user_id = ? AND t.kind = ?
       ORDER BY t.id`,
    )
    .all(userId, kind) as unknown as Array<{
    id: number;
    name: string;
    owner_id: number;
    kind: TeamKind;
    allow_contest: number;
    created_at: number;
    role: TeamRole;
    member_count: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    kind: row.kind,
    allowContest: row.allow_contest === 1,
    createdAt: row.created_at,
    memberCount: Number(row.member_count),
    role: row.role,
  }));
}

export function listTeamMembers(db: DatabaseSync, teamId: number): TeamMemberDto[] {
  const rows = db
    .prepare(
      `SELECT m.user_id, m.role, m.joined_at, u.username, u.real_name, u.class_name
       FROM team_members m
       JOIN users u ON u.id = m.user_id
       WHERE m.team_id = ?
       ORDER BY CASE m.role
                  WHEN 'captain' THEN 0
                  WHEN 'coach' THEN 1
                  WHEN 'assistant' THEN 2
                  ELSE 3
                END, u.username`,
    )
    .all(teamId) as unknown as Array<{
    user_id: number;
    role: TeamRole;
    joined_at: number;
    username: string;
    real_name: string | null;
    class_name: string | null;
  }>;
  return rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    realName: row.real_name,
    className: row.class_name,
    role: row.role,
    joinedAt: row.joined_at,
  }));
}

export function getTeamMember(
  db: DatabaseSync,
  teamId: number,
  userId: number,
): TeamMemberRow | null {
  return (
    (db
      .prepare('SELECT * FROM team_members WHERE team_id = ? AND user_id = ?')
      .get(teamId, userId) as unknown as TeamMemberRow) ?? null
  );
}

export function insertTeamMember(
  db: DatabaseSync,
  input: { teamId: number; userId: number; role: TeamRole; joinedAt: number },
): void {
  db.prepare(
    'INSERT INTO team_members(team_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
  ).run(input.teamId, input.userId, input.role, input.joinedAt);
}

export function removeTeamMemberRow(db: DatabaseSync, teamId: number, userId: number): boolean {
  const result = db
    .prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?')
    .run(teamId, userId);
  return Number(result.changes) > 0;
}

export function updateTeamMemberRole(
  db: DatabaseSync,
  teamId: number,
  userId: number,
  role: TeamRole,
): void {
  db.prepare('UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?').run(
    role,
    teamId,
    userId,
  );
}

export function updateTeamOwner(db: DatabaseSync, teamId: number, ownerId: number): void {
  db.prepare('UPDATE teams SET owner_id = ? WHERE id = ?').run(ownerId, teamId);
}

/** Updates the mutable settings of a group (name and/or the contest switch). */
export function updateTeamSettings(
  db: DatabaseSync,
  teamId: number,
  input: { name?: string; allowContest?: boolean },
): void {
  const assignments: string[] = [];
  const params: Array<string | number> = [];
  if (input.name !== undefined) {
    assignments.push('name = ?');
    params.push(input.name);
  }
  if (input.allowContest !== undefined) {
    assignments.push('allow_contest = ?');
    params.push(input.allowContest ? 1 : 0);
  }
  if (assignments.length === 0) return;
  params.push(teamId);
  db.prepare(`UPDATE teams SET ${assignments.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteTeamWithMembers(db: DatabaseSync, teamId: number): void {
  db.prepare('DELETE FROM contest_teams WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId);
  db.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
}
