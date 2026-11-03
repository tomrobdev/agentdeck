// The pilot scorecard's measures (docs/pilot/scorecard.md), computed from plain run rows. Pure: no I/O.
import { minutesBetween, weekOf } from '../time.ts';
import { num, pct, table } from './report-text.ts';
import { INTERRUPTED } from './run.ts';

/** One work run with the status of the task it belongs to. Resolve runs are never given here. */
export interface StatRun {
  repo_id: number;
  task_id: number;
  attempt: number;
  outcome: string | null; // null while the run has not finished
  started_at: string;
  ended_at: string | null;
  cost_usd: number;
  denials: number;
  task_status: string;
}

export interface Interval {
  low: number;
  high: number;
}

export interface Measures {
  /** Tasks with at least one work run. */
  tasks: number;
  /** Work runs, finished or not. */
  runs: number;
  /** Tasks whose first run (attempt 1) has finished. */
  first_runs: number;
  /** Of those, the tasks whose first run ended done. */
  first_run_done: number;
  /** first_run_done / first_runs, or null with no finished first run. */
  first_run_rate: number | null;
  /** Wilson 95% interval of the rate, or null with no finished first run. */
  first_run_interval: Interval | null;
  /** Tool uses the permission rules refused, over all work runs. */
  denials: number;
  /** denials / runs, or null with no runs. */
  denials_per_run: number | null;
  /** Tasks now done. */
  done_tasks: number;
  /** Cost of every work run of the done tasks, over their number; null with no done task. */
  cost_per_done_task: number | null;
  /** Minutes of finished work runs of the done tasks, over their number; null with no done task. */
  minutes_per_done_task: number | null;
}

const Z_95 = 1.96;

/** The Wilson score interval for `successes` out of `n` at 95%. null when n is 0. */
export function wilson(successes: number, n: number, z = Z_95): Interval | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

/** The measures over a set of work runs. A run a daemon restart cut off is no verdict, so it is not a first run. */
export function measure(rows: StatRun[]): Measures {
  const taskIds = new Set(rows.map((r) => r.task_id));
  const firstRuns = rows.filter((r) => r.attempt === 1 && r.outcome !== null && r.outcome !== INTERRUPTED);
  const firstDone = firstRuns.filter((r) => r.outcome === 'done').length;
  const doneIds = new Set(rows.filter((r) => r.task_status === 'done').map((r) => r.task_id));
  const ofDone = rows.filter((r) => doneIds.has(r.task_id));
  const denials = rows.reduce((sum, r) => sum + r.denials, 0);
  const cost = ofDone.reduce((sum, r) => sum + r.cost_usd, 0);
  const minutes = ofDone.reduce((sum, r) => sum + (r.ended_at ? minutesBetween(r.started_at, r.ended_at) : 0), 0);
  return {
    tasks: taskIds.size,
    runs: rows.length,
    first_runs: firstRuns.length,
    first_run_done: firstDone,
    first_run_rate: firstRuns.length ? firstDone / firstRuns.length : null,
    first_run_interval: wilson(firstDone, firstRuns.length),
    denials,
    denials_per_run: rows.length ? denials / rows.length : null,
    done_tasks: doneIds.size,
    cost_per_done_task: doneIds.size ? cost / doneIds.size : null,
    minutes_per_done_task: doneIds.size ? minutes / doneIds.size : null,
  };
}

/** The measures of each repo that has work runs, by repo id. */
export function measureByRepo(rows: StatRun[]): Map<number, Measures> {
  const groups = new Map<number, StatRun[]>();
  for (const r of rows) groups.set(r.repo_id, [...(groups.get(r.repo_id) ?? []), r]);
  return new Map([...groups].map(([id, g]) => [id, measure(g)]));
}

export interface StatsReport {
  repos: { repo: string; measures: Measures }[];
  total: Measures;
}

/** "80% (n=10, 49–94%)", or "–" with no finished first run. */
export function fmtFirstRun(m: Measures): string {
  if (m.first_run_rate === null || !m.first_run_interval) return '–';
  const { low, high } = m.first_run_interval;
  return `${pct(m.first_run_rate)} (${m.first_run_done}/${m.first_runs}, 95% ${pct(low)}–${pct(high)})`;
}

/** The first-run measures of each week with work runs, oldest first. A task goes by the week its first run began. */
export function measureByWeek(rows: StatRun[]): { week: string; measures: Measures }[] {
  const firstStart = new Map<number, string>();
  for (const r of rows) {
    const seen = firstStart.get(r.task_id);
    if (seen === undefined || r.started_at < seen) firstStart.set(r.task_id, r.started_at);
  }
  const groups = new Map<string, StatRun[]>();
  for (const r of rows) {
    const week = weekOf(firstStart.get(r.task_id) ?? r.started_at);
    if (week) groups.set(week, [...(groups.get(week) ?? []), r]);
  }
  return [...groups].map(([week, group]) => ({ week, measures: measure(group) })).sort((a, b) => a.week.localeCompare(b.week));
}

/** The report as an aligned table, one row per repo and a total row. */
export function statsTable(report: StatsReport): string {
  const head = ['repo', 'tasks', 'runs', 'first run done', 'denials/run', 'cost/done task', 'min/done task'];
  const row = (name: string, m: Measures) => [
    name,
    String(m.tasks),
    String(m.runs),
    fmtFirstRun(m),
    num(m.denials_per_run, 2),
    num(m.cost_per_done_task, 2, '$'),
    num(m.minutes_per_done_task, 1),
  ];
  return table(head, [...report.repos.map((r) => row(r.repo, r.measures)), row('total', report.total)]);
}
