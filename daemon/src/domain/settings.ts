// The settings a person can change. Pure: no I/O.
import type { NotifySettings } from './notification.ts';
import type { PlannerSettings } from './planner/proposals.ts';
import type { Budget } from './usage/governor.ts';

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: NotifySettings;
  planner: PlannerSettings;
  /** Restart the daemon onto new code when daemon/src changes and nothing is running. */
  reload_on_change: boolean;
}
