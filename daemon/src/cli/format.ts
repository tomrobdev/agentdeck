// How the CLI prints tasks, doctor reports, logs and times, and how it fails.
import { createInterface } from 'node:readline/promises';
import { type ComposedApp, type DoctorReport, type HealthCheck, type TaskView, readLog } from '../application/actions.ts';
import { type TaskId, asTaskId } from '../domain/shared/index.ts';
import type { AutoMergeView } from '../domain/landing/index.ts';
import type { ChecksSummary } from '../domain/landing/index.ts';
import type { TaskStatus } from '../domain/work/index.ts';
import { parseTaskIds } from '../domain/work/index.ts';
import type { Task } from '../domain/work/index.ts';
import type { RunSummary } from '../domain/runs/index.ts';

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

/** Asks `question [y/N] ` on the terminal; true only for y or yes. */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export function taskId(arg: string | undefined): TaskId {
  const id = Number(arg);
  if (!Number.isInteger(id) || id <= 0) die('expected a task id');
  return asTaskId(id);
}

/** The task ids a list flag names (`--builds-on 12,14`); empty when the flag is not given. */
export function taskIds(value: string | undefined, flag: string): TaskId[] {
  return parseTaskIds(value) ?? die(`${flag} takes task ids, like 12,14`);
}

/** "#12, #14" */
export const idsText = (ids: TaskId[]): string => ids.map((id) => `#${id}`).join(', ');

/** One link in words: "builds on #12 (waiting)", "after #9 (not landed yet)". */
export function fmtLink(l: TaskView['links'][number]): string {
  const state = { met: 'met', waiting: 'waiting', stuck: 'stuck', unlanded: 'not landed yet' }[l.state];
  return `${l.kind === 'builds_on' ? 'builds on' : 'after'} #${l.on} (${state})`;
}

/** A failed or blocked run's summary in a few lines: the verdict, time and tools, and the last failing output's tail. */
export function fmtRunSummary(s: RunSummary): string[] {
  const tools = s.tools
    .slice(0, 6)
    .map((t) => `${t.name} ${t.count}`)
    .join(', ');
  const time = `${s.minutes} min${s.test_runs ? `, ${s.test_minutes} in tests` : ''}`;
  const lines = [s.verdict, tools ? `${time} · ${tools}` : time];
  if (s.excerpt)
    lines.push(
      'last failure:',
      ...s.excerpt
        .split('\n')
        .slice(-6)
        .map((l) => `  │ ${l}`),
    );
  return lines;
}

/** `waiting`, `unblocks` and `links` come from a task view (`taskDetail`, `withViews`); a plain task shows none. */
export function fmtTask(
  t: Task & {
    waiting?: TaskView['waiting'];
    unblocks?: TaskId[];
    links?: TaskView['links'];
    auto_merge_view?: TaskView['auto_merge_view'];
  },
  repoName: string,
): string {
  let extra = (t.status === 'blocked' || t.status === 'failed') && t.stop_reason ? `  — ${t.stop_reason}` : '';
  const waiting = t.waiting ?? null;
  if (waiting)
    extra += waiting.stuck
      ? `  can't start: ${waiting.stuck} (retry ${idsText(waiting.on)} or cancel this task)`
      : `  waiting on ${idsText(waiting.on)}`;
  if (t.pr?.url) extra += `  PR ${t.pr.state}: ${t.pr.url}`;
  if (t.auto_merge_view && t.auto_merge_view.state !== 'off') extra += `  ${t.auto_merge_view.label}`;
  // A builds-on link that is still waiting is already shown as "waiting on"; show the rest.
  for (const l of t.links ?? []) if (l.kind === 'after' || l.state !== 'waiting' || !waiting) extra += `  ${fmtLink(l)}`;
  if (t.unblocks?.length) extra += `  unblocks ${idsText(t.unblocks)}`;
  return `${STATUS_ICON[t.status]} #${String(t.id).padEnd(4)} ${t.status.padEnd(9)} p${t.priority}  ${repoName.padEnd(14)} ${t.title}${extra}`;
}

