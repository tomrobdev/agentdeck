// The run entity and how to read a run's result. Pure: no I/O.
import { lastLine } from '../text.ts';
import { type Needs, parseNeeds } from '../task/needs.ts';

/**
 * `work` is an attempt at the task; `resolve` merges the base branch into the task's branch and never uses an attempt;
 * `unblock` reads why a blocked task stopped and retries it with a note or asks a question (domain/run/unblock.ts), and
 * never uses an attempt either.
 */
export type RunKind = 'work' | 'resolve' | 'unblock';

/** A run's name in the dashboard: "Run 2", or "Resolve conflicts" for the resolve run of a sync. */
export const runLabel = (run: Pick<Run, 'kind' | 'attempt'>): string =>
  run.kind === 'resolve' ? 'Resolve conflicts' : `Run ${run.attempt}`;

/** How a run ended: a worker's result, or `interrupted` when a daemon restart ended it. */
export type RunOutcome = Outcome | typeof INTERRUPTED;

export interface Run {
  id: number;
  task_id: number;
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
  tests_passed: number | null; // 1, 0, or null when no test command
  result_text: string | null;
  log_path: string;
  pid: number | null; // claude's process group while the run is live
  denials: number; // tool uses refused by the permission rules during the run
  live_turns: number; // turns so far while the run is live (domain/run/live.ts)
  live_tool: string | null; // the last tool call while the run is live, in a few words
  pid_at: string | null; // when `pid` was stored: claude started then, which can be well after `started_at` (setup, a sync)
}

/**
 * The outcome of a run that a daemon restart ended (a SIGTERM or a crash): not a failure, and it uses no attempt.
 * The task's next run continues its claude session (`resumableSession`).
 */
export const INTERRUPTED = 'interrupted';

/** The outcomes that end a run without ending its attempt: a restart or a rate limit gives the attempt back. */
const ATTEMPT_GIVEN_BACK = [INTERRUPTED, 'rate_limited'];

/**
 * The task's latest work runs that a restart or a rate limit ended on its current attempt, newest first: the runs the
 * attempt is still in the middle of. Empty when the latest work run ended any other way or on another attempt.
 */
function unfinishedRuns(task: { attempts: number }, previousRuns: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of previousRuns.filter((r) => r.kind === 'work').reverse()) {
    if (r.attempt !== task.attempts || !ATTEMPT_GIVEN_BACK.includes(r.outcome ?? '')) break;
    out.push(r);
  }
  return out;
}

/**
 * The run whose claude session the task's next work run should resume: the newest interrupted run of the current
 * attempt (a restart gives the attempt back, so the next run carries the same number) that has a session, looking past
 * runs a restart ended before claude named one (say, during setup) and runs a rate limit ended (a resume that was rate
 * limited, or a sync whose resolve run was).
 */
function sessionRun(task: { attempts: number }, previousRuns: Run[]): Run | undefined {
  return unfinishedRuns(task, previousRuns).find((r) => r.outcome === INTERRUPTED && r.session_id);
}

/** The claude session the task's next work run should resume (`sessionRun`), or null to start afresh. */
export function resumableSession(task: { attempts: number }, previousRuns: Run[]): string | null {
  return sessionRun(task, previousRuns)?.session_id ?? null;
}

/** A task's timeline entry, as far as `editsSinceCutOff` reads it. */
export interface EditLike {
  type: string;
  reason: string | null;
  at: string;
}

/** The task fields whose edit the cut-off session never saw: it holds the old prompt or plan. `plan` is a plan attached. */
const PROMPT_FIELDS = ['prompt', 'plan_task', 'plan_steps', 'plan'];

/**
 * What a person changed that the session `resumableSession` names was never told, as field names: the task's prompt or
 * plan link (`own`, the task's timeline) or the plan it follows (`planOwner`, the timeline of the task the plan belongs
 * to, when that is another task), edited since the session's run ended. Non-empty means start afresh: the fresh prompt
 * has the new prompt and plan, and the session would work from the old ones. An edit in the second the run ended
 * counts, so a doubt starts afresh.
 */
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

/**
 * The `--max-turns` of a run that resumes a cut-off session: the task's limit less the turns the attempt's runs since
 * its last real end used (from claude's result, else as counted live), so restarts don't stretch the limit. At least 1.
 */
export function resumeMaxTurns(task: { attempts: number; max_turns: number }, previousRuns: Run[]): number {
  const used = unfinishedRuns(task, previousRuns).reduce((n, r) => n + (r.num_turns ?? r.live_turns), 0);
  return Math.max(task.max_turns - used, 1);
}

