// A task's history: one row per status change. Pure: no I/O.
import type { TaskEvent, TaskStatus } from './lifecycle.ts';

/**
 * `created` when the task was added, `merge` when its PR was merged from the app and `sync` when the base branch was
 * brought into the task's branch (the status stays as it was), otherwise the lifecycle event that changed its status.
 */
export type TaskEventType = 'created' | 'merge' | 'sync' | TaskEvent['type'];

export interface TaskEventRow {
  id: number;
  task_id: number;
  type: TaskEventType;
  from_status: TaskStatus | null; // null for 'created'
  to_status: TaskStatus | null;
  reason: string | null;
  at: string;
}

/** The note on the task's latest retry ("changes requested in review"), or null if that retry had none. */
export function latestReviewNote(events: Pick<TaskEventRow, 'type' | 'reason'>[]): string | null {
  return events.findLast((e) => e.type === 'retry')?.reason ?? null;
}
