// The run entity and how a task's earlier runs bear on the next.
import type { PlannerRunId, RunId, TaskId } from '../shared/index.ts';
import type { RunEnd, RunSummary } from './translate/summary.ts';

/**
 * `work` is an attempt at the task; `resolve` merges the base branch into the task's branch and never uses an attempt;
 * `unblock` reads why a blocked task stopped and retries it with a note or asks a question (domain/runs/unblock.ts), and
 * never uses an attempt either; `review` reads a done task's changes against its Goal, Definition of done and plan steps,
 * and answers with findings (domain/runs/review.ts); `verify` checks a proposed or queued task's prompt against the base,
 * claim by claim (domain/runs/verify.ts). Neither uses an attempt.
 */
export type RunKind = 'work' | 'resolve' | 'unblock' | 'review' | 'verify';

/** A run (or planner run) with a recorded pid: where a claude process may still be. */
export interface PidRun {
  kind: RunKind | 'planner';
  id: RunId | PlannerRunId;
  pid: number;
  /** When the pid was stored (the run's start for a row from before that was recorded). */
  pid_at: string;
  ended_at: string | null;
}

/** A running task with its unfinished work run, if it has one. */
export interface RunningTaskRun {
  id: TaskId;
  pid: number | null;
  pid_at: string | null;
  started_at: string | null;
}

export const runLabel = (run: Pick<Run, 'kind' | 'attempt'>): string =>
  run.kind === 'resolve' ? 'Resolve conflicts' : run.kind === 'review' ? 'Review' : run.kind === 'verify' ? 'Verify' : `Run ${run.attempt}`;

export type Outcome = 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited';

/** How a run ended: a worker's result, or `interrupted` when a daemon restart ended it. */
export type RunOutcome = Outcome | typeof INTERRUPTED;

export interface Run {
  id: RunId;
  task_id: TaskId;
  kind: RunKind;
  attempt: number; // a resolve or unblock run carries the attempt it ran beside
  started_at: string;
  ended_at: string | null;
  outcome: RunOutcome | null;
  exit_code: number | null;
  session_id: string | null; // stored when claude's init line names it, so a run a restart ends can be resumed
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  tests_passed: boolean | null; // null when no test command
  result_text: string | null;
  log_path: string;
  pid: number | null; // claude's process group while the run is live
  denials: number; // tool uses refused by the permission rules during the run
  live_turns: number; // turns so far while the run is live (domain/runs/translate/live.ts)
  live_tool: string | null; // the last tool call while the run is live, in a few words
  pid_at: string | null; // when `pid` was stored: claude started then, which can be well after `started_at` (setup, a sync)
  /** The model the run was started with (`runModel`); null for a run from before runs recorded it, which reads as unknown. */
  model: string | null;
  /** The exact model id claude's init line names, such as claude-sonnet-5-5; null until it arrives. */
  model_id: string | null;
  /**
   * For a review run, the patch-id of the task's changes it was started to read (`diffHash` on the Workspace port), kept
   * even when the run fails or answers nothing usable, so the diff is known to have had its review run. Null for other kinds.
   */
  diff_hash: string | null;
  /** For a verify run, the base commit its checkout read (`head` on the Workspace port); null for other kinds. */
  base_commit: string | null;
  /**
   * How a failed or blocked work run's claude ended (`runEndOf`), kept when the run ends because its log is not kept for
   * good; null for a run that ended any other way and for one from before this was recorded, which reads as unknown.
   */
  run_end: RunEnd | null;
  /** Whether the last test run of that run failed; null with no test run, and for a run with no `run_end`. */
  last_test_failed: boolean | null;
}

export const DEFAULT_SUPPORT_MODEL = 'sonnet';

export const DEFAULT_REVIEW_MODEL = 'opus';

/** The settings `runModel` reads: the support model and the review model. */
export interface RunModels {
  support_model: string;
  review_model: string;
}

export function runModel(kind: RunKind, task: { model: string }, models: RunModels): string {
  if (kind === 'work') return task.model;
  return kind === 'review' || kind === 'verify' ? models.review_model : models.support_model;
}

export const INTERRUPTED = 'interrupted';

const ATTEMPT_GIVEN_BACK = [INTERRUPTED, 'rate_limited'];

function unfinishedRuns(task: { attempts: number }, previousRuns: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of previousRuns.filter((r) => r.kind === 'work').reverse()) {
    if (r.attempt !== task.attempts || !ATTEMPT_GIVEN_BACK.includes(r.outcome ?? '')) break;
    out.push(r);
  }
  return out;
}

function sessionRun(task: { attempts: number }, previousRuns: Run[]): Run | undefined {
  return unfinishedRuns(task, previousRuns).find((r) => r.outcome === INTERRUPTED && r.session_id);
}

export function resumableSession(task: { attempts: number }, previousRuns: Run[]): string | null {
  return sessionRun(task, previousRuns)?.session_id ?? null;
}

/** A task's timeline entry, as far as `editsSinceCutOff` reads it. */
export interface EditLike {
  type: string;
  reason: string | null;
  at: string;
}

const PROMPT_FIELDS = ['prompt', 'plan_task', 'plan_steps', 'plan'];

export function editsSinceCutOff(
  task: { attempts: number },
  previousRuns: Run[],
  edits: { own: EditLike[]; planOwner?: EditLike[] },
): string[] {
  const since = sessionRun(task, previousRuns)?.ended_at;
  if (!since) return [];
  const fields = (events: EditLike[], wanted: string[]) =>
    events
      .filter((e) => e.type === 'edit' && e.at >= since)
      .flatMap((e) => (e.reason ?? '').split(',').map((f) => f.trim()))
      .filter((f) => wanted.includes(f));
  const changed = [...fields(edits.own, PROMPT_FIELDS), ...fields(edits.planOwner ?? [], ['plan']).map(() => 'plan')];
  return [...new Set(changed)];
}

export function resumeMaxTurns(task: { attempts: number; max_turns: number }, previousRuns: Run[]): number {
  const used = unfinishedRuns(task, previousRuns).reduce((n, r) => n + (r.num_turns ?? r.live_turns), 0);
  return Math.max(task.max_turns - used, 1);
}

export function pickRun(runs: Run[], pick: { attempt?: number; run?: number } = {}): Run | undefined {
  if (pick.run) return runs.find((r) => r.id === pick.run);
  if (pick.attempt) return runs.findLast((r) => r.attempt === pick.attempt && r.kind === 'work');
  return runs.at(-1);
}

export const runEndOf = (summary: Pick<RunSummary, 'end' | 'last_test'>): Pick<Run, 'run_end' | 'last_test_failed'> => ({
  run_end: summary.end,
  last_test_failed: summary.last_test === null ? null : summary.last_test === 'failed',
});
