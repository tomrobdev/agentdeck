// The HTTP API's request and response types: what the dashboard imports (app/src/api/types.ts) and what contract-check.ts
// holds the use cases to. It imports only types, and only from domain/, so the app can read it without node types.
import type { ChangeStatus, FileRef } from '../domain/work/index.ts';
import type { PlannerRunId, RepoId, ReviewId, RunId, TaskId } from '../domain/shared/index.ts';
import type { NotifyKind } from '../domain/operations/index.ts';
import type { PlanSource, PlanStepStatus } from '../domain/work/index.ts';
import type { PlannerOutcome } from '../domain/proposals/index.ts';
import type { AutoMergeState } from '../domain/landing/index.ts';
import type { CheckState } from '../domain/landing/index.ts';
import type { MergeMethod, PrMode } from '../domain/repos/index.ts';
import type { PrRetry, PrState } from '../domain/landing/index.ts';
import type { RunKind } from '../domain/runs/index.ts';
import type { HeadlineState, AttentionWhy } from '../domain/operations/index.ts';
import type { LinkKind } from '../domain/work/index.ts';
import type { TaskStatus } from '../domain/work/index.ts';
import type { NeedsKind } from '../domain/work/index.ts';
import type { TaskSource } from '../domain/work/index.ts';

// ---- Vocabulary

// The domain's words, shared as they are.
export type { AutoMergeState, FileRef, LinkKind, MergeMethod, NotifyKind, PrMode, PrState, TaskStatus };

// ---- Repos

export interface Repo {
  id: RepoId;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  allowed_tools: string | null;
  auto_approve: number;
  proposed_at: string | null;
  toolchain: string | null;
  setup_cmd: string | null;
  paused_reason: string | null;
  pr_mode: PrMode;
  merge_method: MergeMethod;
  /** 1 = the daemon starts a resolve run on its own when a branch conflicts with the base. */
  auto_resolve: number;
  /** 1 = the daemon starts an unblock run on its own when a task blocks (off by default). Missing from a daemon that predates it. */
  auto_unblock?: number;
  /** 1 = the agent's shell commands run in Claude Code's sandbox. */
  sandbox: number;
  /** JSON array of hosts sandboxed commands may reach. */
  network: string;
  /** When the repo was archived; null while it is active. */
  archived_at: string | null;
  /** 1 = the daemon merges a done task's PR on its own once it passes the auto-merge check. */
  auto_merge: number;
  /** A PR changing more lines needs a person. */
  auto_merge_max_lines: number;
  /** JSON array of path prefixes; a PR touching one needs a person. */
  auto_merge_skip: string;
  created_at: string;
}

export interface PlannerRun {
  id: PlannerRunId;
  started_at: string;
  ended_at: string | null;
  outcome: PlannerOutcome | null;
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
  auto_unblock?: boolean;
  sandbox?: boolean;
  network?: string[];
  auto_merge?: boolean;
  auto_merge_max_lines?: number;
  auto_merge_skip?: string[];
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
  kind: NeedsKind;
  items: string[];
}

/** What every queued task waits for. */
export type QueueWait =
  { kind: 'daemon-paused' } | { kind: 'rate-limited'; until: number } | { kind: 'governor'; reason: string; until: number | null };

/** What one queued task waits for. */
export type StartWait =
  | QueueWait
  | { kind: 'repo-paused'; reason: string }
  /** `on`: every task it builds on still on its way, or the one it is stuck on (with `stuck`, the reason). */
  | { kind: 'dependency'; on: TaskId[]; stuck: string | null }
  | { kind: 'slots'; running: number; max: number };

/** One link: the task it points at, its kind and where it stands (unlanded is an after link whose other task has not landed yet). */
export interface TaskLink {
  on: TaskId;
  kind: LinkKind;
  state: 'met' | 'waiting' | 'stuck' | 'unlanded';
}

/** POST /api/tasks/:id/links */
export interface NewLink {
  on: TaskId;
  kind: LinkKind;
}

