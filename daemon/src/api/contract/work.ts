// Work: tasks, their links and waits, events and plans.
import type { RepoId, TaskId } from '#domain/shared/index.ts';
import type { LinkKind, NeedsKind, PlanSource, PlanStepStatus, TaskSource, TaskStatus } from '#domain/work/index.ts';
import type { MergeMethod } from '#domain/repos/index.ts';
import type { PrRetry, PrState } from '#domain/landing/index.ts';
import type { LiveView, SyncView, Run } from '#api/contract/runs.ts';
import type { PrCheck, ChecksSummary, AutoMergeView, MergeRequestView } from '#api/contract/landing.ts';

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
  | { kind: 'draining'; repo: boolean }
  /** `on`: every task it builds on still on its way, or the one it is stuck on (with `stuck`, the reason). */
  | { kind: 'dependency'; on: TaskId[]; stuck: string | null }
  /** An unblock run for the task is still going: a person retried it meanwhile, and it starts once that run stops. */
  | { kind: 'unblocking' }
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
  /** Why a parked task waits, and for what; null in every other status. */
  park_reason: string | null;
  /** 1 or 0 overrides the repo's auto_merge; null follows it. */
  auto_merge: number | null;
  /** The branch the task's work starts from and lands on; null is the repo's base. */
  target: string | null;
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
  /** The model of the latest work run, which differs from `model` after an escalated retry; null before any run. */
  run_model: string | null;
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

/** One status change in a task's history. Tasks from before migration step 6 have none. */
export interface TaskEventRow {
  id: number;
  task_id: TaskId;
  type:
    | 'created'
    | 'edit'
    | 'merge'
    | 'pr'
    | 'pr_closed'
    | 'sync'
    | 'plan_unfinished'
    | 'environment_block'
    | 'unblock_ask'
    | 'escalate'
    | 'claim'
    | 'finish'
    | 'rate_limited'
    | 'conflict'
    | 'cancel'
    | 'approve'
    | 'reject'
    | 'park'
    | 'lift'
    | 'retry'
    | 'unblock_retry'
    | 'review_retry'
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
  /** The branch to start from and land on, which must exist locally or on origin; omitted or null is the repo's base. */
  target?: string | null;
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
  /** The branch to start from and land on; null is the repo's base. Refused once the task has a branch. */
  target?: string | null;
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
  /** The model the next attempt runs on; a retry that names one is never escalated. */
  model?: string;
  /** The turn limit the next attempt runs with, set in the same guarded write as the retry. */
  max_turns?: number;
}

/** POST /api/tasks/:id/park: `reason` says why the proposal waits, and for what. */
export interface ParkRequest {
  reason?: string;
}

/** POST /api/tasks/:id/done: `note` is kept on the timeline. */
export interface MarkDoneRequest {
  note?: string;
}

/** GET /api/tasks/:id/plans/:planId */
export interface PlanHtml {
  html: string;
}
