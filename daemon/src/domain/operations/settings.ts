// The settings a person can change.
import type { NotifySettings } from '#domain/operations/notification.ts';
import type { PlannerSettings } from '#domain/proposals/index.ts';
import type { Budget } from '#domain/capacity/index.ts';
import type { ReviewDueSettings } from '#domain/operations/review-due.ts';

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: NotifySettings;
  planner: PlannerSettings;
  /** The model a new task takes when neither it nor its repo names one. */
  default_model: string;
  /** The model resolve and unblock runs use, in place of their task's (`runModel` in domain/runs/run.ts). */
  support_model: string;
  /** The model review runs use (`runModel` in domain/runs/run.ts); opus by default, a reviewer at least as strong as the worker. */
  review_model: string;
  /** Restart the daemon onto new code when daemon/src changes and nothing is running. */
  reload_on_change: boolean;
  /** When a repo is due for an area review (review_due_days, review_due_lines). */
  review_due: ReviewDueSettings;
  plan_branch_sync_minutes: number;
}
