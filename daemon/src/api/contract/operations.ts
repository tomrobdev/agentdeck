// Operations: the daemon, its status, settings and notifications, and the change stream.
import type { PlannerRunId, RepoId, TaskId } from '#domain/shared/index.ts';
import type { AttentionWhy, HeadlineState, NotifyKind, RepoReviewDue } from '#domain/operations/index.ts';
import type { TaskStatus } from '#domain/work/index.ts';
import type { QueueWait } from '#api/contract/work.ts';

export interface UsageWindow {
  window: string;
  utilization: number;
  resets_at: number;
  status: string | null;
  observed_at: string;
}

export interface Budget {
  five_hour_max: number;
  five_hour_soft: number;
  weekly_max: number;
  pace_slack: number;
}

export interface Decision {
  allow: boolean;
  max_concurrent: number;
  reason: string | null;
  until: number | null;
  weekly_allowed: number | null;
}

export interface NotificationRow {
  id: number;
  kind: NotifyKind | 'test';
  title: string;
  body: string;
  task_id: TaskId | null;
  created_at: string;
}

/** Where the daemon's reload onto new code stands. */
export interface ReloadState {
  /** reload_on_change is on. */
  enabled: boolean;
  /** The code on disk is newer than the code running, and a restart is coming. */
  pending: boolean;
  reason: string | null;
  /** What a pending reload waits for (running tasks, resolve runs). */
  waiting: string | null;
  /** Why the code on disk must not be loaded (an uncommitted migration step, a checkout off main). */
  blocked: string | null;
  /** Source files changed since the daemon started. */
  changed: number;
}

/** GET /api/daemon */
export interface DaemonState {
  commit: string | null;
  started_at: string;
  pid: number;
  reload: ReloadState;
}

export interface Headline {
  state: HeadlineState;
  /** When a rate limit or a hold ends (unix seconds); null otherwise. */
  until: number | null;
  /** Proposed tasks, blocked tasks and done tasks in review. */
  need_you: number;
  /** Up to five of those tasks: blocked first, then review, then proposed, each by priority. */
  attention: { id: TaskId; title: string; why: AttentionWhy }[];
  /** The repos due for an area review, each with its line ("area review due: 9 days, 115 commits since the last"). */
  review_due: RepoReviewDue[];
}

export interface Status {
  /** The code the daemon is running. */
  daemon: { commit: string | null; started_at: string; pid: number };
  paused: boolean;
  /** What is draining: the daemon, and the repos draining on their own. Each ends paused once nothing is in flight in it. */
  draining: { daemon: boolean; repos: { id: RepoId; name: string }[] };
  rate_limited_until: number | null;
  running: number;
  max_concurrent: number;
  counts: Partial<Record<TaskStatus, number>>;
  /** Done tasks whose PR is open. */
  review: number;
  /** The state headline and what needs a person, decided by the daemon: the dashboard and the tray read it as it is. */
  headline: Headline;
  usage: UsageWindow[];
  governor: Decision;
  budget: Budget;
  notifications: NotificationRow[];
  /** What every queued task waits for, if anything. */
  wait: QueueWait | null;
  paused_repos: { id: RepoId; name: string; reason: string; queued: number }[];
  /** The planner runs under way, one per unfinished run; `started_at` is UTC `YYYY-MM-DD HH:MM:SS`. */
  planning?: { id: PlannerRunId; repo_id: RepoId; repo: string; started_at: string }[];
}

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: { desktop: boolean; events: NotifyKind[]; ntfy_topic: string; ntfy_server: string };
  planner: { enabled: boolean; interval_hours: number; max_tasks: number; model: string };
  /** The model a new task takes when neither it nor its repo names one. */
  default_model: string;
  /** The model resolve and unblock runs use, in place of their task's. */
  support_model: string;
  /** The model review runs use; opus by default, a reviewer at least as strong as the worker. */
  review_model: string;
  reload_on_change: boolean;
  /** A repo is due for an area review when its oldest mark is older than `days`, or more than `lines` lines merged since it. */
  review_due: { days: number; lines: number };
}

/** POST /api/settings */
export interface SettingsPatch {
  max_concurrent?: number;
  budget?: Partial<Budget>;
  notify?: Partial<Settings['notify']>;
  planner?: Partial<Settings['planner']>;
  default_model?: string;
  support_model?: string;
  review_model?: string;
  reload_on_change?: boolean;
  review_due?: Partial<Settings['review_due']>;
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  state: string | null;
}

/** POST /api/daemon/restart: `waiting` says what the exit waits for. */
export interface RestartResult {
  waiting: string | null;
}

/** A task with a live run. */
export interface RunningTask {
  id: TaskId;
  title: string;
}

/** One check of `agentdeck doctor`; a failed one, or a warning, names the command that fixes it. */
export interface HealthCheck {
  name: string;
  ok: boolean;
  reason: string;
  fix: string | null;
  /** Passed, but a person should look (an area review due); never a failure. */
  warning?: boolean;
}

/** GET /api/daemon/health: `agentdeck doctor`, the checkout's HEAD, what is running, and the last lines of the daemon log. */
export interface DaemonHealth {
  checks: HealthCheck[];
  head: string | null;
  running: RunningTask[];
  log: string[];
}

/** POST /api/daemon/restart-now: the tasks whose run is lost and which are requeued. */
export interface RestartNowResult {
  requeued: RunningTask[];
}

/** POST /api/notify/test */
export interface TestNotifyResult {
  ok: boolean;
}

/** POST /api/app/seen: the desktop app says it is running, and shows desktop notifications for the next 90 s. */
export interface AppSeenResult {
  /** Desktop notifications are on. */
  desktop: boolean;
}

/** The data of each `rev` event on GET /api/events: it moves whenever the database changed, whoever wrote. */
export interface ChangeEvent {
  rev: number;
}
