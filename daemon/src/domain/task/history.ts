// A task's history: one row per status change. Pure: no I/O.
import type { PrState } from '../pull-request/pr.ts';
import type { TaskEvent, TaskStatus } from './lifecycle.ts';

/**
 * `created` when the task was added, `merge` when its PR was merged from the app and `sync` when the base branch was
 * brought into the task's branch (the status stays as it was), `pr` when its pull request was opened, failed to open, was closed
 * or was seen merged or closed on GitHub (likewise), `plan_unfinished` when a done run left linked plan steps
 * unfinished (a warning, the status stays as it was), `environment_block` when a run blocked because of the environment and
 * its attempt was given back, otherwise the lifecycle event that changed its status.
 */
export type TaskEventType = 'created' | 'merge' | 'pr' | 'sync' | 'plan_unfinished' | 'environment_block' | TaskEvent['type'];

/** What happened to a task's pull request. `seen` is what GitHub says about an open one. */
export type PrEvent =
  { type: 'opened'; url: string } | { type: 'failed'; error: string } | { type: 'closed' } | { type: 'seen'; state: PrState };

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
