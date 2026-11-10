// Reading a run's result: what claude left behind, how it classifies, and what the run came to.
import { STATUS_WORD, lastLine, oneLine } from '../shared/index.ts';
import { type Needs, parseNeeds } from '../work/index.ts';
import type { Outcome, Run } from './run.ts';

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
