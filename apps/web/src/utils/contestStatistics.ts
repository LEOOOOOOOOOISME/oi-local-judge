import { apiGet } from '../api/client';
import type { ContestStatistics } from '../api/types';

/**
 * GET /api/contests/:id/statistics. `includeHidden` is only accepted for
 * admins/contest managers; the dashboard only sets it for those roles.
 */
export function fetchContestStatistics(
  contestId: number,
  includeHidden = false,
): Promise<ContestStatistics> {
  const query = includeHidden ? '?includeHidden=1' : '';
  return apiGet<ContestStatistics>(`/api/contests/${contestId}/statistics${query}`);
}
