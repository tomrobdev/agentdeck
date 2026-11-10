// Runs one headless `claude -p` process with stream-json output: logs every line, reports the usage windows it sees, and returns the final result event.
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
export const CANCEL_GRACE_MS = 10_000;

export async function runClaude(opts: {
  args: string[];
  cwd: string;
  log: WriteStream;
  env?: Record<string, string>;
  shouldCancel?: () => boolean;
  cancelGraceMs?: number;
  onSpawn?: (pid: number) => void;
  onUsage?: (w: UsageWindow) => void;
  onEvent?: (ev: any) => void;
  onSession?: (sessionId: string) => void;
  onModel?: (modelId: string) => void;
}): Promise<ClaudeRun> {
  const { log } = opts;
  const child = spawn(claudeBin(), opts.args, {
    cwd: opts.cwd,
    env: withToolchainPath({ ...process.env, ...opts.env }) as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
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
  clearTimeout(killTimer);
  activeChildren.delete(child);

  if (run.result?.api_error_status === 429 && !run.rateLimitedUntil) run.rateLimitedUntil = Math.floor(Date.now() / 1000) + 15 * 60;
  return run;
}
