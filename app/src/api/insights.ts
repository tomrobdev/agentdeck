// Insights: the scorecard.
import { queryOptions } from '@tanstack/vue-query';
import { get, qs } from './http.ts';
import type { Stats } from './types.ts';

export const insightsApi = {
  /** The scorecard per week (what `agentdeck stats --by week --json` prints), for one repo name or all. */
  stats: (repo: string | null) => get<Stats>(`/api/stats${qs({ by: 'week', repo })}`),
};

/** The Insights page's report, per week, for one repo name or all (null). */
export const statsQuery = (repo: string | null) =>
  queryOptions({ queryKey: ['stats', repo] as const, queryFn: () => insightsApi.stats(repo) });
