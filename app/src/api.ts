// Client for the daemon's local API (daemon/src/api/server.ts).
// VITE_AGENTDECK_API points a dev build at another daemon (e.g. one run on a copy of the database).
export const API_BASE: string = import.meta.env.VITE_AGENTDECK_API ?? 'http://127.0.0.1:4317';

export type TaskStatus = 'proposed' | 'queued' | 'running' | 'done' | 'blocked' | 'failed' | 'cancel_requested' | 'cancelled';

export interface Repo {
  id: number;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  allowed_tools: string | null;
  auto_approve: number;
  planned_at: string | null;
  toolchain: string | null;
  setup_cmd: string | null;
  paused_reason: string | null;
  pr_mode: PrMode;
  merge_method: MergeMethod;
  /** 1 = the daemon starts a resolve run on its own when a branch conflicts with the base. */
  auto_resolve: number;
  /** 1 = the agent's shell commands run in Claude Code's sandbox. */
  sandbox: number;
  /** JSON array of hosts sandboxed commands may reach. */
  network: string;
  /** When the repo was archived; null while it is active. */
  archived_at: string | null;
  created_at: string;
}

export type PrMode = 'off' | 'draft' | 'ready';
export type PrState = 'open' | 'merged' | 'closed' | 'failed';
export type MergeMethod = 'squash' | 'merge' | 'rebase';
export const MERGE_METHODS: { key: MergeMethod; label: string; hint: string }[] = [
  { key: 'squash', label: 'Squash and merge', hint: 'One commit on the base branch' },
  { key: 'merge', label: 'Create a merge commit', hint: 'Keeps every commit' },
  { key: 'rebase', label: 'Rebase and merge', hint: 'Replays every commit on the base branch' },
];

export interface DoctorCheck {
  name: string;
  ok: boolean;
  reason: string;
}

export interface DoctorReport {
  repo: string;
  ok: boolean;
  checks: DoctorCheck[];
  paused_reason: string | null;
}

export interface PlannerRun {
  id: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  proposed: number;
  note: string | null;
}

export interface RepoDetail extends Repo {
  goals: string;
  goals_path: string;
  planner_runs: PlannerRun[];
}

/** What deleting an archived repo will remove, counted. */
export interface RepoDeletion {
  repo: string;
  archived: boolean;
  tasks: number;
  runs: number;
  worktrees: number;
}

export interface PlanResult {
  outcome: 'proposed' | 'nothing' | 'failed' | 'rate_limited' | 'no_goals';
  tasks: Task[];
  skipped: string[];
  note: string | null;
}

export interface ServiceStatus {
  installed: boolean;
  loaded: boolean;
  pid: number | null;
  state: string | null;
}

/** A task as returned by the list endpoint: everything except the prompt. */
export interface TaskSummary {
  id: number;
  repo_id: number;
  repo: string | null;
  title: string;
  status: TaskStatus;
  priority: number;
  model: string;
  max_turns: number;
  attempts: number;
  max_attempts: number;
  branch: string | null;
  worktree: string | null;
  blocked_reason: string | null;
  source: 'manual' | 'planner';
  pr_url: string | null;
  pr_state: PrState | null;
  /** How the PR was merged from the app. */
  merge_method: MergeMethod | null;
  after_task: number | null;
  /** The plan this task carries out: a repo-relative path under docs/plans/. */
  plan_path: string | null;
  /** JSON array of that plan's step ids; null means every unfinished step. Missing from a daemon that predates it. */
  plan_steps: string | null;
  /** JSON `{ kind: 'deps' | 'host' | 'edit', items: string[] }`: what the worker said it needs when it blocked. Missing from a daemon that predates it. */
  needs?: string | null;
  /** Set for a queued task held back by after_task; stuck says why its dependency won't get there on its own. */
  waiting: { on: number; stuck: string | null } | null;
  /** For a task in review: the queued tasks that wait on its PR. */
  /** Missing from a daemon that predates it; read it as empty. */
  unblocks?: number[];
  /** A done task whose latest run left linked plan steps unfinished. Missing from a daemon that predates it. */
  plan_unfinished?: boolean;
  /** Why a queued task hasn't started yet; null once nothing holds it (or it isn't queued). */
  hold: StartHold | null;
  created_at: string;
  updated_at: string;
}

