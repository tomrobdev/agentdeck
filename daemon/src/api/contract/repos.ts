// Repos: the registered repos, their settings and health, and the planner's proposals.
import type { PlannerRunId, RepoId } from '../../domain/shared/index.ts';
import type { PlannerOutcome } from '../../domain/proposals/index.ts';
import type { MergeMethod, PrMode, ToolRulesSource } from '../../domain/repos/index.ts';
import type { Task } from './work.ts';

export interface Repo {
  id: RepoId;
  name: string;
  path: string;
  base_branch: string;
  test_cmd: string | null;
  /** JSON array of the repo's own tool rules; null = the defaults plus the rules detected from its toolchain. */
  allowed_tools: string | null;
  /** Which rules its workers run with. Missing from a daemon that predates it. */
  tools_source?: ToolRulesSource;
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
  /** 1 = the daemon starts a review run on its own when a task is done (off by default). Missing from a daemon that predates it. */
  auto_review?: number;
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
  /**
   * 1 = a GitHub check that never started (a billing stop, a spending limit) does not stop auto-merge when the last tested
   * run passed (off by default). Missing from a daemon that predates it.
   */
  ci_not_run_ok?: number;
  /** A branch adding more code comment lines is over the limit; 0 turns this limit off. Missing from a daemon that predates it. */
  code_comment_max_lines?: number;
  /** A branch whose added lines are a greater share of code comments, in percent, is over the limit; 0 turns this limit off. Missing from a daemon that predates it. */
  code_comment_max_percent?: number;
  /** The model a new task of the repo takes when it names none; null follows the default_model setting. Missing from a daemon that predates it. */
  model?: string | null;
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
  auto_review?: boolean;
  sandbox?: boolean;
  network?: string[];
  auto_merge?: boolean;
  auto_merge_max_lines?: number;
  auto_merge_skip?: string[];
  ci_not_run_ok?: boolean;
  code_comment_max_lines?: number;
  code_comment_max_percent?: number;
  /** A model alias or claude-… id; null or "" clears it. */
  model?: string | null;
  /** The repo's own tool rules; null or [] goes back to the detected ones. */
  allowed_tools?: string[] | null;
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

/** POST /api/repos/:id/plan */
export interface ProposalResult {
  outcome: PlannerOutcome | 'no_goals';
  /** The proposals as stored, without the queue's view of them. */
  tasks: Pick<Task, 'id' | 'title' | 'prompt' | 'status'>[];
  skipped: string[];
  note: string | null;
}
