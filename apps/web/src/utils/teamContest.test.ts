import { describe, expect, it } from 'vitest';
import type { TeamRankingProblem, TeamRankingRow, TeamSummary } from '../api/types';
import {
  buildTeamRankingCsv,
  captainTeams,
  findTeamByIdOrName,
  resolveTeamMode,
  teamModeLabel,
} from './teamContest';

const teams: TeamSummary[] = [
  { id: 7, name: 'Alpha', ownerId: 1, createdAt: 0, memberCount: 3, role: 'captain' },
  { id: 8, name: 'Beta', ownerId: 2, createdAt: 0, memberCount: 2, role: 'member' },
  { id: 9, name: 'Gamma', ownerId: 3, createdAt: 0, memberCount: 1, role: 'captain' },
];

const rankingRows: TeamRankingRow[] = [
  {
    rank: 1,
    teamId: 7,
    teamName: 'Alpha',
    memberCount: 3,
    totalScore: 180,
    solved: 2,
    penalty: 0,
    lastAcAt: 1_700_000_000_000,
    cells: [
      { problemId: 11, score: 100, verdict: 'AC', attempts: 1, firstAcAt: 1_700_000_000_000 },
      { problemId: 12, score: 80, verdict: 'PC', attempts: 2, firstAcAt: null },
    ],
  },
  {
    rank: 2,
    teamId: 9,
    teamName: 'Gamma',
    memberCount: 1,
    totalScore: 100,
    solved: 1,
    penalty: 0,
    lastAcAt: null,
    cells: [
      { problemId: 11, score: 100, verdict: 'AC', attempts: 1, firstAcAt: null },
    ],
  },
];

describe('resolveTeamMode', () => {
  it('defaults missing values to individual', () => {
    expect(resolveTeamMode(undefined)).toBe('individual');
    expect(resolveTeamMode(null)).toBe('individual');
    expect(resolveTeamMode({})).toBe('individual');
  });

  it('reads snake_case team_mode returned by the API', () => {
    expect(resolveTeamMode({ team_mode: 'team' })).toBe('team');
    expect(resolveTeamMode({ team_mode: 'both' })).toBe('both');
    expect(resolveTeamMode({ team_mode: 'individual' })).toBe('individual');
  });

  it('accepts camelCase teamMode for mapped DTOs', () => {
    expect(resolveTeamMode({ teamMode: 'team' })).toBe('team');
    expect(resolveTeamMode({ teamMode: 'both' })).toBe('both');
  });

  it('falls back to individual for unknown or legacy values', () => {
    expect(resolveTeamMode({ team_mode: 'squad' as never })).toBe('individual');
    expect(resolveTeamMode({ teamMode: null })).toBe('individual');
  });
});

describe('teamModeLabel', () => {
  it('labels every supported mode', () => {
    expect(teamModeLabel('individual')).toBe('个人赛');
    expect(teamModeLabel('team')).toBe('团队赛');
    expect(teamModeLabel('both')).toBe('个人/团队均可');
  });
});

describe('captainTeams', () => {
  it('keeps only teams the current user captains', () => {
    expect(captainTeams(teams).map((team) => team.id)).toEqual([7, 9]);
  });

  it('returns an empty list when the user captains nothing', () => {
    expect(captainTeams([teams[1]])).toEqual([]);
  });
});

describe('findTeamByIdOrName', () => {
  it('resolves a numeric team id', () => {
    expect(findTeamByIdOrName(teams, '9')?.name).toBe('Gamma');
  });

  it('resolves an exact team name after trimming', () => {
    expect(findTeamByIdOrName(teams, '  Gamma ')?.id).toBe(9);
  });

  it('does not guess partial, case-insensitive, or unknown values', () => {
    expect(findTeamByIdOrName(teams, 'gam')).toBeNull();
    expect(findTeamByIdOrName(teams, 'gamma')).toBeNull();
    expect(findTeamByIdOrName(teams, '')).toBeNull();
    expect(findTeamByIdOrName(teams, '   ')).toBeNull();
    expect(findTeamByIdOrName(teams, '99')).toBeNull();
  });
});

describe('buildTeamRankingCsv', () => {
  it('exports ranking, team, member count and per-problem scores', () => {
    const problems: TeamRankingProblem[] = [
      { id: 11, ordinal: 1, points: 100, title: 'A 题' },
      { id: 12, ordinal: 2, points: 100, title: 'B 题' },
    ];
    const csv = buildTeamRankingCsv(problems, rankingRows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('排名,团队,成员数,总分,AC 数,A,B');
    expect(lines[1]).toBe('1,Alpha,3,180,2,100,80');
    expect(lines[2]).toBe('2,Gamma,1,100,1,100,0');
  });

  it('quotes team names containing commas', () => {
    const csv = buildTeamRankingCsv([], [
      { ...rankingRows[0], teamName: 'Alpha, Team' },
    ]);
    expect(csv.split('\r\n')[1]).toBe('1,"Alpha, Team",3,180,2');
  });

  it('exports ACM teams with solved count and penalty instead of total score', () => {
    const problems: TeamRankingProblem[] = [
      { id: 11, ordinal: 1, points: 100, title: 'A 题' },
    ];
    const csv = buildTeamRankingCsv(problems, [
      { ...rankingRows[0], totalScore: 2, solved: 2, penalty: 43 },
    ], true);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('排名,团队,成员数,AC 数,罚时,A');
    expect(lines[1]).toBe('1,Alpha,3,2,43,100');
  });
});