/** A running task's live state. `since` is UTC `YYYY-MM-DD HH:MM:SS`; `tool` is a few words, e.g. "Edit worker.ts". */
export interface LiveView {
  since: string;
  turns: number;
  max_turns: number;
  tool: string | null;
}

/** A sync of a done task under way. `since` is null for a clean sync (no claude), else the resolve run's start, UTC `YYYY-MM-DD HH:MM:SS`. */
export interface SyncView {
  /** The base branch being synced with. */
  base: string;
  since: string | null;
  /** A resolve run is settling conflicts. */
  resolving: boolean;
  turns: number;
  max_turns: number;
  tool: string | null;
}

/** One check on a PR's head commit: a GitHub check run or a commit status. NEUTRAL and SKIPPED conclusions are `skipped`. */
export interface PrCheck {
  name: string;
  state: CheckState;
  url: string | null;
  started_at: string | null;
  completed_at: string | null;
}

/** An open PR's checks in a line's worth: counted, with the failing ones' names. `read_at` is when the PR refresh read them. */
export interface ChecksSummary {
  total: number;
  failing: number;
  pending: number;
  failing_names: string[];
  read_at: string;
}

/** A task as returned by the list endpoint: everything except the prompt. */
export interface TaskSummary {
  id: TaskId;
  repo_id: RepoId;
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
  source: TaskSource;
  pr_url: string | null;
  pr_state: PrState | null;
  /** How the PR was merged from the app. */
  merge_method: MergeMethod | null;
  /** The task whose plan this one follows (itself when its own plan was given with it); null follows its own plan, if any. */
  plan_task: TaskId | null;
  /** JSON array of that plan's step ids; null means every unfinished step. */
  plan_steps: string | null;
  /** JSON `{ kind: 'deps' | 'host' | 'edit', items: string[] }`: what the worker said it needs when it blocked. */
  needs: string | null;
  /** JSON `{ question: string, options: string[] }`: what an unblock run asked a person about the block. */
  question: string | null;
  /** 'person' when a person marked the task done by hand. */
  done_by: 'person' | null;
  /** 1 or 0 overrides the repo's auto_merge; null follows it. */
  auto_merge: number | null;
  /** Whether the PR will merge on its own and why not. Null when the repo is gone. */
  auto_merge_view: AutoMergeView | null;
  /** The person's merge request, while the daemon is to merge the PR when it is ready; null with none. */
  merge_request: MergeRequestView | null;
  /**
   * The open PR conflicts with the base branch, as the last PR check found it (the merge request's check, else auto-merge's;
   * false when neither stored one).
   */
  conflicting: boolean;
  /**
   * Set for a queued task waiting on builds-on links: `on` is every task it builds on still on its way, or, with `stuck`
   * (why it won't get there on its own), the one task it is stuck on.
   */
  waiting: { on: TaskId[]; stuck: string | null } | null;
  /** For a task in review: the queued tasks merging its PR lets start. */
  unblocks: TaskId[];
  /** What this task depends on, with where each link stands. */
  links: TaskLink[];
  /** The tasks that depend on this one. */
  dependents: { id: TaskId; kind: LinkKind }[];
  /** A done task whose latest run left linked plan steps unfinished. */
  plan_unfinished: boolean;
  /** For a running task: when its run started, turns so far and the last tool call. */
  live: LiveView | null;
  /** For a done task: the sync under way, whoever started it. Null when none is. */
  sync: SyncView | null;
  /** The open PR's checks; null when there is no open PR or it has no checks. */
  checks: ChecksSummary | null;
  /** What a queued task waits for; null once it waits for nothing (or it isn't queued). */
  wait: StartWait | null;
  /**
   * For a done task whose PR failed to open: `due` or `wait` while the PR refresh opens it again (at `next_at`), `person` once
   * its retries are used up. Null for any other task.
   */
  pr_retry: PrRetry | null;
  created_at: string;
  updated_at: string;
}

export interface Task extends TaskSummary {
  prompt: string;
}

