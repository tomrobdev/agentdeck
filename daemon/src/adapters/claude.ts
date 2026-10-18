// Runs one headless `claude -p` process with stream-json output: logs every line,
// reports the usage windows it sees, and returns the final result event.
import { spawn } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { claudeBin } from '../config.ts';
import { activeChildren, killGroup } from './processes.ts';

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

export interface ClaudeRun {
  result: ClaudeResult | undefined;
  exitCode: number;
  /** Set when Claude rejected a request on rate limits (unix seconds). */
  rateLimitedUntil: number | undefined;
  cancelled: boolean;
}

const CANCEL_POLL_MS = 2_000;

export interface UsageWindow {
  window: string;
  utilization: number;
  resets_at: number;
  status: string | null;
}

export async function runClaude(opts: {
  args: string[];
  cwd: string;
  log: WriteStream;
  env?: Record<string, string>;
  shouldCancel?: () => boolean;
  /** Called with the pid (= process group id) so it can be recorded for crash recovery. */
  onSpawn?: (pid: number) => void;
  /** Called for each usage window a rate_limit_event reports. */
  onUsage?: (w: UsageWindow) => void;
}): Promise<ClaudeRun> {
  const { log } = opts;
  const child = spawn(claudeBin(), opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group, so the whole tree can be stopped together
  });
  activeChildren.add(child);
  if (child.pid) opts.onSpawn?.(child.pid);

  const run: ClaudeRun = { result: undefined, exitCode: -1, rateLimitedUntil: undefined, cancelled: false };

  const cancelTimer = opts.shouldCancel
    ? setInterval(() => {
        if (!run.cancelled && opts.shouldCancel!()) {
          run.cancelled = true;
          killGroup(child.pid);
        }
      }, CANCEL_POLL_MS)
    : undefined;

  createInterface({ input: child.stdout }).on('line', (line) => {
    log.write(line + '\n');
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === 'result') run.result = ev;
    if (ev.type === 'rate_limit_event') {
      const info = ev.rate_limit_info ?? {};
      for (const [window, w] of Object.entries<any>(info.unifiedWindows ?? {})) {
        opts.onUsage?.({ window, utilization: w.utilization ?? 0, resets_at: w.resetsAt ?? 0, status: info.status ?? null });
      }
      if (info.status === 'rejected') run.rateLimitedUntil = info.resetsAt;
    }
  });
  child.stderr.on('data', (d: Buffer) => log.write(JSON.stringify({ type: 'agentdeck_stderr', text: d.toString() }) + '\n'));

  run.exitCode = await new Promise((resolve) => {
    child.on('error', (err) => {
      log.write(JSON.stringify({ type: 'agentdeck_error', text: err.message }) + '\n');
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
  clearInterval(cancelTimer);
  activeChildren.delete(child);

  if (run.result?.api_error_status === 429 && !run.rateLimitedUntil) run.rateLimitedUntil = Math.floor(Date.now() / 1000) + 15 * 60;
  return run;
}
