// Use cases for the daemon as a whole: pause, status, and settings.
import type { Db } from '../db/index.ts';
import { type NotifyKind, type NotifySettings, notifyEventsError, ntfyServerError, ntfyTopicError } from '../domain/notification.ts';
import { type PlannerSettings, plannerIntervalError, plannerMaxTasksError, plannerModelError } from '../domain/planner/proposals.ts';
import { BUDGET_KEYS, type Budget, validateBudget, validateSlots } from '../domain/usage/governor.ts';
import type { DaemonState } from '../domain/daemon/health.ts';
import { type ReloadInput, reloadState, restartWait } from '../domain/daemon/restart.ts';
import type { MergeMethod } from '../domain/pull-request/merge.ts';
import type { PrMode } from '../domain/pull-request/pr.ts';
import type { Settings } from '../domain/settings/settings.ts';
import { ActionError, flag, list, number, object, refuse, text, whole } from './input.ts';
import { startGate } from './scheduler/gate.ts';
import { notify } from './notifications.ts';
import { queueWaits } from './scheduler/queue.ts';
import type { RepoPatch } from './repo/repos.ts';

export function setPaused(db: Db, paused: boolean): void {
  db.setPaused(paused);
  if (!paused) db.setRateLimitedUntil(0);
}

/** Which code the daemon is running, recorded once at start. */
export interface DaemonInfo {
  /** The commit of the daemon's checkout; null when it is not a git checkout. */
  commit: string | null;
  started_at: string;
  pid: number;
}

/** The facts of the daemon's reload that only its process knows (the rest comes from the database). */
export type ReloadFacts = Pick<ReloadInput, 'changed' | 'lastChangeAt' | 'requested' | 'blocked'>;

/** GET /api/daemon: the code the daemon loaded, since when and as which process, and where a reload stands. */
export function daemonState(db: Db, info: DaemonInfo, facts: ReloadFacts): DaemonState {
  return {
    ...info,
    reload: reloadState({
      ...facts,
      enabled: db.reloadOnChange(),
      now: Date.now(),
      activity: { tasks: db.countRunning(), planner: db.countRunningPlannerRuns(), resolves: db.countRunningResolves() },
    }),
  };
}

export function status(db: Db, daemon: DaemonInfo = { commit: null, started_at: new Date(0).toISOString(), pid: process.pid }) {
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
    planning: db.unfinishedPlannerRuns(),
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

export type { Settings };

export function getSettings(db: Db): Settings {
  return db.readSettings();
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
  'usage: agentdeck repo set <repo> auto_approve on|off | auto_resolve on|off | base_branch <branch> | test_cmd "<cmd>" | setup_cmd "<cmd>" | pr_mode off|draft|ready | merge_method squash|merge|rebase | sandbox on|off | network "<hosts>" | auto_merge on|off | auto_merge_max_lines <n> | auto_merge_skip "<prefixes>"';

/** The patch `agentdeck repo set <repo> <key> <value>` stands for. Throws ActionError for a key it does not know. */
export function repoSettingPatch(key: string | undefined, value: string): RepoPatch {
  if (key === 'pr_mode') return { pr_mode: value as PrMode };
  if (key === 'merge_method') return { merge_method: value as MergeMethod };
  if (key === 'auto_approve') return { auto_approve: on(value) };
  if (key === 'auto_resolve') return { auto_resolve: on(value) };
  if (key === 'auto_merge') return { auto_merge: on(value) };
  if (key === 'auto_merge_max_lines') return { auto_merge_max_lines: Number(value) };
  if (key === 'auto_merge_skip') return { auto_merge_skip: value };
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
  const next = db.readSettings();
  const body = object(patch);
  const section = (key: string) => (body[key] === undefined ? undefined : object(body[key]));

  next.reload_on_change = flag(body, 'reload_on_change') ?? next.reload_on_change;
  next.max_concurrent = whole(body, 'max_concurrent', validateSlots) ?? next.max_concurrent;

  const budget = section('budget');
  if (budget) {
    for (const k of BUDGET_KEYS) next.budget[k] = number(budget, k) ?? next.budget[k];
    refuse(validateBudget(next.budget));
  }

  const n = section('notify');
  if (n) {
    next.notify.desktop = flag(n, 'desktop') ?? next.notify.desktop;
    const events = list(n, 'events');
    if (events !== undefined) {
      refuse(notifyEventsError(events));
      next.notify.events = events as NotifyKind[];
    }
    const topic = text(n, 'ntfy_topic', { empty: true });
    if (topic !== undefined) {
      refuse(ntfyTopicError(topic));
      next.notify.ntfy_topic = topic;
    }
    const server = text(n, 'ntfy_server', { empty: true, raw: true });
    if (server !== undefined) {
      refuse(ntfyServerError(server));
      next.notify.ntfy_server = server;
    }
  }

  const p = section('planner');
  if (p) {
    next.planner.enabled = flag(p, 'enabled') ?? next.planner.enabled;
    const hours = number(p, 'interval_hours');
    if (hours !== undefined) {
      refuse(plannerIntervalError(hours));
      next.planner.interval_hours = hours;
    }
    const maxTasks = number(p, 'max_tasks');
    if (maxTasks !== undefined) {
      refuse(plannerMaxTasksError(maxTasks));
      next.planner.max_tasks = maxTasks;
    }
    const model = text(p, 'model', { empty: true, raw: true });
    if (model !== undefined) {
      refuse(plannerModelError(model));
      next.planner.model = model;
    }
  }

  db.writeSettings(next);
  return getSettings(db);
}

export function sendTestNotification(db: Db): Promise<void> {
  return notify(db, { kind: 'test', title: 'Test notification', body: 'Notifications from AgentDeck are working.' });
}