export interface Task extends TaskSummary {
  prompt: string;
}

export interface Run {
  id: number;
  /** A resolve run merges the base branch into the task's branch and uses no attempt. */
  kind: 'work' | 'resolve';
  /** A resolve run carries the attempt it ran beside, so pick runs by id. */
  attempt: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tests_passed: number | null;
  result_text: string | null;
  denials: number;
}

/** One status change in a task's history (task_events). Tasks from before migration step 6 have none. */
export interface TaskEventRow {
  id: number;
  task_id: number;
  type:
    | 'created'
    | 'merge'
    | 'sync'
    | 'plan_unfinished'
    | 'environment_block'
    | 'claim'
    | 'finish'
    | 'rate_limited'
    | 'conflict'
    | 'cancel'
    | 'approve'
    | 'reject'
    | 'retry'
    | 'recover';
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  reason: string | null;
  at: string;
}

/** What merging a task's PR would do (GET /api/tasks/:id/merge; daemon application/pull-requests.ts). */
export interface MergePreview {
  title: string;
  pr_url: string;
  branch: string | null;
  base: string;
  /** The repo's default method; the dialog starts here. */
  method: MergeMethod;
  draft: boolean;
  commits: number;
  files: number;
  additions: number;
  deletions: number;
  /** The last run's tests: 1 passed, 0 failed, null not run. */
  tests_passed: number | null;
  checks: { total: number; failing: number; pending: number };
  /** Reasons the merge can't go ahead. */
  problems: string[];
  warnings: string[];
  /** One of the problems is a conflict with the base branch, which a resolve run can fix. */
  conflicting: boolean;
  /** Queued tasks waiting on this one. */
  unblocks: { id: number; title: string }[];
}

/** What bringing the base branch into a task's branch came to (POST /api/tasks/:id/resolve; daemon application/conflicts.ts). */
export interface ResolveResult {
  /** `skipped`: conflicts, but auto_resolve is off. `deferred`: the usage limit or a cancel stopped it. */
  outcome: 'up_to_date' | 'clean' | 'resolved' | 'blocked' | 'skipped' | 'deferred' | 'error';
  files: string[];
  reason?: string;
  /** The branch was pushed, so the PR has it. */
  pushed: boolean;
  push_error?: string;
  task: TaskDetail;
}

export interface MergeResult {
  method: MergeMethod;
  unblocked: number[];
  /** Set when the merge went through but removing the branch or worktree did not. */
  cleanup_error?: string;
  task: TaskDetail;
}

export interface TaskDetail extends Task {
  runs: Run[];
  events: TaskEventRow[];
  plans: TaskPlan[];
}

/** A step of a plan, read from its `<section data-plan-step data-status>` (daemon domain/plan). */
export interface PlanStep {
  id: string | null;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
  done: string[]; // the done criteria, from the step's `<ul data-plan-done>`
}

/** A plan attached to a task, parsed; its HTML comes from `api.planHtml`. */
export interface TaskPlan {
  id: number;
  task_id: number;
  name: string; // the path on the branch, or the attached file's name
  source: 'branch' | 'attached';
  version: string;
  title: string;
  summary: string | null;
  steps: PlanStep[];
  created_at: string;
  updated_at: string;
}

/** Git refs the file endpoints accept: the task's branch, or where it forked from the base branch. */
export type FileRef = 'head' | 'base';

export const CHANGE_LABEL: Record<ChangedFile['status'], string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

