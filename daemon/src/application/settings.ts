// Use cases for the daemon as a whole: pause, status, and settings.
import type { Db } from '../db/index.ts';
import { NOTIFY_KINDS, type NotifyKind, type NotifySettings } from '../domain/notification.ts';
import { MODELS, type PlannerSettings } from '../domain/planner/plan.ts';
import { BUDGET_KEYS, type Budget, validateBudget } from '../domain/usage/governor.ts';
import { restartWait } from '../domain/daemon/restart.ts';
import { ActionError } from './errors.ts';
import { startGate } from './gate.ts';
import { notify } from './notifications.ts';
import { queueHolds } from './queue.ts';

export function setPaused(db: Db, paused: boolean): void {
  db.setPaused(paused);
  if (!paused) db.setRateLimitedUntil(0);
}

/** Which code the daemon is running, recorded once at start. */
export interface DaemonInfo {
  /** The commit of the daemon's checkout; null when it is not a git checkout. */
  commit: string | null;
  started_at: string;
}

export function status(db: Db, daemon: DaemonInfo = { commit: null, started_at: new Date(0).toISOString() }) {
  const gate = startGate(db);
  return {
    daemon,
    paused: gate.paused,
    rate_limited_until: gate.rate_limited_until,
    running: db.countRunning(),
    max_concurrent: db.maxConcurrent(),
    counts: db.countByStatus(),
    review: db.countReview(),
    usage: db.usageWindows(),
    governor: gate.governor,
    budget: db.budget(),
    notifications: db.recentNotifications(10),
    ...queueHolds(db),
  };
}

/**
 * Ask the daemon to exit so launchd starts it on the code on disk. It exits once nothing is running;
 * `waiting` says what it is waiting for, or null when it is exiting now.
 */
export function restartDaemon(db: Db, request: () => void): { waiting: string | null } {
  request();
  return {
    waiting: restartWait({ tasks: db.countRunning(), planner: db.countRunningPlannerRuns(), resolves: db.countRunningResolves() }),
  };
}

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: NotifySettings;
  planner: PlannerSettings;
  /** Restart the daemon onto new code when daemon/src changes and nothing is running. */
  reload_on_change: boolean;
}

export function getSettings(db: Db): Settings {
  return {
    max_concurrent: db.maxConcurrent(),
    budget: db.budget(),
    notify: db.notifySettings(),
    planner: db.plannerSettings(),
    reload_on_change: db.reloadOnChange(),
  };
}

/** Apply a partial settings update after validating all of it. */
export function updateSettings(
  db: Db,
  patch: {
    max_concurrent?: number;
    budget?: Partial<Budget>;
    notify?: Partial<NotifySettings>;
    planner?: Partial<PlannerSettings>;
    reload_on_change?: boolean;
  },
): Settings {
  const writes: [string, string][] = [];

  if (patch.reload_on_change !== undefined) writes.push(['reload_on_change', patch.reload_on_change ? '1' : '0']);

  if (patch.max_concurrent !== undefined) {
    const n = Number(patch.max_concurrent);
    if (!Number.isInteger(n) || n < 1 || n > 8) throw new ActionError('max_concurrent must be a whole number from 1 to 8');
    writes.push(['max_concurrent', String(n)]);
  }

  if (patch.budget) {
    const merged = { ...db.budget() };
    for (const k of BUDGET_KEYS) if (patch.budget[k] !== undefined) merged[k] = Number(patch.budget[k]);
    const err = validateBudget(merged);
    if (err) throw new ActionError(err);
    for (const k of BUDGET_KEYS) writes.push([k, String(merged[k])]);
  }

  if (patch.notify) {
    const n = patch.notify;
    if (n.desktop !== undefined) writes.push(['notify_desktop', n.desktop ? '1' : '0']);
    if (n.events !== undefined) {
      const bad = n.events.filter((e) => !NOTIFY_KINDS.includes(e as NotifyKind));
      if (bad.length) throw new ActionError(`unknown notification events: ${bad.join(', ')}`);
      writes.push(['notify_events', n.events.join(',')]);
    }
    if (n.ntfy_topic !== undefined) {
      const topic = n.ntfy_topic.trim();
      if (topic && !/^[\w-]{1,64}$/.test(topic)) throw new ActionError('ntfy topic: letters, digits, - and _ only');
      writes.push(['ntfy_topic', topic]);
    }
    if (n.ntfy_server !== undefined) {
      if (!/^https?:\/\/\S+$/.test(n.ntfy_server)) throw new ActionError('ntfy server must be an http(s) URL');
      writes.push(['ntfy_server', n.ntfy_server]);
    }
  }

  if (patch.planner) {
    const p = patch.planner;
    if (p.enabled !== undefined) writes.push(['planner_enabled', p.enabled ? '1' : '0']);
    if (p.interval_hours !== undefined) {
      const h = Number(p.interval_hours);
      if (!(h >= 0.25 && h <= 168)) throw new ActionError('planner interval must be between 0.25 and 168 hours');
      writes.push(['planner_interval_hours', String(h)]);
    }
    if (p.max_tasks !== undefined) {
      const n = Number(p.max_tasks);
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new ActionError('planner max tasks must be a whole number from 1 to 10');
      writes.push(['planner_max_tasks', String(n)]);
    }
    if (p.model !== undefined) {
      if (!MODELS.includes(p.model)) throw new ActionError(`planner model must be one of ${MODELS.join(', ')}`);
      writes.push(['planner_model', p.model]);
    }
  }

  for (const [k, v] of writes) db.setSetting(k, v);
  return getSettings(db);
}

export function sendTestNotification(db: Db): Promise<void> {
  return notify(db, { kind: 'test', title: 'Test notification', body: 'Notifications from AgentDeck are working.' });
}
