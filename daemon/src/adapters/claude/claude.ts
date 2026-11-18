// Runs one headless `claude -p` process with stream-json output: logs every line, reports the usage windows it sees, and returns the final result event.
import { spawn } from 'node:child_process';
import { accessSync, constants, type WriteStream } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { CANCEL_POLL_MS, claudeBin, withToolchainPath } from '#src/config.ts';
import type { ClaudeResult, ClaudeRun, UsageWindow } from '#domain/runs/index.ts';
import { activeChildren, killGroup } from '#adapters/process/processes.ts';

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

const fields = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const numberOr = <T>(v: unknown, or: T): number | T => (typeof v === 'number' ? v : or);

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
  onEvent?: (ev: unknown) => void;
  onSession?: (sessionId: string) => void;
  onModel?: (modelId: string) => void;
}): Promise<ClaudeRun> {
  const { log } = opts;
  if (!isAbsolute(opts.cwd)) throw new Error(`claude needs an absolute working directory, not "${opts.cwd}"`);
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
  const shouldCancel = opts.shouldCancel;
  const cancelTimer = shouldCancel
    ? setInterval(() => {
        if (!run.cancelled && shouldCancel()) {
          run.cancelled = true;
          killGroup(child.pid);
          killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), opts.cancelGraceMs ?? CANCEL_GRACE_MS);
        }
      }, CANCEL_POLL_MS)
    : undefined;

  createInterface({ input: child.stdout }).on('line', (line) => {
    log.write(line + '\n');
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    opts.onEvent?.(parsed);
    const ev = fields(parsed);
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && run.sessionId === undefined) {
      run.sessionId = ev.session_id;
      opts.onSession?.(ev.session_id);
      if (typeof ev.model === 'string' && ev.model) opts.onModel?.(ev.model);
    }
    if (ev.type === 'result') run.result = ev as ClaudeResult;
    if (ev.type === 'rate_limit_event') {
      const info = fields(ev.rate_limit_info);
      const status = typeof info.status === 'string' ? info.status : null;
      for (const [window, raw] of Object.entries(fields(info.unifiedWindows))) {
        const w = fields(raw);
        opts.onUsage?.({ window, utilization: numberOr(w.utilization, 0), resets_at: numberOr(w.resetsAt, 0), status });
      }
      if (status === 'rejected') run.rateLimitedUntil = numberOr(info.resetsAt, undefined);
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
