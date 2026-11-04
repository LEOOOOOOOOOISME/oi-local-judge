import type {
  TeamMode,
  TeamRankingProblem,
  TeamRankingRow,
  TeamSummary,
} from '../api/types';
import { rankingProblemLetter } from './ranking';

/** 比赛报名模式在管理端/比赛页的展示文案。 */
export const TEAM_MODE_LABEL: Record<TeamMode, string> = {
  individual: '个人赛',
  team: '团队赛',
  both: '个人/团队均可',
};

export const TEAM_MODE_OPTIONS: Array<{ value: TeamMode; label: string }> = [
  { value: 'individual', label: TEAM_MODE_LABEL.individual },
  { value: 'team', label: TEAM_MODE_LABEL.team },
  { value: 'both', label: TEAM_MODE_LABEL.both },
];

interface TeamModeCarrier {
  team_mode?: TeamMode | null;
  teamMode?: TeamMode | null;
}

/**
 * 读取比赛的报名模式。
 *
 * 后端列表/详情接口返回数据库行（snake_case `team_mode`）；已做 DTO 映射的接口可能
 * 返回 camelCase `teamMode`。旧后端与旧比赛没有该字段，按 individual 处理。
 */
export function resolveTeamMode(contest: TeamModeCarrier | null | undefined): TeamMode {
  const mode = contest?.team_mode ?? contest?.teamMode;
  return mode === 'team' || mode === 'both' ? mode : 'individual';
}

export function teamModeLabel(mode: TeamMode | string | null | undefined): string {
  return TEAM_MODE_LABEL[(mode as TeamMode) ?? 'individual'] ?? String(mode);
}

/** 该比赛是否开放团队报名（team / both）。 */
export function acceptsTeamRegistration(mode: TeamMode): boolean {
  return mode !== 'individual';
}

/** 当前用户担任队长的团队；非队长为空数组，用于决定是否显示报名按钮。 */
export function captainTeams(teams: TeamSummary[]): TeamSummary[] {
  return teams.filter((team) => team.role === 'captain');
}

/**
 * 管理端按“团队 ID 或团队名”添加报名时的解析。
 *
 * 只做精确匹配（团队名唯一）：纯数字按 ID，其余按去除首尾空白后的完整团队名。
 * 未命中返回 null；未知的纯数字可在调用处直接当作 ID 交给后端校验。
 */
export function findTeamByIdOrName(
  teams: TeamSummary[],
  input: string,
): TeamSummary | null {
  const raw = input.trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) {
    const id = Number(raw);
    return teams.find((team) => team.id === id) ?? null;
  }
  return teams.find((team) => team.name === raw) ?? null;
}

/** 管理端手动 ID 兜底：纯数字（且为正整数）才解析为团队 ID，否则返回 null。 */
export function parseTeamIdInput(input: string): number | null {
  const raw = input.trim();
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * 团队榜 CSV：名次/团队/成员数/总分（ACM/CF-like 为 AC 数/罚时）/AC 数/各题得分。
 */
export function buildTeamRankingCsv(
  problems: Array<Pick<TeamRankingProblem, 'id'>>,
  rows: TeamRankingRow[],
  acmStyle = false,
): string {
  const header = [
    '排名',
    '团队',
    '成员数',
    ...(acmStyle ? ['AC 数', '罚时'] : ['总分', 'AC 数']),
    ...problems.map((_problem, index) => rankingProblemLetter(index)),
  ];
  const lines = rows.map((row) => [
    String(row.rank),
    row.teamName,
    String(row.memberCount),
    ...(acmStyle
      ? [String(row.solved), String(row.penalty)]
      : [String(row.totalScore), String(row.solved)]),
    ...problems.map(
      (problem) => String(row.cells.find((cell) => cell.problemId === problem.id)?.score ?? 0),
    ),
  ]);
  return [header, ...lines]
    .map((line) => line.map((cell) => csvCell(cell)).join(','))
    .join('\r\n');
}
