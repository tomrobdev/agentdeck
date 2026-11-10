// The run entity and how to read a run's result.
import type { PlannerRunId, RunId, TaskId } from '../shared/index.ts';
import { STATUS_WORD, lastLine, oneLine } from '../shared/index.ts';
import { type Needs, parseNeeds } from '../work/index.ts';
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

/** The parts of claude's final `result` event that a run records. */
export interface ResultLike {
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  result?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export function resultFields(result: ResultLike | undefined, exitCode: number, sessionId?: string): Partial<Run> {
  const usage = result?.usage ?? {};
  return {
    exit_code: exitCode,
    session_id: result?.session_id ?? sessionId ?? null,
    num_turns: result?.num_turns ?? null,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    cost_usd: result?.total_cost_usd ?? 0,
    result_text: result?.result ?? null,
  };
}

/** The final `result` event of a claude session. */
export interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  api_error_status?: number | null;
  /** Tool uses the permission rules refused during the run. */
  permission_denials?: { tool_name?: string; tool_input?: { command?: unknown } & Record<string, unknown> }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** What a claude session left behind: its result, how the process ended, and why it stopped. */
export interface ClaudeRun {
  result: ClaudeResult | undefined;
  exitCode: number;
  /** Set when Claude rejected a request on rate limits (unix seconds). */
  rateLimitedUntil: number | undefined;
  cancelled: boolean;
  /** The end of what claude wrote to stderr, e.g. why it refused to start. */
  stderr: string;
  /** The session claude's first `system`/`init` line named; undefined if claude stopped before it. */
  sessionId: string | undefined;
}

/** One usage window a claude session reports. */
export interface UsageWindow {
  window: string;
  utilization: number;
  resets_at: number;
  status: string | null;
}

/** What a finished `claude` process left behind (the adapter's `ClaudeRun`). */
export interface ClaudeRunLike<R extends ResultLike = ResultLike> {
  result: (R & { is_error?: boolean; subtype?: string }) | undefined;
  exitCode: number;
  /** Set when Claude rejected a request on rate limits (unix seconds). */
  rateLimitedUntil: number | undefined;
  cancelled: boolean;
  stderr: string;
  /** The session claude's init line named; undefined if it stopped before. */
  sessionId?: string;
}

export function resumeFailed(run: ClaudeRunLike): boolean {
  if (run.cancelled || run.rateLimitedUntil || (run.result && !run.result.is_error)) return false;
  return /no conversation found/i.test(`${run.stderr}\n${run.result?.result ?? ''}`);
}

export type RunClass<R extends ResultLike = ResultLike> =
  | { kind: 'cancelled' }
  | { kind: 'rate_limited'; until: number; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'finished'; result: R };

export function classifyRun<R extends ResultLike>(run: ClaudeRunLike<R>): RunClass<R> {
  if (run.cancelled) return { kind: 'cancelled' };
  if (run.rateLimitedUntil) {
    const until = run.rateLimitedUntil;
    return { kind: 'rate_limited', until, reason: `rate limited until ${new Date(until * 1000).toISOString()}` };
  }
  const { result, exitCode, stderr } = run;
  if (!result || result.is_error || exitCode !== 0) {
    const why = stderr.trim() ? `: ${lastLine(stderr)}` : '';
    const stopped = exitCode === 0 ? NO_RESULT[0] : `${NO_RESULT[1]}${exitCode}`;
    return { kind: 'failed', reason: result?.subtype ?? `${stopped}${why}` };
  }
  return { kind: 'finished', result };
}

const NO_RESULT = ['claude ended without a result', 'claude exited with code '];

export const isNoResult = (reason: string | null | undefined): boolean => NO_RESULT.some((r) => (reason ?? '').startsWith(r));

export const TURN_LIMIT = 'error_max_turns';

export const TESTS_FAILED = 'tests failed';

export const NO_CHANGE = 'agent finished without changing anything';

export type Outcome = 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited';

export interface WorkerResult {
  outcome: Outcome;
  reason?: string;
  /** For a blocked run: what the worker said it needs. */
  needs?: Needs;
  /** For a blocked run: the environment is to blame, so the attempt is given back. */
  environment?: boolean;
}

const SETUP_FAILED = 'setup failed: ';

export const setupFailedReason = (output: string): string => `${SETUP_FAILED}${lastLine(output)}`;

export const isSetupFailure = (reason: string | null | undefined): boolean => (reason ?? '').startsWith(SETUP_FAILED);

export function isEnvironmentBlock(b: { needs?: Needs; denials?: number; setupFailed?: boolean }): boolean {
  return !!b.needs || (b.denials ?? 0) > 0 || !!b.setupFailed;
}

/** What a run came to, for `runOutcome`. */
export interface RunCameTo {
  /** How claude's process ended; a `finished` one has its final message in `status`. */
  end: { kind: 'cancelled' | 'finished' } | { kind: 'rate_limited' | 'failed'; reason: string };
  /** The final message's status (`parseStatus`); read only for a finished run. */
  status?: ReturnType<typeof parseStatus>;
  /** Whether the repo's test command passed; null when it was not run (no command, or the agent reported blocked). */
  testsPassed: boolean | null;
  /** Commits on the branch past the base; null when not counted (only a run that could be done needs it). */
  commitsAhead: number | null;
  /** Tool uses the permission rules refused during the run. */
  denials: number;
}

export function runOutcome(r: RunCameTo): { result: WorkerResult; pause: boolean } {
  const result = baseOutcome(r);
  if (result.outcome === 'blocked' && isEnvironmentBlock({ needs: result.needs, denials: r.denials })) result.environment = true;
  const reported = result.outcome === 'blocked' && !!result.needs;
  const pause = r.denials > 0 && r.testsPassed !== false && !reported && (result.outcome === 'blocked' || result.outcome === 'failed');
  return { result, pause };
}

function baseOutcome(r: RunCameTo): WorkerResult {
  const { end } = r;
  if (end.kind === 'cancelled') return { outcome: 'cancelled' };
  if (end.kind === 'rate_limited') return { outcome: 'rate_limited', reason: end.reason };
  if (end.kind === 'failed') return { outcome: 'failed', reason: end.reason };
  const status = r.status ?? { blocked: false, declared: false };
  if (status.blocked) {
    return { outcome: 'blocked', reason: status.reason ?? 'agent reported blocked', ...(status.needs ? { needs: status.needs } : {}) };
  }
  if (r.testsPassed === false) return { outcome: 'failed', reason: TESTS_FAILED };
  if (r.commitsAhead === 0) return { outcome: 'blocked', reason: NO_CHANGE };
  return { outcome: 'done' };
}

const STATUS_LINE = new RegExp(String.raw`^${STATUS_WORD}(?::\s*(.*))?$`, 'i');

export function parseStatus(text: string | undefined): { blocked: boolean; reason?: string; declared: boolean; needs?: Needs } {
  const lines = (text ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    const m = line.trim().match(STATUS_LINE);
    if (m) {
      const blocked = m[1].toUpperCase() === 'BLOCKED';
      const reason = m[2]?.trim();
      const needs = blocked ? parseNeeds(reason) : undefined;
      return { blocked, reason, declared: true, ...(needs ? { needs } : {}) };
    }
  }
  return { blocked: false, declared: false };
}

export function firstDenial(denials: { tool_name?: string; tool_input?: { command?: unknown } }[]): string {
  const d = denials[0];
  const command = typeof d?.tool_input?.command === 'string' ? d.tool_input.command : (d?.tool_name ?? 'unknown tool');
  return oneLine(command).slice(0, 200);
}

export const runEndOf = (summary: Pick<RunSummary, 'end' | 'last_test'>): Pick<Run, 'run_end' | 'last_test_failed'> => ({
  run_end: summary.end,
  last_test_failed: summary.last_test === null ? null : summary.last_test === 'failed',
});
