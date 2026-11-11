// Landing: checks, reviews, auto-merge and merging.
import type { ReviewId, TaskId } from '#domain/shared/index.ts';
import type { AutoMergeState, CheckState, ReviewAuthor } from '#domain/landing/index.ts';
import type { MergeMethod } from '#domain/repos/index.ts';
import type { TaskDetail } from '#api/contract/work.ts';

/** One check on a PR's head commit: a GitHub check run or a commit status. NEUTRAL and SKIPPED conclusions are `skipped`. */
export interface PrCheck {
  name: string;
  state: CheckState;
  url: string | null;
  started_at: string | null;
  completed_at: string | null;
  /** A failing GitHub Actions check's failed step and its link, read once for the head it failed on. */
  step?: string | null;
  step_url?: string | null;
  /** The lines of the failed step's log that say why. */
  excerpt?: string;
  /** Why the log could not be read, in place of the excerpt. */
  excerpt_error?: string;
  /** GitHub's message for a check that never started (`not_run`: a billing stop, a spending limit, a disabled workflow). */
  not_run?: string;
}

/** An open PR's checks in a line's worth: counted, with the failing ones' names. `read_at` is when the PR refresh read them. */
export interface ChecksSummary {
  total: number;
  failing: number;
  pending: number;
  failing_names: string[];
  /** Each failing check in a line: "check › tests and coverage: cli: branches 53.6% is below its floor of 54%". */
  failing_lines: string[];
  /** GitHub's messages for the checks that never started, each once; they count neither as passing nor failing. Missing from a daemon that predates it. */
  not_run?: string[];
  read_at: string;
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
  /** Who made it: a person, or a review run. Missing from a daemon that predates it. */
  by?: ReviewAuthor;
  /** The task's head commit the review read, set at submit; null on a draft or an older review. */
  head_commit?: string | null;
  /** The patch-id of the task's changes against the base branch the review read, set at submit; null on a draft or an older review. */
  diff_hash?: string | null;
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
  /** The tag for a branch over the repo's code comment limits (`code comments +12 (8%)`); null when it is not over. Missing from a daemon that predates it. */
  code_comments?: string | null;
  /**
   * `review`: what the review gate asks, in a repo with auto_review on; null when it is off. Missing from a daemon that
   * predates it.
   */
  limits: { max_lines: number; skip: string[]; tests: string; review?: string | null };
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
