// Runs one headless `claude -p` process with stream-json output: logs every line,
// reports the usage windows it sees, and returns the final result event.
import { spawn } from 'node:child_process';
import { accessSync, constants, type WriteStream } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeBin } from '../config.ts';
import { activeChildren, killGroup } from './processes.ts';

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Where the claude binary is, or null. A bare name is looked up on PATH. */
export function findClaude(): string | null {
  const bin = claudeBin();
  if (isAbsolute(bin) || bin.includes('/')) return executable(bin) ? bin : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && executable(join(dir, bin))) return join(dir, bin);
  }
  return null;
}

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
  /** The end of what claude wrote to stderr, e.g. why it refused to start. */
  stderr: string;
  /** The session claude's first `system`/`init` line named; undefined if claude stopped before it. */
  sessionId: string | undefined;
}

const STDERR_TAIL = 4_000;

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
  /** Called with each parsed event of the stream. */
  onEvent?: (ev: any) => void;
  /** Called once with the session id from claude's init line, so a run a restart ends can be resumed. */
  onSession?: (sessionId: string) => void;
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

  const run: ClaudeRun = {
    result: undefined,
    exitCode: -1,
    rateLimitedUntil: undefined,
    cancelled: false,
    stderr: '',
    sessionId: undefined,
  };

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
    opts.onEvent?.(ev);
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && run.sessionId === undefined) {
      run.sessionId = ev.session_id;
      opts.onSession?.(ev.session_id);
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
  child.stderr.on('data', (d: Buffer) => {
    run.stderr = (run.stderr + d.toString()).slice(-STDERR_TAIL);
    log.write(JSON.stringify({ type: 'agentdeck_stderr', text: d.toString() }) + '\n');
  });

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
