// Process groups of claude runs: stopping them on shutdown, and after a crash.
import { type ChildProcess, execFileSync } from 'node:child_process';
import { sqliteMs } from '../../domain/shared/index.ts';

export const activeChildren = new Set<ChildProcess>();

export function killGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {}
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function leaderStartedAt(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return out ? Date.parse(out) : null;
  } catch {
    return null;
  }
}

export function reapOrphans(runs: PidRecord[], graceMs = 5_000): number {
  const ours = runs.filter(ownsLiveGroup);
  for (const { pid } of ours) killGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (ours.some(({ pid }) => groupAlive(pid)) && Date.now() < deadline) Atomics.wait(wait, 0, 0, 100);
  for (const { pid } of ours) if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
  return ours.length;
}

export interface PidRecord {
  pid: number;
  pid_at: string;
}

export function ownsLiveGroup({ pid, pid_at }: PidRecord): boolean {
  if (!groupAlive(pid)) return false;
  const leader = leaderStartedAt(pid);
  return leader === null || Math.abs(leader - sqliteMs(pid_at)) < 120_000;
}
