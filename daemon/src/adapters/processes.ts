// Process groups of claude runs: stopping them on shutdown, and after a crash.
import { type ChildProcess, execFileSync } from 'node:child_process';

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
  const ours = runs.filter(ownsLiveGroup);
  for (const { pid } of ours) killGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (ours.some(({ pid }) => groupAlive(pid)) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 100);
  for (const { pid } of ours) if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
  return ours.length;
}

/** Whether the run's recorded process group is alive and is the run's own, not a pid reused by something else. */
export function ownsLiveGroup({ pid, started_at }: { pid: number; started_at: string }): boolean {
  if (!groupAlive(pid)) return false;
  const leader = leaderStartedAt(pid);
  return leader === null || Math.abs(leader - Date.parse(`${started_at.replace(' ', 'T')}Z`)) < 120_000;
}