/**
 * The run a person asked for: by id, by attempt (its latest work run, so a resume after a restart rather than the run
 * the restart cut off), or the latest. A resolve or unblock run is only picked by id.
 */
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

/**
 * The run row's fields that claude's exit code and final result decide. `sessionId` is the one claude's init line
 * named, kept when there is no result, so a run that ends without one does not lose its session.
 */
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

/**
 * Whether a claude started with `--resume` stopped at once because its session is gone (or never existed here): it
 * ended without a result (or with an error one) saying the conversation was not found. Only then does the run start
 * afresh instead; any other early exit (bad settings, say) is the run's failure, not a lost session.
 */
export function resumeFailed(run: ClaudeRunLike): boolean {
  if (run.cancelled || run.rateLimitedUntil || (run.result && !run.result.is_error)) return false;
  return /no conversation found/i.test(`${run.stderr}\n${run.result?.result ?? ''}`);
}

export type RunClass<R extends ResultLike = ResultLike> =
  | { kind: 'cancelled' }
  | { kind: 'rate_limited'; until: number; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'finished'; result: R };

/** What a claude process's end means: a cancel wins over a rate limit, which wins over a failure. */
export function classifyRun<R extends ResultLike>(run: ClaudeRunLike<R>): RunClass<R> {
  if (run.cancelled) return { kind: 'cancelled' };
  if (run.rateLimitedUntil) {
    const until = run.rateLimitedUntil;
    return { kind: 'rate_limited', until, reason: `rate limited until ${new Date(until * 1000).toISOString()}` };
  }
  const { result, exitCode, stderr } = run;
  if (!result || result.is_error || exitCode !== 0) {
    // No result means claude stopped before working, e.g. the sandbox could not start (failIfUnavailable): say why.
    return {
      kind: 'failed',
      reason: result?.subtype ?? `claude exited with code ${exitCode}${stderr.trim() ? `: ${lastLine(stderr)}` : ''}`,
    };
  }
  return { kind: 'finished', result };
}

export type Outcome = 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited';

export interface WorkerResult {
  outcome: Outcome;
  reason?: string;
  /** For a blocked run: what the worker said it needs. */
  needs?: Needs;
  /** For a blocked run: the environment is to blame, so the attempt is given back. */
  environment?: boolean;
}

/** How the stop reason of a task whose setup command failed begins. */
const SETUP_FAILED = 'setup failed: ';

/** The stop reason when the repo's setup command failed in the worktree: its output's last line. */
export const setupFailedReason = (output: string): string => `${SETUP_FAILED}${lastLine(output)}`;

/** Whether a stop reason says the setup command failed (`setupFailedReason`). */
export const isSetupFailure = (reason: string | null | undefined): boolean => (reason ?? '').startsWith(SETUP_FAILED);

/** A block the environment caused, not the task: the worker named a need, tool uses were refused, or setup failed. */
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

/**
 * The outcome of a run and whether to pause its repo. A finished run is blocked when the agent says so, failed when the
 * tests failed, and blocked when it is done without a commit. Refused tool uses make a block environmental, and pause
 * the repo (the tool rules don't fit its work, so every further task would hit the same wall), unless the agent finished
 * and only the test command failed: then the refusals didn't stop it. A block the worker reported as a need (`NEEDS …`)
 * never pauses: the refusal was expected, the task says what it needs, and the repo's other tasks are not stuck on it.
 */
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
  if (r.testsPassed === false) return { outcome: 'failed', reason: 'tests failed' };
  if (r.commitsAhead === 0) return { outcome: 'blocked', reason: 'agent finished without changing anything' };
  return { outcome: 'done' };
}

/** Pull "STATUS: BLOCKED: reason" out of the agent's final message. */
export function parseStatus(text: string | undefined): { blocked: boolean; reason?: string; declared: boolean; needs?: Needs } {
  const lines = (text ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    const m = line.trim().match(/^STATUS:\s*(DONE|BLOCKED)(?::\s*(.*))?$/i);
    if (m) {
      const blocked = m[1].toUpperCase() === 'BLOCKED';
      const reason = m[2]?.trim();
      const needs = blocked ? parseNeeds(reason) : undefined;
      return { blocked, reason, declared: true, ...(needs ? { needs } : {}) };
    }
  }
  return { blocked: false, declared: false };
}

/** The first refused command of a run, on one line, for a pause reason. */
export function firstDenial(denials: { tool_name?: string; tool_input?: { command?: unknown } }[]): string {
  const d = denials[0];
  const command = typeof d?.tool_input?.command === 'string' ? d.tool_input.command : (d?.tool_name ?? 'unknown tool');
  return command.replace(/\s+/g, ' ').trim().slice(0, 200);
}