export interface Run {
  id: RunId;
  /** A resolve run merges the base branch into the task's branch, an unblock run reads why a blocked task stopped; neither uses an attempt. */
  kind: RunKind;
  /** A resolve run carries the attempt it ran beside, so pick runs by id. */
  attempt: number;
  started_at: string;
  ended_at: string | null;
  outcome: 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited' | 'interrupted' | null;
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
  task_id: TaskId;
  type:
    | 'created'
    | 'edit'
    | 'merge'
    | 'pr'
    | 'sync'
    | 'plan_unfinished'
    | 'environment_block'
    | 'unblock_ask'
    | 'claim'
    | 'finish'
    | 'rate_limited'
    | 'conflict'
    | 'cancel'
    | 'approve'
    | 'reject'
    | 'retry'
    | 'unblock_retry'
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
  status: PlanStepStatus;
  /** The done criteria, from the step's `<ul data-plan-done>`. */
  done: string[];
}

/** A plan attached to a task, parsed; its HTML comes from GET /api/tasks/:id/plans/:planId. */
export interface TaskPlan {
  id: number;
  /** The task the plan belongs to: the one it was first attached to. */
  task_id: TaskId;
  /** `<task id>-<slug>.html`; plans stored before plans had numbers keep their old name (a docs/plans/ path or a file name). */
  name: string;
  /** Attached by a person, written by a worker, or (before plans moved into AgentDeck) collected from the branch. */
  source: PlanSource;
  version: string;
  title: string;
  summary: string | null;
  steps: PlanStep[];
  created_at: string;
  updated_at: string;
}

export interface TaskDetail extends Task {
  /** The PR's latest checks, one by one, and when they were read; null when none were read. */
  check_list: { read_at: string; checks: PrCheck[] } | null;
  runs: Run[];
  events: TaskEventRow[];
  plans: TaskPlan[];
}

/** The reply to adding or editing a task: the task, and what is worth a second look in its prompt (the task is saved either way). */
export interface TaskSaved extends TaskDetail {
  warnings: string[];
}

/** POST /api/tasks */
export interface NewTask {
  repo: string;
  prompt: string;
  title?: string;
  model?: string;
  priority?: number;
  max_turns?: number;
  /** Tasks this one builds on: it starts once they are done and merged. */
  builds_on?: TaskId[];
  /** Tasks this one lands after: it runs at once, only its merge waits. */
  after?: TaskId[];
  /** The task whose plan this one follows: one in the same repo with a plan. */
  plan_task?: TaskId;
  plan_steps?: string[];
  /** File it as a proposal, waiting for approval, instead of queueing it. */
  propose?: boolean;
}

