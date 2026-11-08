// What failures are made of, per week and repo (`agentdeck stats --failures`): the steps CI failed on, and how failed or
// blocked work runs ended. Counted from what is stored on tasks and runs, so a row from before it was stored reads as
// unknown. Pure: no I/O.
import type { RepoId } from '../shared/index.ts';
import { weekOf } from '../shared/index.ts';
import type { CheckCounts } from '../landing/index.ts';
import type { RunEnd } from '../runs/index.ts';
import { table } from './report-text.ts';
import type { ScorecardTaskRow } from './scorecard.ts';
import type { StatRun } from './stats.ts';

/** What a cause is called when nothing says: a count from before steps were kept, a check GitHub named no step for, a run from before ends were kept. */
export const UNKNOWN_STEP = 'unknown step';
export const UNKNOWN_END = 'unknown end';

/** One cause and how often it came up. */
export interface Cause {
  cause: string;
  count: number;
}

/** A cause of one kind, in the top list of all of them. */
export interface TopCause extends Cause {
  kind: 'check' | 'run';
  /** Where the cause was counted: when the PR opened, when it merged, or in a run. */
  where: 'opened' | 'merged' | 'run';
}

/** A week's failures in one repo. */
export interface FailureWeek {
  week: string;
  repo: string;
  /** Failing checks by step on the head the PR first settled on, and on the head it merged on. */
  checks_opened: Cause[];
  checks_merged: Cause[];
  /** Failed or blocked work runs by how they ended, and whether their tests kept failing. */
  runs: Cause[];
  /** How many failed or blocked work runs there were, and how many of those a later run of the task then finished. */
  runs_failed: number;
  runs_fixed: number;
}

export interface FailureReport {
  weeks: FailureWeek[];
  /** The most frequent causes over all weeks, most first. */
  top: TopCause[];
}

const END_WORD: Record<RunEnd, string> = {
  max_turns: 'used its turns',
  ended: 'ended on its own',
  error: 'stopped by an error',
  cut_off: 'cut off',
};

/** Where one failing check failed: its name and step, "unknown step" when no step was read. */
export const stepCause = (f: { name: string; step: string | null }): string => `${f.name} › ${f.step ?? UNKNOWN_STEP}`;

/** The steps a PR's checks failed on. A count without a list of them has its failing checks on an unknown step. */
export function failingSteps(counts: CheckCounts | null | undefined): string[] {
  if (!counts || counts.failing === 0) return [];
  if (counts.failures?.length) return counts.failures.map(stepCause);
  return Array.from({ length: counts.failing }, () => UNKNOWN_STEP);
}

/** How a failed or blocked run ended: "used its turns, tests failing", or "unknown end" for a run from before it was kept. */
export function endCause(run: Pick<StatRun, 'run_end' | 'last_test_failed'>): string {
  if (!run.run_end) return UNKNOWN_END;
  return `${END_WORD[run.run_end]}${run.last_test_failed ? ', tests failing' : ''}`;
}

/** Whether a work run failed or blocked: only those have a way of ending to count. */
const failedRun = (r: StatRun): boolean => r.outcome === 'failed' || r.outcome === 'blocked';

/** The failed or blocked runs a retry then fixed: a later run of the same task (`rows` oldest first) finished done. */
export function fixedByRetry(rows: StatRun[]): Set<StatRun> {
  const fixed = new Set<StatRun>();
  const doneAfter = new Set<number>(); // tasks with a done run later than the run being looked at
  for (const r of [...rows].reverse()) {
    if (r.outcome === 'done') doneAfter.add(r.task_id);
    else if (failedRun(r) && doneAfter.has(r.task_id)) fixed.add(r);
  }
  return fixed;
}

const tally = (causes: string[]): Cause[] => {
  const counts = new Map<string, number>();
  for (const c of causes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts].map(([cause, count]) => ({ cause, count })).sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause));
};

export interface FailureInput {
  /** Every work run, oldest first. */
  runs: StatRun[];
  tasks: Pick<ScorecardTaskRow, 'repo_id' | 'created_at' | 'pr_checks_opened' | 'pr_checks_merged'>[];
  repoName: (id: RepoId) => string;
  /** Only runs begun and tasks created at or after this stamp. */
  since?: string;
  /** How many causes `top` keeps. */
  top?: number;
}

/**
 * The failures per week and repo, oldest week first. A run counts in the week it began and a task's checks in the week
 * the task was created, as nothing else dates them. A retry's fix is looked for among all runs of the task, `since` or not.
 */
export function failureReport(input: FailureInput): FailureReport {
  const { since, repoName } = input;
  const fixed = fixedByRetry(input.runs);
  const cells = new Map<string, { week: string; repo: RepoId; opened: string[]; merged: string[]; runs: StatRun[] }>();
  const cell = (stamp: string, repo: RepoId) => {
    const week = weekOf(stamp);
    if (!week) return null;
    const key = `${week}/${repo}`;
    if (!cells.has(key)) cells.set(key, { week, repo, opened: [], merged: [], runs: [] });
    return cells.get(key)!;
  };
  for (const t of input.tasks) {
    if (since !== undefined && t.created_at < since) continue;
    const opened = failingSteps(t.pr_checks_opened);
    const merged = failingSteps(t.pr_checks_merged);
    if (opened.length || merged.length) {
      const c = cell(t.created_at, t.repo_id);
      c?.opened.push(...opened);
      c?.merged.push(...merged);
    }
  }
  for (const r of input.runs) {
    if (!failedRun(r) || (since !== undefined && r.started_at < since)) continue;
    cell(r.started_at, r.repo_id)?.runs.push(r);
  }
  const weeks = [...cells.values()]
    .map((c) => ({
      week: c.week,
      repo: repoName(c.repo),
      checks_opened: tally(c.opened),
      checks_merged: tally(c.merged),
      runs: tally(c.runs.map(endCause)),
      runs_failed: c.runs.length,
      runs_fixed: c.runs.filter((r) => fixed.has(r)).length,
    }))
    .sort((a, b) => a.week.localeCompare(b.week) || a.repo.localeCompare(b.repo));
  return { weeks, top: topCauses(weeks, input.top ?? 5) };
}

/** The most frequent causes over the weeks. */
export function topCauses(weeks: FailureWeek[], limit: number): TopCause[] {
  const counts = new Map<string, TopCause>();
  const add = (kind: TopCause['kind'], where: TopCause['where'], list: Cause[]) => {
    for (const { cause, count } of list) {
      const key = `${where}/${cause}`;
      counts.set(key, { kind, where, cause, count: (counts.get(key)?.count ?? 0) + count });
    }
  };
  for (const w of weeks) {
    add('check', 'opened', w.checks_opened);
    add('check', 'merged', w.checks_merged);
    add('run', 'run', w.runs);
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause)).slice(0, limit);
}

const list = (causes: Cause[]): string => (causes.length ? causes.map((c) => `${c.count}× ${c.cause}`).join('; ') : '–');

/** The report as a table, one row per week and repo. */
export function failuresTable(report: FailureReport): string {
  if (!report.weeks.length) return 'No failures recorded.';
  const head = ['week', 'repo', 'failing on open', 'failing on merge', 'failed runs', 'fixed by retry', 'how they ended'];
  const rows = report.weeks.map((w) => [
    w.week,
    w.repo,
    list(w.checks_opened),
    list(w.checks_merged),
    String(w.runs_failed),
    String(w.runs_fixed),
    list(w.runs),
  ]);
  return table(head, rows);
}
