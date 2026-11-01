// How the CLI prints tasks, doctor reports, logs and times, and how it fails.
import { type DoctorReport, type TaskView, readLog } from '../application/actions.ts';
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

/** One link in words: "builds on #12 (waiting)", "after #9 (holding its merge)". */
export function fmtLink(l: TaskView['links'][number]): string {
  const state = { met: 'met', waiting: 'waiting', stuck: 'stuck', holding: 'holding its merge' }[l.state];
  return `${l.kind === 'builds_on' ? 'builds on' : 'after'} #${l.on} (${state})`;
}

/** `waiting`, `unblocks` and `links` come from a task view (`taskDetail`, `withViews`); a plain task shows none. */
export function fmtTask(
  t: Task & { waiting?: TaskView['waiting']; unblocks?: number[]; links?: TaskView['links'] },
  repoName: string,
): string {
  let extra = t.stop_reason && (t.status === 'blocked' || t.status === 'failed') ? `  — ${t.stop_reason}` : '';
  const waiting = t.waiting ?? null;
  if (waiting)
    extra += waiting.stuck ? `  can't start: ${waiting.stuck} (retry #${waiting.on} or cancel this task)` : `  waiting on #${waiting.on}`;
  if (t.pr_url) extra += `  PR ${t.pr_state ?? 'open'}: ${t.pr_url}`;
  // A builds-on link that is still waiting is already shown as "waiting on"; show the rest.
  for (const l of t.links ?? []) if (l.kind === 'after' || l.state !== 'waiting' || !waiting) extra += `  ${fmtLink(l)}`;
  if (t.unblocks?.length) extra += `  unblocks ${t.unblocks.map((id) => `#${id}`).join(', ')}`;
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