/** POST /api/tasks/:id */
export interface TaskPatch {
  title?: string;
  prompt?: string;
  priority?: number;
  model?: string;
  max_turns?: number;
  max_attempts?: number;
  /** The task whose plan this one follows; null clears the link. */
  plan_task?: TaskId | null;
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

/** A line comment of a review. `side` says which file `line` counts in: the base (old) or the task's head (new). */
export interface ReviewComment {
  id: number;
  review_id: ReviewId;
  path: string;
  line: number;
  side: 'old' | 'new';
  /** The task's head commit the comment was made on. */
  head_commit: string;
  body: string;
  /** null until answered. */
  answer: string | null;
  state: 'open' | 'answered' | 'resolved';
  created_at: string;
  updated_at: string;
}

/** A review of a task with its comments. A draft has no `submitted_at` and no `kind`. */
export interface Review {
  id: ReviewId;
  task_id: TaskId;
  kind: 'comment' | 'request_changes' | null;
  /** The overall note. */
  body: string;
  created_at: string;
  submitted_at: string | null;
  comments: ReviewComment[];
}

/** POST /api/reviews/:id (a draft's overall note) */
export interface ReviewPatch {
  body?: string;
}

/** POST /api/reviews/:id/comments */
export interface NewReviewComment {
  path: string;
  line: number;
  side: 'old' | 'new';
  head_commit: string;
  body: string;
}

/** POST /api/reviews/:id/submit: Request changes also retries the task, with the review as the reason. */
export interface SubmitReview {
  kind: 'comment' | 'request_changes';
  /** Replaces the draft's overall note when given. */
  body?: string;
}

/** GET /api/tasks/:id/plans/:planId */
export interface PlanHtml {
  html: string;
}

/** POST /api/repos/:id/plan */
export interface ProposalResult {
  outcome: PlannerOutcome | 'no_goals';
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
  /** Queued tasks that merging this one lets start (one still waiting on another task too is left out). */
  unblocks: { id: TaskId; title: string }[];
  /** Whether the daemon will merge it on its own and why not yet; null when auto-merge is off. */
  auto_merge: AutoMergeCheck | null;
  /** What a merge request would do now: `merge` as asked, `wait` for the PR to be ready, `never` (a person must act). */
  request: AutoMergeCheck;
  /** Whether the dialog merges now (failing checks or failed tests, on the person's say-so) instead of asking for a merge request. */
  merge_now: boolean;
}

/** `merge`: the daemon merges it on its next PR refresh. `wait`: something that can still change on its own. `never`: it needs a person. */
export interface AutoMergeCheck {
  verdict: 'merge' | 'wait' | 'never';
  reasons: string[];
  /** Set when one of the reasons is a conflict with the base branch. */
  conflict?: true;
}

/**
 * What a task's auto-merge comes to. `off`: not on. `on`: on, no open PR checked yet. `merge`, `wait` and `never` are the
 * last PR check's verdict. `label` and `reasons` are worded by the daemon; show them as they are.
 */
export interface AutoMergeView {
  state: AutoMergeState;
  label: string;
  /** Why it waits or needs a person; for a branch with no open PR, how it measures against the limits now. */
  reasons: string[];
  /** Where on or off comes from; `planner`: off because the repo auto-approves planner proposals. */
  source: 'task' | 'repo' | 'planner';
  /** When the PR refresh made the check (UTC, `YYYY-MM-DD HH:MM:SS`); null when no check counts. */
  checked_at: string | null;
  limits: { max_lines: number; skip: string[]; tests: string };
}

/** POST /api/tasks/:id/auto-merge: true or false for this task, null to follow the repo. */
export interface AutoMergeRequest {
  auto_merge: boolean | null;
}

export interface AutoMergeResult {
  /** Whether auto-merge is on for the task now. */
  auto_merge: boolean;
  /** Set when the setting was saved but the PR's label could not be changed. */
  label_error?: string;
  task: TaskDetail;
}

/**
 * A task's merge request: a person's Merge, which the daemon carries out once the PR is ready. `waiting`: not yet, and
 * `reasons` say what for (the last check's, worded by the daemon). `merging`: the merge is under way.
 */
export interface MergeRequestView {
  state: 'waiting' | 'merging';
  method: MergeMethod;
  reasons: string[];
  /** When the person asked (UTC, `YYYY-MM-DD HH:MM:SS`). */
  since: string;
}

/** POST /api/tasks/:id/merge-request: ask the daemon to merge the PR once it is ready. */
export interface RequestMergeRequest {
  /** Left out: the task's method, then the repo's. */
  method?: MergeMethod;
}

export interface RequestMergeResult {
  method: MergeMethod;
  task: TaskDetail;
}

/** DELETE /api/tasks/:id/merge-request */
export interface CancelMergeRequestResult {
  /** False when the task had no request. */
  cancelled: boolean;
  task: TaskDetail;
}

/** POST /api/tasks/merge-requests: request these tasks' merges, each with its own method. */
export interface RequestMergesRequest {
  ids: TaskId[];
}

export interface RequestMergesResult {
  requested: number[];
  /** The tasks it could not ask for, each with why. */
  failed: { id: TaskId; reason: string }[];
}

/** POST /api/tasks/:id/fix-checks: the task is retried with its PR's failing checks, and their logs, in the note. */
export interface FixChecksResult {
  /** The failing checks sent to the worker, by name. */
  checks: string[];
  task: TaskDetail;
}

/** POST /api/tasks/:id/open-pr: a person opened a done task's PR (one that failed to open, never opened, or was closed). */
export interface OpenPrResult {
  /** The PR's url. */
  url: string;
  task: TaskDetail;
}

/** POST /api/tasks/:id/merge */
export interface MergeRequest {
  /** Left out: the task's method, then the repo's. */
  method?: MergeMethod;
  delete_branch: boolean;
}

export interface MergeResult {
  method: MergeMethod;
  /** Queued tasks the merge lets start. */
  unblocked: number[];
  /** Set when the merge went through but removing the branch or worktree did not. */
  cleanup_error?: string;
  task: TaskDetail;
}

/** What a sync of a task's branch came to (POST /api/tasks/:id/sync). */
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
  status: ChangeStatus;
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

export interface LogChange {
  added: number;
  removed: number;
  old: string;
  new: string;
}

export type LogEntry = {
  /** The event's timestamp. */
  at?: string;
  /** The `tool_use` id of the subagent call this entry comes from. */
  parent?: string;
} & (
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id?: string; name: string; input: string; summary: string; file?: string; change?: LogChange }
  | { kind: 'tool_result'; id: string; ok: boolean; output: string; lines: number }
  | { kind: 'result'; subtype: string; turns: number; cost: number }
  | { kind: 'setup'; passed: boolean; cmd: string; output: string }
  | { kind: 'tests'; passed: boolean; output: string }
  | { kind: 'error'; text: string }
);

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
}