export interface ChangedFile {
  path: string;
  old_path: string | null;
  status: 'A' | 'M' | 'D' | 'R';
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Commit {
  sha: string;
  subject: string;
  author: string;
  at: string;
}

export interface Changes {
  base_ref: string;
  base: string;
  head: string;
  files: ChangedFile[];
  commits: Commit[];
}

export interface FilePatch {
  path: string;
  patch: string;
  truncated: boolean;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number | null;
}

export interface TreeListing {
  ref: FileRef;
  sha: string;
  path: string;
  entries: TreeEntry[];
}

export interface FileContent {
  path: string;
  ref: FileRef;
  sha: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  text: string | null;
}

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

export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'proposed';

export interface NotificationRow {
  id: number;
  kind: NotifyKind | 'test';
  title: string;
  body: string;
  task_id: number | null;
  created_at: string;
}

export interface Status {
  /** The code the daemon is running. Missing from a daemon that predates it. */
  daemon?: { commit: string | null; started_at: string };
  paused: boolean;
  rate_limited_until: number | null;
  running: number;
  max_concurrent: number;
  counts: Partial<Record<TaskStatus, number>>;
  /** Done tasks whose PR is open. */
  review: number;
  usage: UsageWindow[];
  governor: Decision;
  budget: Budget;
  notifications: NotificationRow[];
  /** What stops every queued task, if anything. */
  hold: QueueHold | null;
  paused_repos: { id: number; name: string; reason: string; queued: number }[];
}

// Mirrors daemon/src/domain/task/start.ts.
export type QueueHold =
  { kind: 'daemon-paused' } | { kind: 'rate-limited'; until: number } | { kind: 'governor'; reason: string; until: number | null };
export type StartHold =
  | QueueHold
  | { kind: 'repo-paused'; reason: string }
  | { kind: 'dependency'; on: number; stuck: string | null }
  | { kind: 'slots'; running: number; max: number };

/** A hold in a few words, for chips and callouts. */
export function describeHold(h: StartHold): string {
  switch (h.kind) {
    case 'daemon-paused':
      return 'AgentDeck is paused';
    case 'rate-limited':
      return `Claude rate-limited us; resumes ${relTime(h.until)}`;
    case 'governor':
      return `Holding for the usage budget: ${h.reason}${h.until ? `; lifts around ${when(h.until)}` : ''}`;
    case 'repo-paused':
      return `The repo is paused: ${h.reason.split('\n')[0]}`;
    case 'dependency':
      return h.stuck ? `Waits for #${h.on}, which won't get there: ${h.stuck}` : `Waits for #${h.on} to finish`;
    case 'slots':
      return `Waiting for a free slot (${h.running} of ${h.max} in use)`;
  }
}

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: { desktop: boolean; events: NotifyKind[]; ntfy_topic: string; ntfy_server: string };
  planner: { enabled: boolean; interval_hours: number; max_tasks: number; model: string };
  reload_on_change: boolean;
}

export type LogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string; file?: string }
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'setup'; passed: boolean; cmd: string; output: string }
  | { kind: 'tests'; passed: boolean; output: string }
  | { kind: 'error'; text: string };

export class ApiError extends Error {}

