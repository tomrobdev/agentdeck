// Insights: the scorecard.
import { queryOptions } from '@tanstack/vue-query';
import { get, qs } from '#api/http.ts';
import type { Stats } from '#api/types.ts';

export const insightsApi = {
  stats: (repo: string | null) => get<Stats>(`/api/stats${qs({ by: 'week', repo })}`),
};

export const statsQuery = (repo: string | null) =>
  queryOptions({ queryKey: ['stats', repo] as const, queryFn: () => insightsApi.stats(repo) });
