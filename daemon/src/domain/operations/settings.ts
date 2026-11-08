// The settings a person can change. Pure: no I/O.
import type { NotifySettings } from './notification.ts';
import type { PlannerSettings } from '../proposals/index.ts';
import type { Budget } from '../capacity/index.ts';

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: NotifySettings;
  planner: PlannerSettings;
  /** The model a new task takes when neither it nor its repo names one. */
  default_model: string;
  /** The model resolve and unblock runs use, in place of their task's (`runModel` in domain/runs/run.ts). */
  support_model: string;
  /** Restart the daemon onto new code when daemon/src changes and nothing is running. */
  reload_on_change: boolean;
}
