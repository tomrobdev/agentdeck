// A task's history: one row per status change. Pure: no I/O.
import type { TaskEvent, TaskStatus } from './lifecycle.ts';

/** `created` when the task was added, otherwise the lifecycle event that changed its status. */
export type TaskEventType = 'created' | TaskEvent['type'];

export interface TaskEventRow {
  id: number;
  task_id: number;
  type: TaskEventType;
  from_status: TaskStatus | null; // null for 'created'
  to_status: TaskStatus | null;
  reason: string | null;
  at: string;
}