async function call<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method: init?.method ?? 'GET',
      headers: init?.json ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.json ? JSON.stringify(init.json) : undefined,
    });
  } catch {
    throw new ApiError('offline');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  status: () => call<Status>('/api/status'),
  pause: () => call<Status>('/api/pause', { method: 'POST' }),
  resume: () => call<Status>('/api/resume', { method: 'POST' }),
  /** Exit once nothing is running so launchd starts the daemon on the new code. `waiting` says what it waits for. */
  restartDaemon: () => call<{ waiting: string | null }>('/api/daemon/restart', { method: 'POST' }),
  settings: () => call<Settings>('/api/settings'),
  updateSettings: (patch: {
    max_concurrent?: number;
    budget?: Partial<Budget>;
    notify?: Partial<Settings['notify']>;
    planner?: Partial<Settings['planner']>;
    reload_on_change?: boolean;
  }) => call<Settings>('/api/settings', { method: 'POST', json: patch }),
  testNotify: () => call<{ ok: boolean }>('/api/notify/test', { method: 'POST' }),
  repos: () => call<Repo[]>('/api/repos'),
  addRepo: (r: { path: string; name?: string; test?: string; setup?: string }) => call<Repo>('/api/repos', { method: 'POST', json: r }),
  repo: (id: number) => call<RepoDetail>(`/api/repos/${id}`),
  updateRepo: (
    id: number,
    patch: {
      goals?: string;
      auto_approve?: boolean;
      test_cmd?: string | null;
      setup_cmd?: string | null;
      pr_mode?: PrMode;
      merge_method?: MergeMethod;
      auto_resolve?: boolean;
      sandbox?: boolean;
      network?: string[];
    },
  ) => call<RepoDetail>(`/api/repos/${id}`, { method: 'POST', json: patch }),
  plan: (id: number) => call<PlanResult>(`/api/repos/${id}/plan`, { method: 'POST' }),
  doctor: (id: number) => call<DoctorReport>(`/api/repos/${id}/doctor`, { method: 'POST' }),
  resumeRepo: (id: number) => call<Repo>(`/api/repos/${id}/resume`, { method: 'POST' }),
  archivedRepos: () => call<Repo[]>('/api/repos?archived=1'),
  archiveRepo: (id: number) => call<Repo>(`/api/repos/${id}/archive`, { method: 'POST' }),
  unarchiveRepo: (id: number) => call<Repo>(`/api/repos/${id}/unarchive`, { method: 'POST' }),
  repoDeletion: (id: number) => call<RepoDeletion>(`/api/repos/${id}/deletion`),
  /** Local only: `leftover` names files that couldn't be removed. */
  deleteRepo: (id: number) => call<{ repo: string; leftover: string[] }>(`/api/repos/${id}`, { method: 'DELETE' }),
  editTask: (
    id: number,
    patch: {
      title?: string;
      prompt?: string;
      priority?: number;
      model?: string;
      max_turns?: number;
      max_attempts?: number;
      /** null clears the link. */
      plan_path?: string | null;
      /** null means every unfinished step. */
      plan_steps?: string[] | null;
    },
  ) => call<TaskDetail>(`/api/tasks/${id}`, { method: 'POST', json: patch }),
  approve: (id: number) => call<TaskDetail>(`/api/tasks/${id}/approve`, { method: 'POST' }),
  reject: (id: number) => call<TaskDetail>(`/api/tasks/${id}/reject`, { method: 'POST' }),
  service: () => call<ServiceStatus>('/api/service'),
  tasks: () => call<TaskSummary[]>('/api/tasks'),
  task: (id: number) => call<TaskDetail>(`/api/tasks/${id}`),
  addTask: (t: {
    repo: string;
    prompt: string;
    title?: string;
    model?: string;
    priority?: number;
    max_turns?: number;
    after_task?: number;
    plan_path?: string;
    plan_steps?: string[];
  }) => call<TaskDetail>('/api/tasks', { method: 'POST', json: t }),
  cancel: (id: number) => call<{ result: string }>(`/api/tasks/${id}/cancel`, { method: 'POST' }),
  /** `note` is "request changes": kept on the timeline and put first in the next run's prompt. */
  retry: (id: number, note?: string) => call<TaskDetail>(`/api/tasks/${id}/retry`, { method: 'POST', json: note ? { note } : {} }),
  /** Install the packages a blocked task asked for (NEEDS deps) on its branch, then retry it. */
  installNeeds: (id: number) => call<TaskDetail>(`/api/tasks/${id}/install-needs`, { method: 'POST' }),
  closePr: (id: number) => call<TaskDetail>(`/api/tasks/${id}/close-pr`, { method: 'POST' }),
  mergePreview: (id: number) => call<MergePreview>(`/api/tasks/${id}/merge`),
  merge: (id: number, body: { method: MergeMethod; delete_branch: boolean }) =>
    call<MergeResult>(`/api/tasks/${id}/merge`, { method: 'POST', json: body }),
  /** Merge the base branch into the task's branch; a conflict starts a claude run, so this can take minutes. */
  resolve: (id: number) => call<ResolveResult>(`/api/tasks/${id}/resolve`, { method: 'POST' }),
  changes: (id: number) => call<Changes>(`/api/tasks/${id}/changes`),
  diff: (id: number, path: string) => call<FilePatch>(`/api/tasks/${id}/diff?path=${encodeURIComponent(path)}`),
  tree: (id: number, ref: FileRef, path = '') => call<TreeListing>(`/api/tasks/${id}/tree?ref=${ref}&path=${encodeURIComponent(path)}`),
  file: (id: number, ref: FileRef, path: string) => call<FileContent>(`/api/tasks/${id}/file?ref=${ref}&path=${encodeURIComponent(path)}`),
  planHtml: (id: number, planId: number) => call<{ html: string }>(`/api/tasks/${id}/plans/${planId}`),
  logUrl: (id: number, runId?: number) => `${API_BASE}/api/tasks/${id}/log${runId ? `?run=${runId}` : ''}`,
};

