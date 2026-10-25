// The run entity and how to read a run's result. Pure: no I/O.

/** `work` is an attempt at the task; `resolve` merges the base branch into the task's branch and never uses an attempt. */
export type RunKind = 'work' | 'resolve';

export interface Run {
  id: number;
  task_id: number;
  kind: RunKind;
  attempt: number; // a resolve run carries the attempt it ran beside
  started_at: string;
  ended_at: string | null;
  outcome: string | null; // done | blocked | failed | cancelled
  exit_code: number | null;
  session_id: string | null;
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

/** The run row's fields that claude's exit code and final result decide. */
export function resultFields(result: ResultLike | undefined, exitCode: number): Partial<Run> {
  const usage = result?.usage ?? {};
  return {
    exit_code: exitCode,
    session_id: result?.session_id ?? null,
    num_turns: result?.num_turns ?? null,
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_tokens: usage.cache_read_input_tokens ?? 0,
    cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
    cost_usd: result?.total_cost_usd ?? 0,
    result_text: result?.result ?? null,
  };
}

/** The last non-empty line of a command's output, for a one-line reason. */
export function lastLine(output: string): string {
  return (
    output
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? 'no output'
  ).slice(0, 300);
}

/** What a finished `claude` process left behind (the adapter's `ClaudeRun`). */
export interface ClaudeRunLike<R extends ResultLike = ResultLike> {
  result: (R & { is_error?: boolean; subtype?: string }) | undefined;
  exitCode: number;
  /** Set when Claude rejected a request on rate limits (unix seconds). */
  rateLimitedUntil: number | undefined;
  cancelled: boolean;
  stderr: string;
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

export type NeedsKind = 'deps' | 'host' | 'edit';

/** What a blocked worker needs before it can go on: packages, network hosts, or files it may not edit. */
export interface Needs {
  kind: NeedsKind;
  items: string[];
}

/** "NEEDS deps: a b" / "NEEDS host: h" / "NEEDS edit: path" at the start of a blocked reason. */
export function parseNeeds(reason: string | undefined): Needs | undefined {
  const m = reason?.match(/^NEEDS\s+(deps|host|edit)\s*:\s*(.*)$/i);
  if (!m) return undefined;
  const items = m[2].split(/[\s,]+/).filter(Boolean);
  return items.length ? { kind: m[1].toLowerCase() as NeedsKind, items } : undefined;
}

/** A task's `needs` column (JSON), or null when it has none or it is unreadable. */
export function readNeeds(json: string | null): Needs | null {
  if (!json) return null;
  try {
    const n = JSON.parse(json) as Partial<Needs>;
    return n && typeof n.kind === 'string' && Array.isArray(n.items) ? (n as Needs) : null;
  } catch {
    return null;
  }
}

/** A block the environment caused, not the task: the worker named a need, tool uses were refused, or setup failed. */
export function isEnvironmentBlock(b: { needs?: Needs; denials?: number; setupFailed?: boolean }): boolean {
  return !!b.needs || (b.denials ?? 0) > 0 || !!b.setupFailed;
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
