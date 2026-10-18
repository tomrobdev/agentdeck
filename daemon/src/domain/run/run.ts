// The run entity and how to read a run's result. Pure: no I/O.

export interface Run {
  id: number;
  task_id: number;
  attempt: number;
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
