// Runs: syncing a task's branch, verify runs and the run log.
import { API_BASE, post, qs } from '#api/http.ts';
import type { SyncResult, VerifyResult } from '#api/types.ts';

export const runsApi = {
  sync: (id: number) => post<SyncResult>(`/api/tasks/${id}/sync`),
  verify: (id: number) => post<VerifyResult>(`/api/tasks/${id}/verify`),
  logUrl: (id: number, runId?: number) => `${API_BASE}/api/tasks/${id}/log${qs({ run: runId || null })}`,
};
