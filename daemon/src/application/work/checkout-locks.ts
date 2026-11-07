// The locks on a task's checkout in this process: a sync of its branch (`runs/sync.ts`) and a merge of its PR
// (`landing/merge.ts`). Apart, here in Work, so that the use cases of every context can read them without a cycle.
import type { Db } from '../../db/index.ts';
import type { TaskId } from '../../domain/shared/id.ts';
import { ActionError } from '../shared/input.ts';

/** The tasks whose PR this process is merging right now. */
const merging = new Set<TaskId>();

/** Whether a merge of this task's PR is under way in this process. */
export const isMergeLocked = (id: TaskId): boolean => merging.has(id);

/** Take the merge lock; false when a merge of the task is already under way. */
export function lockMerge(id: TaskId): boolean {
  if (merging.has(id)) return false;
  merging.add(id);
  return true;
}

export const unlockMerge = (id: TaskId): void => void merging.delete(id);

/** The lock against two syncs of one task in the daemon (the database's marker is what other processes read). */
const syncing = new Set<TaskId>();

/** Whether a sync in this process holds the task's worktree (the in-process half of `isSyncing`, no query). */
export const isSyncLocked = (id: TaskId): boolean => syncing.has(id);

/** Take the sync lock for a sync this process starts. */
export const lockSync = (id: TaskId): void => void syncing.add(id);

export const unlockSync = (id: TaskId): void => void syncing.delete(id);

/** Whether a sync of this task's branch is running, in any process: the marker the daemon keeps in the database. */
export const isSyncing = (db: Db, id: TaskId): boolean => db.hasSyncMarker(id);

/** Refuse a change to a task while a sync of its branch is running. */
export function refuseWhileSyncing(db: Db, id: TaskId): void {
  if (isSyncing(db, id)) throw new ActionError(`#${id} is syncing with its base branch; try again when that is done`);
}

/** Run `fn` with the task's sync marked in the database, so the CLI sees it too; the mark is cleared however `fn` ends. */
export async function markSyncing<T>(db: Db, id: TaskId, fn: () => Promise<T>): Promise<T> {
  db.setSyncing(id, true);
  try {
    return await fn();
  } finally {
    db.setSyncing(id, false);
  }
}