export interface Status {
  /** The code the daemon is running. */
  daemon: { commit: string | null; started_at: string; pid: number };
  paused: boolean;
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

/** A task with a live run. */
export interface RunningTask {
  id: TaskId;
  title: string;
}

/** One check of `agentdeck doctor`; a failed one names the command that fixes it. */
export interface HealthCheck {
  name: string;
  ok: boolean;
  reason: string;
  fix: string | null;
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

// ---- Insights

/** A Wilson 95% interval. */
export interface Interval {
  low: number;
  high: number;
}

/** The first-run measures of a set of work runs (`agentdeck stats`). */
export interface RunMeasures {
  tasks: number;
  runs: number;
  first_runs: number;
  first_run_done: number;
  first_run_rate: number | null;
  first_run_interval: Interval | null;
  denials: number;
  denials_per_run: number | null;
  done_tasks: number;
  cost_per_done_task: number | null;
  minutes_per_done_task: number | null;
}

/** The scorecard's interventions, with how many were of each kind. */
export interface InterventionCount {
  total: number;
  tasks: number;
  by_kind: Record<string, number>;
}

/** The rest of the scorecard's measures: medians are in minutes, null when there is nothing to take them over. */
export interface ScorecardMeasures {
  interventions: InterventionCount;
  tasks: number;
  queued_minutes: number | null;
  running_minutes: number | null;
  review_minutes: number | null;
  pr_checks: { recorded: number; green: number; rate: number | null };
}

/** GET /api/stats?repo=<name or id>&since=<date>&by=week: what `agentdeck stats --json` prints. */
export interface Stats {
  repos: { repo: string; measures: RunMeasures }[];
  total: RunMeasures;
  /** The first-run measures per week, oldest first; empty unless `by` is week. */
  weeks: { week: string; measures: RunMeasures }[];
  scorecard: {
    since: string | null;
    by: 'week' | null;
    repos: { repo: string; measures: ScorecardMeasures }[];
    total: ScorecardMeasures;
    /** Percentage points of the 7-day window spent. */
    quota_points: number;
    /** One per week with anything in it, oldest first; empty unless `by` is week. */
    weeks: { week: string; measures: ScorecardMeasures; quota_points: number }[];
  };
}

// ---- Change stream

/** The data of each `rev` event on GET /api/events: it moves whenever the database changed, whoever wrote. */
export interface ChangeEvent {
  rev: number;
}
