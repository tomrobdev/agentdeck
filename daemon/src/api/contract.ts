// The HTTP API's request and response types: what the dashboard imports (app/src/types.ts) and what contract-check.ts
// holds the use cases to. It imports nothing, so the app can read it without the daemon's modules or node types.
// Fields marked "missing from a daemon that predates it" are optional so a newer dashboard still reads an older daemon.

// ---- Vocabulary

export type TaskStatus = 'proposed' | 'queued' | 'running' | 'done' | 'blocked' | 'failed' | 'cancel_requested' | 'cancelled';
export type PrMode = 'off' | 'draft' | 'ready';
export type PrState = 'open' | 'merged' | 'closed' | 'failed';
export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type NotifyKind = 'done' | 'blocked' | 'failed' | 'hold' | 'paused' | 'proposed';
/** Git refs the file endpoints accept: the task's branch, or where it forked from the base branch. */
export type FileRef = 'head' | 'base';

// ---- Repos

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

/** POST /api/repos */
export interface NewRepo {
  path: string;
  name?: string;
  test?: string;
  setup?: string;
}

/** POST /api/repos/:id */
export interface RepoPatch {
  goals?: string;
  auto_approve?: boolean;
  test_cmd?: string | null;
  setup_cmd?: string | null;
  pr_mode?: PrMode;
  merge_method?: MergeMethod;
  auto_resolve?: boolean;
  sandbox?: boolean;
  network?: string[];
}

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

/** What deleting an archived repo will remove, counted. */
export interface RepoDeletion {
  repo: string;
  archived: boolean;
  tasks: number;
  runs: number;
  worktrees: number;
}

/** Local only: `leftover` names files that couldn't be removed. */
export interface RepoDeleted {
  repo: string;
  leftover: string[];
}

// ---- Tasks

/** What a worker said it needs when it blocked. */
export interface Needs {
  kind: 'deps' | 'host' | 'edit';
  items: string[];
}

/** What every queued task waits for. */
export type QueueWait =
  { kind: 'daemon-paused' } | { kind: 'rate-limited'; until: number } | { kind: 'governor'; reason: string; until: number | null };

/** What one queued task waits for. */
export type StartWait =
  | QueueWait
  | { kind: 'repo-paused'; reason: string }
  | { kind: 'dependency'; on: number; stuck: string | null }
  | { kind: 'slots'; running: number; max: number };

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
  stop_reason: string | null;
  /** manual | planner */
  source: string;
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
  /** 'person' when a person marked the task done by hand. Missing from a daemon that predates it. */
  done_by?: 'person' | null;
  /** Set for a queued task held back by after_task; stuck says why its dependency won't get there on its own. */
  waiting: { on: number; stuck: string | null } | null;
  /** For a task in review: the queued tasks that wait on its PR. Missing from a daemon that predates it; read it as empty. */
  unblocks?: number[];
  /** A done task whose latest run left linked plan steps unfinished. Missing from a daemon that predates it. */
  plan_unfinished?: boolean;
  /** What a queued task waits for; null once it waits for nothing (or it isn't queued). */
  wait: StartWait | null;
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

/** One status change in a task's history. Tasks from before migration step 6 have none. */
export interface TaskEventRow {
  id: number;
  task_id: number;
  type:
    | 'created'
    | 'merge'
    | 'pr'
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
    | 'mark_done'
    | 'pr_merged'
    | 'recover';
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  reason: string | null;
  at: string;
}

/** A step of a plan, read from its `<section data-plan-step data-status>`. */
export interface PlanStep {
  id: string | null;
  title: string;
  status: 'todo' | 'doing' | 'done' | 'blocked' | 'skipped';
  /** The done criteria, from the step's `<ul data-plan-done>`. */
  done: string[];
}

/** A plan attached to a task, parsed; its HTML comes from GET /api/tasks/:id/plans/:planId. */
export interface TaskPlan {
  id: number;
  task_id: number;
  /** The path on the branch, or the attached file's name. */
  name: string;
  source: 'branch' | 'attached';
  version: string;
  title: string;
  summary: string | null;
  steps: PlanStep[];
  created_at: string;
  updated_at: string;
}

export interface TaskDetail extends Task {
  runs: Run[];
  events: TaskEventRow[];
  plans: TaskPlan[];
}

/** POST /api/tasks */
export interface NewTask {
  repo: string;
  prompt: string;
  title?: string;
  model?: string;
  priority?: number;
  max_turns?: number;
  after_task?: number;
  plan_path?: string;
  plan_steps?: string[];
}

/** POST /api/tasks/:id */
export interface TaskPatch {
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
}

/** POST /api/tasks/:id/cancel */
export interface CancelResult {
  result: string;
}

/** POST /api/tasks/:id/retry: `note` is "request changes", kept on the timeline and put first in the next run's prompt. */
export interface RetryRequest {
  note?: string;
}

/** POST /api/tasks/:id/done: `note` is kept on the timeline. */
export interface MarkDoneRequest {
  note?: string;
}

/** GET /api/tasks/:id/plans/:planId */
export interface PlanHtml {
  html: string;
}

/** POST /api/repos/:id/plan */
export interface ProposalResult {
  outcome: 'proposed' | 'nothing' | 'failed' | 'rate_limited' | 'no_goals';
  /** The proposals as stored, without the queue's view of them. */
  tasks: Pick<Task, 'id' | 'title' | 'prompt' | 'status'>[];
  skipped: string[];
  note: string | null;
}

// ---- Merge and resolve

/** What merging a task's PR would do (GET /api/tasks/:id/merge). */
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

/** POST /api/tasks/:id/merge */
export interface MergeRequest {
  method: MergeMethod;
  delete_branch: boolean;
}

export interface MergeResult {
  method: MergeMethod;
  unblocked: number[];
  /** Set when the merge went through but removing the branch or worktree did not. */
  cleanup_error?: string;
  task: TaskDetail;
}

/** What a sync of a task's branch came to (POST /api/tasks/:id/resolve). */
export interface SyncResult {
  /** `skipped`: conflicts, but auto_resolve is off. `deferred`: the usage limit or a cancel stopped it. */
  outcome: 'up_to_date' | 'clean' | 'resolved' | 'blocked' | 'skipped' | 'deferred' | 'error';
  files: string[];
  reason?: string;
  /** The branch was pushed, so the PR has it. */
  pushed: boolean;
  push_error?: string;
  task: TaskDetail;
}

// ---- A task's code

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

export type LogEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: string; file?: string }
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'setup'; passed: boolean; cmd: string; output: string }
  | { kind: 'tests'; passed: boolean; output: string }
  | { kind: 'error'; text: string };

// ---- The daemon

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
  /** What every queued task waits for, if anything. */
  wait: QueueWait | null;
  paused_repos: { id: number; name: string; reason: string; queued: number }[];
}

export interface Settings {
  max_concurrent: number;
  budget: Budget;
  notify: { desktop: boolean; events: NotifyKind[]; ntfy_topic: string; ntfy_server: string };
  planner: { enabled: boolean; interval_hours: number; max_tasks: number; model: string };
  reload_on_change: boolean;
}

/** POST /api/settings */
export interface SettingsPatch {
  max_concurrent?: number;
  budget?: Partial<Budget>;
  notify?: Partial<Settings['notify']>;
  planner?: Partial<Settings['planner']>;
  reload_on_change?: boolean;
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

/** POST /api/notify/test */
export interface TestNotifyResult {
  ok: boolean;
}
