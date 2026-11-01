// When the daemon may be restarted: by `agentdeck restart` (from outside) and by reload_on_change (from inside).
import { plural } from '../text.ts';

export interface Activity {
  /** Tasks with a live run. */
  tasks: number;
  /** Planner runs still going. */
  planner: number;
  /** Resolve runs still going (they belong to done tasks, so `tasks` doesn't count them). */
  resolves: number;
}

/** What a graceful restart is waiting for, or null when nothing is active. */
export function restartWait({ tasks, planner, resolves }: Activity): string | null {
  const parts = [];
  if (tasks) parts.push(plural(tasks, 'running task'));
  if (resolves) parts.push(plural(resolves, 'resolve run'));
  if (planner) parts.push(plural(planner, 'planner run'));
  return parts.length ? parts.join(' and ') : null;
}

/** A source change must sit this long without another one before the daemon restarts onto it. */
export const RELOAD_QUIET_MS = 1500;

export interface ReloadInput {
  enabled: boolean;
  /** Files changed since the daemon started (newest last). */
  changed: readonly string[];
  /** When the latest change happened, ms since the epoch. */
  lastChangeAt: number | null;
  now: number;
  /** What is running now. */
  activity: Activity;
  /** Someone asked for a restart (the dashboard's button), whatever the setting or the files say. */
  requested?: boolean;
}

export interface ReloadDecision {
  /** New work should not start: the code on disk is newer than the code running. */
  pending: boolean;
  /** Exit now so launchd starts the new code. */
  exit: boolean;
  /** Why, for the log. */
  reason: string;
}

export function reloadDecision(i: ReloadInput): ReloadDecision {
  const wait = restartWait(i.activity);
  if (i.requested) {
    return wait
      ? { pending: true, exit: false, reason: `restart requested; restarting once ${wait} finish` }
      : { pending: true, exit: true, reason: 'restart requested and nothing is running; exiting so launchd starts the new code' };
  }
  if (!i.enabled || !i.changed.length) return { pending: false, exit: false, reason: '' };
  const last = i.changed[i.changed.length - 1];
  const what = i.changed.length === 1 ? last : `${last} and ${i.changed.length - 1} more`;
  if (wait) return { pending: true, exit: false, reason: `source changed (${what}); reloading once ${wait} finish` };
  if (i.lastChangeAt !== null && i.now - i.lastChangeAt < RELOAD_QUIET_MS)
    return { pending: true, exit: false, reason: `source changed (${what}); waiting for edits to settle` };
  return { pending: true, exit: true, reason: `source changed (${what}) and nothing is running; exiting so launchd starts the new code` };
}
