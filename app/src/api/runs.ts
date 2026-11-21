// Runs: syncing a task's branch, verify runs and the run log.
import { queryOptions } from '@tanstack/vue-query';
import { API_BASE, get, post, qs } from '#api/http.ts';
import type { LiveRun, SyncResult, VerifyResult } from '#api/types.ts';

const LIVE_RUNS_POLL_MS = 2_000;

export const runsApi = {
  live: () => get<LiveRun[]>('/api/runs/live'),
  sync: (id: number) => post<SyncResult>(`/api/tasks/${id}/sync`),
  verify: (id: number) => post<VerifyResult>(`/api/tasks/${id}/verify`),
  logUrl: (id: number, runId?: number) => `${API_BASE}/api/tasks/${id}/log${qs({ run: runId || null })}`,
};

export const liveRunsQuery = () =>
  queryOptions({ queryKey: ['runs', 'live'] as const, queryFn: runsApi.live, refetchInterval: LIVE_RUNS_POLL_MS });
