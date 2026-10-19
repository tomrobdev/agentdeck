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

export type Outcome = 'done' | 'blocked' | 'failed' | 'cancelled' | 'rate_limited';

export interface WorkerResult {
  outcome: Outcome;
  reason?: string;
}

/** Pull "STATUS: BLOCKED: reason" out of the agent's final message. */
export function parseStatus(text: string | undefined): { blocked: boolean; reason?: string; declared: boolean } {
  const lines = (text ?? '').trim().split('\n').reverse();
  for (const line of lines) {
    const m = line.trim().match(/^STATUS:\s*(DONE|BLOCKED)(?::\s*(.*))?$/i);
    if (m) return { blocked: m[1].toUpperCase() === 'BLOCKED', reason: m[2]?.trim(), declared: true };
  }
  return { blocked: false, declared: false };
}

/** The first refused command of a run, on one line, for a pause reason. */
export function firstDenial(denials: { tool_name?: string; tool_input?: { command?: unknown } }[]): string {
  const d = denials[0];
  const command = typeof d?.tool_input?.command === 'string' ? d.tool_input.command : (d?.tool_name ?? 'unknown tool');
  return command.replace(/\s+/g, ' ').trim().slice(0, 200);
}