const SOURCE_WORDS = {
  task: "this task's setting",
  repo: "the repo's setting",
  planner: 'off because the repo auto-approves planner proposals',
};

/** The lines `agentdeck show` prints for auto-merge: the label and its source, each reason, when it was checked, the limits. */
export function fmtAutoMerge(v: AutoMergeView): string[] {
  const lines = [`auto-merge ${v.label} (${SOURCE_WORDS[v.source]})`];
  for (const reason of v.reasons) lines.push(`           - ${reason}`);
  if (v.checked_at) lines.push(`           checked ${v.checked_at} UTC`);
  if (v.state !== 'off')
    lines.push(
      `           limits: ${v.limits.max_lines.toLocaleString('en-US')} lines, not touching ${v.limits.skip.join(', ') || 'nothing'}; ${v.limits.tests}${v.limits.review ? `; ${v.limits.review}` : ''}`,
    );
  return lines;
}

/**
 * What `agentdeck show` prints for the open PR's checks: "checks   2 of 5 failing: lint, test (agentdeck fix-checks 12)",
 * then a line for each failing check whose failure was read, with its step and what failed:
 * "         - check › tests and coverage: cli: branches 53.6% is below its floor of 54%".
 */
export function fmtChecks(c: ChecksSummary, id?: TaskId): string {
  const running = c.pending ? `, ${c.pending} running` : '';
  if (!c.failing) return `checks   ${c.total} on the PR, none failing${running}`;
  const fix = id === undefined ? '' : `  (agentdeck fix-checks ${id})`;
  const head = `checks   ${c.failing} of ${c.total} failing: ${c.failing_names.join(', ')}${running}${fix}`;
  const details = c.failing_lines.filter((line, i) => line !== c.failing_names[i]);
  return [head, ...details.map((line) => `         - ${line}`)].join('\n');
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

/** Print each daemon check with its reason (a warning marked `!`), and under each failed one or warning the command that fixes it. */
export function printHealth(checks: HealthCheck[]): void {
  for (const c of checks) {
    console.log(`${c.ok ? (c.warning ? '!' : '✓') : '✗'} ${c.name.padEnd(17)} ${c.reason}`);
    if (c.fix) console.log(`  → ${c.fix}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  const warnings = checks.filter((c) => c.ok && c.warning).length;
  const warned = warnings ? `, ${warnings === 1 ? '1 warning' : `${warnings} warnings`}` : '';
  console.log(failed ? `${failed} of ${checks.length} checks failed${warned}` : `the daemon is healthy${warned}`);
}

export function relTime(unixSeconds: number): string {
  const mins = Math.round((unixSeconds * 1000 - Date.now()) / 60_000);
  if (mins <= 0) return 'now';
  return mins < 90 ? `${mins}m` : `${(mins / 60).toFixed(1)}h`;
}

/** Print a run's log in readable form. */
export function printLog(app: ComposedApp, path: string): void {
  for (const e of readLog(app, path)) {
    if (e.kind === 'text') console.log(`\n💬 ${e.text}`);
    if (e.kind === 'tool') console.log(`🔧 ${e.name} ${e.summary}`.trimEnd());
    if (e.kind === 'tool_result' && !e.ok) {
      for (const l of e.output.split('\n').slice(0, 3)) console.log(`   ${l}`);
    }
    if (e.kind === 'result') console.log(`\n── result: ${e.subtype}, ${e.turns} turns, $${e.cost.toFixed(3)} equiv ──`);
    if (e.kind === 'setup') console.log(`\n── setup ${e.passed ? 'done' : 'FAILED'}: ${e.cmd} ──\n${e.output.slice(-3000)}`);
    if (e.kind === 'tests') console.log(`\n── tests ${e.passed ? 'passed' : 'FAILED'} ──\n${e.output.slice(-3000)}`);
    if (e.kind === 'error') console.log(`⚠️  ${e.text}`);
  }
}
