// Use cases for the daemon as a whole: pause, status, and settings.
import type { App } from '../ports/app.ts';
import { type NotifyKind, type NotifySettings, notifyEventsError, ntfyServerError, ntfyTopicError } from '../../domain/operations/index.ts';
import { type PlannerSettings, plannerIntervalError, plannerMaxTasksError, plannerModelError } from '../../domain/proposals/index.ts';
import { BUDGET_KEYS, type Budget, validateBudget, validateSlots } from '../../domain/capacity/index.ts';
import { ATTENTION_LIMIT, headline } from '../../domain/operations/index.ts';
import type { DaemonState } from '../../domain/operations/index.ts';
import { type ReloadInput, reloadState, restartWait } from '../../domain/operations/index.ts';
import type { ReviewDueSettings, Settings } from '../../domain/operations/index.ts';
import { reviewDueDaysError, reviewDueLinesError } from '../../domain/operations/index.ts';
import { modelError } from '../../domain/work/index.ts';
import { flag, list, number, object, refuse, text, whole } from '../shared/input.ts';
import { startGate } from '../capacity/gate.ts';
import { notify } from './notifications.ts';
import { queueWaits } from '../capacity/queue.ts';
import { runningActivity } from './restart.ts';

export function setPaused(app: App, paused: boolean): void {
  app.setPaused(paused);
  if (!paused) app.setRateLimitedUntil(0);
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
export function daemonState(app: App, info: DaemonInfo, facts: ReloadFacts): DaemonState {
  return {
    ...info,
    reload: reloadState({
      ...facts,
      enabled: app.reloadOnChange(),
      now: Date.now(),
      activity: runningActivity(app),
    }),
  };
}

export function status(app: App, daemon: DaemonInfo = { commit: null, started_at: new Date(0).toISOString(), pid: process.pid }) {
  const gate = startGate(app);
  const counts = app.countByStatus();
  const review = app.countReview();
  return {
    daemon,
    paused: gate.paused,
    rate_limited_until: gate.rate_limited_until,
    running: app.countRunning(),
    max_concurrent: app.maxConcurrent(),
    counts,
    review,
    headline: headline(
      {
        paused: gate.paused,
        rate_limited_until: gate.rate_limited_until,
        governor: gate.governor,
        running: app.countRunning(),
        need_you: { proposed: counts.proposed ?? 0, blocked: counts.blocked ?? 0, review },
        attention: app.attentionTasks(ATTENTION_LIMIT),
        review_due: app.reviewsDue(),
      },
      Date.now() / 1000,
    ),
    usage: app.usageWindows(),
    governor: gate.governor,
    budget: app.budget(),
    notifications: app.recentNotifications(10),
    planning: app.unfinishedPlannerRuns(),
    ...queueWaits(app),
  };
}

/**
 * Ask the daemon to exit so launchd starts it on the code on disk. It exits once nothing is running;
 * `waiting` says what it is waiting for, or null when it is exiting now.
 */
export function restartDaemon(app: App, request: () => void): { waiting: string | null } {
  request();
  return { waiting: restartWait(runningActivity(app)) };
}

export type { Settings };

export function getSettings(app: App): Settings {
  return app.readSettings();
}

export interface SettingsPatch {
  max_concurrent?: number;
  budget?: Partial<Budget>;
  notify?: Partial<NotifySettings>;
  planner?: Partial<PlannerSettings>;
  default_model?: string;
  support_model?: string;
  reload_on_change?: boolean;
  review_due?: Partial<ReviewDueSettings>;
}

/** Apply a partial settings update after validating all of it. */
export function updateSettings(app: App, patch: SettingsPatch): Settings {
  const next = app.readSettings();
  const body = object(patch);
  const section = (key: string) => (body[key] === undefined ? undefined : object(body[key]));

  next.reload_on_change = flag(body, 'reload_on_change') ?? next.reload_on_change;
  next.max_concurrent = whole(body, 'max_concurrent', validateSlots) ?? next.max_concurrent;
  for (const key of ['default_model', 'support_model'] as const) {
    const model = text(body, key);
    refuse(modelError(model));
    next[key] = model ?? next[key];
  }

  const budget = section('budget');
  if (budget) {
    for (const k of BUDGET_KEYS) next.budget[k] = number(budget, k) ?? next.budget[k];
    refuse(validateBudget(next.budget));
  }

  const n = section('notify');
  if (n) {
    next.notify.desktop = flag(n, 'desktop') ?? next.notify.desktop;
    const events = list(n, 'events')
      ?.map((e) => e.trim())
      .filter(Boolean);
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
    next.planner.max_tasks = whole(p, 'max_tasks', (v) => plannerMaxTasksError(v as number)) ?? next.planner.max_tasks;
    const model = text(p, 'model', { empty: true, raw: true });
    if (model !== undefined) {
      refuse(plannerModelError(model));
      next.planner.model = model;
    }
  }

  const r = section('review_due');
  if (r) {
    next.review_due.days = whole(r, 'days', (v) => reviewDueDaysError(v as number)) ?? next.review_due.days;
    next.review_due.lines = whole(r, 'lines', (v) => reviewDueLinesError(v as number)) ?? next.review_due.lines;
  }

  app.writeSettings(next);
  return getSettings(app);
}

/** POST /api/app/seen: the desktop app is running, so it shows desktop notifications for the next 90 s. Says whether they are on. */
export function appSeen(app: App, now = Date.now()): { desktop: boolean } {
  app.setAppSeenAt(now);
  return { desktop: app.notifySettings().desktop };
}

export function sendTestNotification(app: App): Promise<void> {
  return notify(app, { kind: 'test', title: 'Test notification', body: 'Notifications from AgentDeck are working.' });
}

/** How many tasks are running now. */
export const runningCount = (app: App): number => app.countRunning();

/** Whether a person has paused the daemon. */
export const isPaused = (app: App): boolean => app.isPaused();

/** Whether the daemon restarts itself onto changed source. */
export const reloadOnChange = (app: App): boolean => app.reloadOnChange();

/** How many tasks may run at once. */
export const maxConcurrent = (app: App): number => app.maxConcurrent();
