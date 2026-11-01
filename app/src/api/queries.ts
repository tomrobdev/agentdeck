// The dashboard's server data as TanStack Query keys and options. App.vue reads them with useQuery.
import { queryOptions } from '@tanstack/vue-query';
import { ApiError, api } from './client.ts';

export const queryKeys = {
  status: ['status'] as const,
  tasks: ['tasks'] as const,
  task: (id: number) => ['task', id] as const,
  repos: ['repos'] as const,
};

/** True for the error `call` throws when the daemon can't be reached. */
export const isOffline = (e: unknown) => e instanceof ApiError && e.message === 'offline';

/** Offline is handled by the offline screen, which keeps polling status: don't retry it here. */
export const retryQuery = (failures: number, e: unknown) => !isOffline(e) && failures < 2;

export const statusQuery = () => queryOptions({ queryKey: queryKeys.status, queryFn: api.status });
export const tasksQuery = () => queryOptions({ queryKey: queryKeys.tasks, queryFn: api.tasks });
export const taskQuery = (id: number) => queryOptions({ queryKey: queryKeys.task(id), queryFn: () => api.task(id) });
export const reposQuery = () => queryOptions({ queryKey: queryKeys.repos, queryFn: api.repos });
