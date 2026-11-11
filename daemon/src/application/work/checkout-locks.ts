// The locks on a task's checkout in this process: a sync of its branch (`runs/sync.ts`) and a merge of its PR (`landing/merge.ts`).
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import { ActionError } from '#application/shared/input.ts';

const merging = new Set<TaskId>();

export const isMergeLocked = (id: TaskId): boolean => merging.has(id);

export function lockMerge(id: TaskId): boolean {
  if (merging.has(id)) return false;
  merging.add(id);
  return true;
}

export const unlockMerge = (id: TaskId): void => void merging.delete(id);

const syncing = new Set<TaskId>();

export const isSyncLocked = (id: TaskId): boolean => syncing.has(id);

export const lockSync = (id: TaskId): void => void syncing.add(id);

export const unlockSync = (id: TaskId): void => void syncing.delete(id);

export const isSyncing = (app: App, id: TaskId): boolean => app.hasSyncMarker(id);

export function refuseWhileSyncing(app: App, id: TaskId): void {
  if (isSyncing(app, id)) throw new ActionError(`#${id} is syncing with its base branch; try again when that is done`);
}

export async function markSyncing<T>(app: App, id: TaskId, fn: () => Promise<T>): Promise<T> {
  app.setSyncing(id, true);
  try {
    return await fn();
  } finally {
    app.setSyncing(id, false);
  }
}