/** "Tue 14:00" style, for when a hold lifts. */
export function when(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

export function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

/** Every time from the daemon is SQLite's UTC `YYYY-MM-DD HH:MM:SS`, with no zone marker. */
export function parseTime(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

export function ago(time: string): string {
  const secs = Math.round((Date.now() - parseTime(time)) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** How long a run took, or has taken so far: "45s", "12m", "1.4h". */
export function runDuration(r: Run): string {
  const secs = ((r.ended_at ? parseTime(r.ended_at) : Date.now()) - parseTime(r.started_at)) / 1000;
  return secs < 90 ? `${Math.round(secs)}s` : secs < 5400 ? `${Math.round(secs / 60)}m` : `${(secs / 3600).toFixed(1)}h`;
}

export function totalTokens(r: Run): number {
  return r.input_tokens + r.output_tokens + r.cache_read_tokens + r.cache_write_tokens;
}

export function fmtTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** The banner text when the daemon runs a different commit than the dashboard, else null. Unknown commits never warn. */
export function describeStaleDaemon(s: Status | null, dashboardCommit: string | null): string | null {
  const d = s?.daemon;
  if (!d?.commit || !dashboardCommit || d.commit === dashboardCommit) return null;
  const started = new Date(d.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `The daemon is running older code (${d.commit.slice(0, 7)}, started ${started}). Restart it to match the dashboard.`;
}

/** One label for the daemon's state, shared by the status bar and the tray. */
export function describeState(s: Status | null, offline: boolean): { label: string; cls: string; title: string } {
  if (offline) return { label: 'Daemon offline', cls: 's-failed', title: '' };
  if (!s) return { label: 'Connecting…', cls: 's-queued', title: '' };
  if (s.paused) return { label: 'Paused', cls: 's-blocked', title: 'No new tasks start until you resume' };
  const limited = s.rate_limited_until && s.rate_limited_until * 1000 > Date.now() ? s.rate_limited_until : null;
  if (limited)
    return {
      label: `Rate limited · ${relTime(limited)}`,
      cls: 's-blocked',
      title: 'Claude rejected a request; waiting for the window to reset',
    };
  const g = s.governor;
  if (!g.allow)
    return { label: g.until ? `Holding · until ${when(g.until)}` : 'Holding', cls: 's-blocked', title: `Usage budget: ${g.reason}` };
  if (s.running) return { label: 'Working', cls: 's-running', title: g.reason ?? '' };
  return { label: 'Idle', cls: 's-done', title: g.reason ?? '' };
}
