// The lock on merging a task's PR in this process (a sync's lock is in `sync.ts`). Apart so both can read it without a cycle.
import type { TaskId } from '../../domain/shared/id.ts';

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
