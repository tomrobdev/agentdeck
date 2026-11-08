// When the daemon may be restarted: by `agentdeck restart` (from outside) and by reload_on_change (from inside).
import { plural } from '../shared/index.ts';

export interface Activity {
  /** Tasks with a live run. */
  tasks: number;
  /** Planner runs still going. */
  planner: number;
  /** Resolve runs still going (they belong to done tasks, so `tasks` doesn't count them). */
  resolves: number;
  /** Unblock runs still going (they belong to blocked tasks, so `tasks` doesn't count them). Missing means none. */
  unblocks?: number;
  /** Review runs still going (they belong to done tasks, so `tasks` doesn't count them). Missing means none. */
  reviews?: number;
}

/** What a graceful restart is waiting for, or null when nothing is active. */
export function restartWait({ tasks, planner, resolves, unblocks = 0, reviews = 0 }: Activity): string | null {
  const parts = [];
  if (tasks) parts.push(plural(tasks, 'running task'));
  if (resolves) parts.push(plural(resolves, 'resolve run'));
  if (unblocks) parts.push(plural(unblocks, 'unblock run'));
  if (reviews) parts.push(plural(reviews, 'review run'));
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
  /** Why the code on disk must not be loaded (an uncommitted migration step, a checkout off main), or null. */
  blocked?: string | null;
}

export interface ReloadDecision {
  /** New work should not start: the code on disk is newer than the code running. */
  pending: boolean;
  /** Exit now so launchd starts the new code. */
  exit: boolean;
  /** Why, for the log. */
  reason: string;
}

/** Why a reload is blocked, worded for the log and for `agentdeck doctor`, which tells the two apart by these. */
export const SCHEMA_DIRTY = 'db/schema.ts has uncommitted changes';
export const offMain = (branch: string): string => `the checkout is on ${branch}, not main`;

/** The reload as the API serves it: what a person needs to know about why the daemon is on old code. */
export interface ReloadState {
  /** reload_on_change is on. */
  enabled: boolean;
  /** The code on disk is newer than the code running, and a restart is coming. */
  pending: boolean;
  /** What the decision said, or null when there is nothing to say. */
  reason: string | null;
  /** What a pending reload waits for (running tasks, resolve runs), or null. */
  waiting: string | null;
  /** Why the code on disk must not be loaded, or null. */
  blocked: string | null;
  /** How many source files changed since the daemon started. */
  changed: number;
}

export function reloadState(i: ReloadInput): ReloadState {
  const d = reloadDecision(i);
  return {
    enabled: i.enabled,
    pending: d.pending,
    reason: d.reason || null,
    waiting: d.pending && !d.exit ? restartWait(i.activity) : null,
    // A requested restart goes ahead whatever blocks a reload on change.
    blocked: !i.requested && i.enabled && i.changed.length ? (i.blocked ?? null) : null,
    changed: i.changed.length,
  };
}

export function reloadDecision(i: ReloadInput): ReloadDecision {
  const wait = restartWait(i.activity);
  if (i.requested) {
    return wait
      ? { pending: true, exit: false, reason: `restart requested; restarting once ${wait} finish` }
      : { pending: true, exit: true, reason: 'restart requested and nothing is running; exiting so launchd starts the new code' };
  }
  if (!i.enabled || !i.changed.length) return { pending: false, exit: false, reason: '' };
  if (i.blocked) return { pending: false, exit: false, reason: `not reloading: ${i.blocked}` };
  const last = i.changed[i.changed.length - 1];
  const what = i.changed.length === 1 ? last : `${last} and ${i.changed.length - 1} more`;
  if (wait) return { pending: true, exit: false, reason: `source changed (${what}); reloading once ${wait} finish` };
  if (i.lastChangeAt !== null && i.now - i.lastChangeAt < RELOAD_QUIET_MS)
    return { pending: true, exit: false, reason: `source changed (${what}); waiting for edits to settle` };
  return { pending: true, exit: true, reason: `source changed (${what}) and nothing is running; exiting so launchd starts the new code` };
}
