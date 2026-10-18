// Runs one headless `claude -p` process with stream-json output: logs every line,
// records the usage windows it reports, and returns the final result event.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import type { WriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { claudeBin } from './config.ts';
import type { Db } from './db.ts';

/** Live claude processes, so the daemon can stop them on shutdown. */
export const activeChildren = new Set<ChildProcess>();

/**
 * Signal a claude process and everything it started (bash tools, MCP servers).
 * Each claude runs in its own process group, so its pid is also the group id.
 */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** When the group's leader started (ms), or null if the leader has exited. */
function leaderStartedAt(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? Date.parse(out) : null;
  } catch {
    return null;
  }
}

/**
 * Stop claude processes left behind by a daemon that died without cleaning up, before
 * their tasks are requeued; otherwise two agents end up working in the same worktree.
 * `started_at` is when the run was recorded (UTC, SQLite format). A pid whose leader started
 * at a different time has been reused by an unrelated process and is left alone. A group
 * whose leader has exited is still ours: the OS doesn't reuse an id while its group exists.
 */
export function reapOrphans(runs: { pid: number; started_at: string }[], graceMs = 5_000): number {
  const ours = runs.filter(({ pid, started_at }) => {
    if (!groupAlive(pid)) return false;
    const leader = leaderStartedAt(pid);
    return leader === null || Math.abs(leader - Date.parse(`${started_at.replace(' ', 'T')}Z`)) < 120_000;
  });
  for (const { pid } of ours) killGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (ours.some(({ pid }) => groupAlive(pid)) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 100);
  for (const { pid } of ours) if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
  return ours.length;
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
}

const CANCEL_POLL_MS = 2_000;

export async function runClaude(
  db: Db,
  opts: {
    args: string[];
    cwd: string;
    log: WriteStream;
    env?: Record<string, string>;
    shouldCancel?: () => boolean;
    /** Called with the pid (= process group id) so it can be recorded for crash recovery. */
    onSpawn?: (pid: number) => void;
  },
): Promise<ClaudeRun> {
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
