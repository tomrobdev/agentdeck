// Runs one headless `claude -p` process with stream-json output: logs every line,
// reports the usage windows it sees, and returns the final result event.
import { spawn } from 'node:child_process';
import { accessSync, constants, type WriteStream } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeBin, withToolchainPath } from '../../config.ts';
import type { ClaudeRun, UsageWindow } from '../../domain/runs/index.ts';
import { activeChildren, killGroup } from '../process/processes.ts';

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

const STDERR_TAIL = 4_000;

const CANCEL_POLL_MS = 2_000;
/** After a cancel's SIGTERM, how long the process group has to exit before SIGKILL. */
export const CANCEL_GRACE_MS = 10_000;

export async function runClaude(opts: {
  args: string[];
  cwd: string;
  log: WriteStream;
  env?: Record<string, string>;
  shouldCancel?: () => boolean;
  /** How long a cancelled group may take to exit after SIGTERM before it gets SIGKILL. */
  cancelGraceMs?: number;
  /** Called with the pid (= process group id) so it can be recorded for crash recovery. */
  onSpawn?: (pid: number) => void;
  /** Called for each usage window a rate_limit_event reports. */
  onUsage?: (w: UsageWindow) => void;
  /** Called with each parsed event of the stream. */
  onEvent?: (ev: any) => void;
  /** Called once with the session id from claude's init line, so a run a restart ends can be resumed. */
  onSession?: (sessionId: string) => void;
  /** Called once with the exact model id from claude's init line (such as claude-sonnet-5-5), so the run records it. */
  onModel?: (modelId: string) => void;
}): Promise<ClaudeRun> {
  const { log } = opts;
  const child = spawn(claudeBin(), opts.args, {
    cwd: opts.cwd,
    env: withToolchainPath({ ...process.env, ...opts.env }) as NodeJS.ProcessEnv,
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

  let killTimer: NodeJS.Timeout | undefined;
  const cancelTimer = opts.shouldCancel
    ? setInterval(() => {
        if (!run.cancelled && opts.shouldCancel!()) {
          run.cancelled = true;
          killGroup(child.pid);
          // A group that ignores SIGTERM would keep the task in cancel_requested, so follow with SIGKILL.
          killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), opts.cancelGraceMs ?? CANCEL_GRACE_MS);
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
      if (typeof ev.model === 'string' && ev.model) opts.onModel?.(ev.model);
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
  clearTimeout(killTimer); // the group is gone: its id may be reused
  activeChildren.delete(child);

  if (run.result?.api_error_status === 429 && !run.rateLimitedUntil) run.rateLimitedUntil = Math.floor(Date.now() / 1000) + 15 * 60;
  return run;
}
