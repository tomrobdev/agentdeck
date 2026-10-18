// Runs one headless `claude -p` process with stream-json output: logs every line,
// records the usage windows it reports, and returns the final result event.
import { type ChildProcess, spawn } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { claudeBin } from './config.ts';
import type { Db } from './db.ts';

/** Live claude processes, so the daemon can stop them on shutdown. */
export const activeChildren = new Set<ChildProcess>();

export interface ClaudeResult {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  structured_output?: unknown;
  session_id?: string;
  num_turns?: number;
  total_cost_usd?: number;
  api_error_status?: number | null;
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

export async function runClaude(
  db: Db,
  opts: { args: string[]; cwd: string; log: WriteStream; env?: Record<string, string>; shouldCancel?: () => boolean },
): Promise<ClaudeRun> {
  const { log } = opts;
  const child = spawn(claudeBin(), opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);

  const run: ClaudeRun = { result: undefined, exitCode: -1, rateLimitedUntil: undefined, cancelled: false };

  const cancelTimer = opts.shouldCancel
    ? setInterval(() => {
        if (!run.cancelled && opts.shouldCancel!()) {
          run.cancelled = true;
          child.kill('SIGTERM');
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
        db.recordUsageWindow(window, w.utilization ?? 0, w.resetsAt ?? 0, info.status ?? null);
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
