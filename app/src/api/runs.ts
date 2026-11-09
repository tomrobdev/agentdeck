// Runs: syncing a task's branch, verify runs and the run log.
import { API_BASE, post, qs } from './http.ts';
import type { SyncResult, VerifyResult } from './types.ts';

export const runsApi = {
  /** Merge the base branch into the task's branch; a conflict starts a claude run, so this can take minutes. */
  sync: (id: number) => post<SyncResult>(`/api/tasks/${id}/sync`),
  /** Start a verify run on a proposed or queued task; the answer is at once, and the run's row says how it goes. */
  verify: (id: number) => post<VerifyResult>(`/api/tasks/${id}/verify`),
  logUrl: (id: number, runId?: number) => `${API_BASE}/api/tasks/${id}/log${qs({ run: runId || null })}`,
};
