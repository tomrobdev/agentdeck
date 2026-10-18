// How the CLI prints tasks, doctor reports, logs and times, and how it fails.
import { readLog } from '../adapters/run-log.ts';
import type { DoctorReport } from '../application/repos.ts';
import type { Db } from '../db/index.ts';
import { isWaiting } from '../domain/task/dependency.ts';
import type { TaskStatus } from '../domain/task/lifecycle.ts';
import type { Task } from '../domain/task/task.ts';

const STATUS_ICON: Record<TaskStatus, string> = {
  proposed: '?',
  queued: '·',
  running: '▶',
  done: '✓',
  blocked: '!',
  failed: '✗',
  cancel_requested: '⏹',
  cancelled: '⏹',
};

export function die(msg: string): never {
  console.error(`agentdeck: ${msg}`);
  process.exit(1);
}

export function taskId(arg: string | undefined): number {
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) die('expected a task id');
  return id;
}

export function fmtTask(t: Task, repoName: string, db?: Db): string {
  let extra = t.blocked_reason && (t.status === 'blocked' || t.status === 'failed') ? `  — ${t.blocked_reason}` : '';
  if (t.status === 'queued' && t.after_task !== null && db && isWaiting(t, db.getTask(t.after_task)))
    extra += `  waiting on #${t.after_task}`;
  if (t.pr_url) extra += `  PR ${t.pr_state ?? 'open'}: ${t.pr_url}`;
  return `${STATUS_ICON[t.status]} #${String(t.id).padEnd(4)} ${t.status.padEnd(9)} p${t.priority}  ${repoName.padEnd(14)} ${t.title}${extra}`;
}

/** Print each doctor check with its reason, then the verdict. */
export function printDoctor(report: DoctorReport): DoctorReport {
  for (const c of report.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(14)} ${c.reason}`);
  console.log(
    report.ok
      ? `${report.repo}: ready`
      : `${report.repo}: PAUSED (${report.paused_reason}); fix the failed checks and run \`agentdeck repo doctor ${report.repo}\``,
  );
  return report;
}

export function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

/** Print a run's log in readable form. */
export function printLog(path: string): void {
  for (const e of readLog(path)) {
    if (e.kind === 'text') console.log(`\n💬 ${e.text}`);
    if (e.kind === 'tool') console.log(`🔧 ${e.name} ${e.input.slice(0, 200)}`);
    if (e.kind === 'result') console.log(`\n── result: ${e.subtype}, ${e.turns} turns, $${e.cost.toFixed(3)} equiv ──`);
    if (e.kind === 'setup') console.log(`\n── setup ${e.passed ? 'done' : 'FAILED'}: ${e.cmd} ──\n${e.output.slice(-3000)}`);
    if (e.kind === 'tests') console.log(`\n── tests ${e.passed ? 'passed' : 'FAILED'} ──\n${e.output.slice(-3000)}`);
    if (e.kind === 'error') console.log(`⚠️  ${e.text}`);
  }
}
