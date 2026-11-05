import type { DatabaseSync } from 'node:sqlite';
import type { TeamRole } from './teams.js';

export interface ContestTeamRow {
  contest_id: number;
  team_id: number;
  registered_by: number | null;
  registered_at: number;
}

export interface ContestTeamMemberDto {
  userId: number;
  username: string;
  realName: string | null;
  className: string | null;
  role: TeamRole;
}

export interface TeamRegistrationDto {
  teamId: number;
  name: string;
  ownerId: number;
  registeredBy: number | null;
  registeredAt: number;
  members: ContestTeamMemberDto[];
}

export interface ContestTeamMemberConflict {
  userId: number;
  username: string;
  teamId: number;
  teamName: string;
}

export function getContestTeamRegistration(
  db: DatabaseSync,
  contestId: number,
  teamId: number,
): ContestTeamRow | null {
  return (
    (db
      .prepare('SELECT * FROM contest_teams WHERE contest_id = ? AND team_id = ?')
      .get(contestId, teamId) as unknown as ContestTeamRow) ?? null
  );
}

export function insertContestTeamRegistration(
  db: DatabaseSync,
  input: {
    contestId: number;
    teamId: number;
    registeredBy: number | null;
    registeredAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO contest_teams(contest_id, team_id, registered_by, registered_at)
     VALUES (?, ?, ?, ?)`,
  ).run(input.contestId, input.teamId, input.registeredBy, input.registeredAt);
}

export function deleteContestTeamRegistration(
  db: DatabaseSync,
  contestId: number,
  teamId: number,
): boolean {
  const result = db
    .prepare('DELETE FROM contest_teams WHERE contest_id = ? AND team_id = ?')
    .run(contestId, teamId);
  return Number(result.changes) > 0;
}

export function listContestTeamRegistrations(
  db: DatabaseSync,
  contestId: number,
): TeamRegistrationDto[] {
  const rows = db
    .prepare(
      `SELECT ct.team_id, ct.registered_by, ct.registered_at,
              t.name, t.owner_id,
              tm.user_id, tm.role, u.username, u.real_name, u.class_name
       FROM contest_teams ct
       JOIN teams t ON t.id = ct.team_id
       LEFT JOIN team_members tm ON tm.team_id = ct.team_id
       LEFT JOIN users u ON u.id = tm.user_id
       WHERE ct.contest_id = ?
       ORDER BY ct.registered_at, ct.team_id,
                CASE tm.role WHEN 'captain' THEN 0 ELSE 1 END, u.username`,
    )
    .all(contestId) as unknown as Array<{
    team_id: number;
    registered_by: number | null;
    registered_at: number;
    name: string;
    owner_id: number;
    user_id: number | null;
    role: TeamRole | null;
    username: string | null;
    real_name: string | null;
    class_name: string | null;
  }>;

  const byTeam = new Map<number, TeamRegistrationDto>();
  for (const row of rows) {
    let registration = byTeam.get(row.team_id);
    if (!registration) {
      registration = {
        teamId: row.team_id,
        name: row.name,
        ownerId: row.owner_id,
        registeredBy: row.registered_by,
        registeredAt: row.registered_at,
        members: [],
      };
      byTeam.set(row.team_id, registration);
    }
    if (row.user_id !== null && row.username !== null && row.role !== null) {
      registration.members.push({
        userId: row.user_id,
        username: row.username,
        realName: row.real_name,
        className: row.class_name,
        role: row.role,
      });
    }
  }
  return [...byTeam.values()];
}

/** All teams the user is a member of that are registered for the contest. */
export function listRegisteredTeamIdsForUser(
  db: DatabaseSync,
  contestId: number,
  userId: number,
): number[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT ct.team_id
         FROM contest_teams ct
         JOIN team_members tm ON tm.team_id = ct.team_id
         WHERE ct.contest_id = ? AND tm.user_id = ?
         ORDER BY ct.team_id`,
      )
      .all(contestId, userId) as unknown as Array<{ team_id: number }>
  ).map((row) => row.team_id);
}

/**
 * Returns the first member of `teamId` who is already registered for the same
 * contest with a different team, or null when the roster is conflict-free.
 */
export function findContestTeamMemberConflict(
  db: DatabaseSync,
  contestId: number,
  teamId: number,
): ContestTeamMemberConflict | null {
  const row = db
    .prepare(
      `SELECT tm.user_id, u.username, ct.team_id, t.name AS team_name
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       JOIN contest_teams ct ON ct.contest_id = ?
       JOIN teams t ON t.id = ct.team_id
       WHERE tm.team_id = ?
         AND ct.team_id <> ?
         AND EXISTS (
           SELECT 1 FROM team_members other
           WHERE other.team_id = ct.team_id AND other.user_id = tm.user_id
         )
       ORDER BY tm.user_id, ct.team_id
       LIMIT 1`,
    )
    .get(contestId, teamId, teamId) as
    | {
        user_id: number;
        username: string;
        team_id: number;
        team_name: string;
      }
    | undefined;
  if (!row) return null;
  return {
    userId: row.user_id,
    username: row.username,
    teamId: row.team_id,
    teamName: row.team_name,
  };
}
