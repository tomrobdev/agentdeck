// Use cases for the daemon as a whole: pause, status, and settings.
import type { Db } from '../db/index.ts';
import { type NotifyKind, type NotifySettings, notifyEventsError, ntfyServerError, ntfyTopicError } from '../domain/notification.ts';
import { type PlannerSettings, plannerIntervalError, plannerMaxTasksError, plannerModelError } from '../domain/planner/proposals.ts';
import { BUDGET_KEYS, type Budget, validateBudget, validateSlots } from '../domain/usage/governor.ts';
import { restartWait } from '../domain/daemon/restart.ts';
import type { MergeMethod } from '../domain/pull-request/merge.ts';
import type { PrMode } from '../domain/pull-request/pr.ts';
import { ActionError, flag, list, number, object, refuse, text, whole } from './input.ts';
import { startGate } from './gate.ts';
import { notify } from './notifications.ts';
import { queueWaits } from './queue.ts';
import type { RepoPatch } from './repos.ts';

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
    ...queueWaits(db),
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

export interface SettingsPatch {
  max_concurrent?: number;
  budget?: Partial<Budget>;
  notify?: Partial<NotifySettings>;
  planner?: Partial<PlannerSettings>;
  reload_on_change?: boolean;
}

const ON = ['1', 'on', 'true', 'yes'];
const OFF = ['0', 'off', 'false', 'no'];
const on = (v: string) => ON.includes(v.toLowerCase());

/** The patch `agentdeck set <key> <value>` stands for. Throws ActionError for a key it does not know. */
export function settingPatch(key: string | undefined, value: string): SettingsPatch {
  if (key === 'max_concurrent') return { max_concurrent: Number(value) };
  if (key && (BUDGET_KEYS as string[]).includes(key)) return { budget: { [key]: Number(value) } };
  if (key === 'notify_desktop') return { notify: { desktop: on(value) } };
  if (key === 'notify_events') return { notify: { events: value.split(',').filter(Boolean) as NotifyKind[] } };
  if (key === 'ntfy_topic' || key === 'ntfy_server') return { notify: { [key]: value } };
  if (key === 'reload_on_change') return { reload_on_change: on(value) };
  if (key === 'planner_enabled') return { planner: { enabled: on(value) } };
  if (key === 'planner_interval_hours') return { planner: { interval_hours: Number(value) } };
  if (key === 'planner_max_tasks') return { planner: { max_tasks: Number(value) } };
  if (key === 'planner_model') return { planner: { model: value } };
  throw new ActionError(`unknown setting "${key}"; see agentdeck help`);
}

const REPO_SETTING_USAGE =
  'usage: agentdeck repo set <repo> auto_approve on|off | auto_resolve on|off | base_branch <branch> | test_cmd "<cmd>" | setup_cmd "<cmd>" | pr_mode off|draft|ready | merge_method squash|merge|rebase | sandbox on|off | network "<hosts>"';

/** The patch `agentdeck repo set <repo> <key> <value>` stands for. Throws ActionError for a key it does not know. */
export function repoSettingPatch(key: string | undefined, value: string): RepoPatch {
  if (key === 'pr_mode') return { pr_mode: value as PrMode };
  if (key === 'merge_method') return { merge_method: value as MergeMethod };
  if (key === 'auto_approve') return { auto_approve: on(value) };
  if (key === 'auto_resolve') return { auto_resolve: on(value) };
  if (key === 'sandbox') {
    if (![...ON, ...OFF].includes(value.toLowerCase())) throw new ActionError('usage: agentdeck repo set <repo> sandbox on|off');
    return { sandbox: on(value) };
  }
  if (key === 'network') return { network: value };
  if (key === 'base_branch') return { base_branch: value };
  if (key === 'setup_cmd') return { setup_cmd: value };
  if (key === 'test_cmd') return { test_cmd: value };
  throw new ActionError(REPO_SETTING_USAGE);
}

/** Apply a partial settings update after validating all of it. */
export function updateSettings(db: Db, patch: SettingsPatch): Settings {
  const writes: [string, string][] = [];
  const body = object(patch);
  const section = (key: string) => (body[key] === undefined ? undefined : object(body[key]));

  const reload = flag(body, 'reload_on_change');
  if (reload !== undefined) writes.push(['reload_on_change', reload ? '1' : '0']);

  const maxConcurrent = whole(body, 'max_concurrent', validateSlots);
  if (maxConcurrent !== undefined) writes.push(['max_concurrent', String(maxConcurrent)]);

  const budget = section('budget');
  if (budget) {
    const merged = { ...db.budget() };
    for (const k of BUDGET_KEYS) {
      const value = number(budget, k);
      if (value !== undefined) merged[k] = value;
    }
    const err = validateBudget(merged);
    if (err) throw new ActionError(err);
    for (const k of BUDGET_KEYS) writes.push([k, String(merged[k])]);
  }

  const n = section('notify');
  if (n) {
    const desktop = flag(n, 'desktop');
    if (desktop !== undefined) writes.push(['notify_desktop', desktop ? '1' : '0']);
    const events = list(n, 'events');
    if (events !== undefined) {
      refuse(notifyEventsError(events));
      writes.push(['notify_events', events.join(',')]);
    }
    const topic = text(n, 'ntfy_topic', { empty: true });
    if (topic !== undefined) {
      refuse(ntfyTopicError(topic));
      writes.push(['ntfy_topic', topic]);
    }
    const server = text(n, 'ntfy_server', { empty: true, raw: true });
    if (server !== undefined) {
      refuse(ntfyServerError(server));
      writes.push(['ntfy_server', server]);
    }
  }

  const p = section('planner');
  if (p) {
    const enabled = flag(p, 'enabled');
    if (enabled !== undefined) writes.push(['planner_enabled', enabled ? '1' : '0']);
    const hours = number(p, 'interval_hours');
    if (hours !== undefined) {
      refuse(plannerIntervalError(hours));
      writes.push(['planner_interval_hours', String(hours)]);
    }
    const maxTasks = number(p, 'max_tasks');
    if (maxTasks !== undefined) {
      refuse(plannerMaxTasksError(maxTasks));
      writes.push(['planner_max_tasks', String(maxTasks)]);
    }
    const model = text(p, 'model', { empty: true, raw: true });
    if (model !== undefined) {
      refuse(plannerModelError(model));
      writes.push(['planner_model', model]);
    }
  }

  for (const [k, v] of writes) db.setSetting(k, v);
  return getSettings(db);
}

export function sendTestNotification(db: Db): Promise<void> {
  return notify(db, { kind: 'test', title: 'Test notification', body: 'Notifications from AgentDeck are working.' });
}
