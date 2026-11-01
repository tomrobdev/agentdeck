// The rest of the pilot scorecard (docs/pilot/scorecard.md), computed from plain rows: interventions, time queued,
// running and in review, quota spent and PRs green on CI. Pure: no I/O. The first-run measures are in stats.ts.
import { INSTALL_NOTE } from '../task/needs.ts';
import { type Measures, type StatRun, measure, minutesBetween } from './stats.ts';

/**
 * The pilot's targets for the measures that have one (docs/pilot/scorecard.md): first-run success at least this share,
 * no interventions, every PR green when opened, and at most this many points of the 7-day window spent over the pilot.
 */
export const SCORECARD_TARGETS = { first_run_rate: 0.8, interventions: 0, pr_green_rate: 1, quota_points: 15 } as const;

/** One row of a task's history (`task_events`), with the task's repo. */
export interface ScorecardEvent {
  task_id: number;
  repo_id: number;
  type: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  at: string;
}

/** The fields of a task the scorecard reads, as the database has them. */
export interface ScorecardTaskRow {
  id: number;
  repo_id: number;
  created_at: string;
  /** The task's own auto-merge setting; null follows the repo. */
  auto_merge: boolean | null;
  repo_auto_merge: boolean;
  /** JSON CheckCounts: the PR's checks the first time they settled after it opened; null if never recorded. */
  pr_checks_opened: string | null;
}

/** A task with auto-merge made into the time it is known to have been on. */
export interface ScorecardTask extends Omit<ScorecardTaskRow, 'auto_merge' | 'repo_auto_merge'> {
  /**
   * When auto-merge was known to be on for the task: always ('') if the task turned it on itself, from the repo's first
   * auto-merge if the repo has it on (the database keeps only the setting as it is now, so a merge from before the
   * setting existed must not count), never (null) otherwise.
   */
  auto_merge_from: string | null;
}

/** A reading of the 7-day window, as kept in `usage_samples`: utilization is 0..1. */
export interface QuotaSample {
  utilization: number;
  resets_at: number;
  observed_at: string;
}

/**
 * An intervention is something a person did that changed how a task turned out, which the pilot wants to bring to
 * zero. Each kind says why it counts. Approving or rejecting a proposal is how the planner is meant to be used, and
 * a plain retry (no note) only asks again, so neither is here.
 */
export interface Intervention {
  kind: string;
  why: string;
  is(e: ScorecardEvent, task: ScorecardTask): boolean;
}

const retried = (e: ScorecardEvent) => e.type === 'retry';
const noted = (e: ScorecardEvent) => (e.reason?.trim() ?? '') !== '';
const installed = (e: ScorecardEvent) => retried(e) && (e.reason ?? '').startsWith(INSTALL_NOTE);

export const INTERVENTIONS: Intervention[] = [
  {
    kind: 'retry_with_note',
    why: 'the person told the worker what to do differently, so the first attempt was not enough',
    is: (e) => retried(e) && noted(e) && !installed(e),
  },
  {
    kind: 'mark_done',
    why: 'the person finished or landed the work themselves',
    is: (e) => e.type === 'mark_done',
  },
  {
    kind: 'install_needs',
    why: 'the worker could not install packages itself and a person did it for it (recorded as a retry with that note)',
    is: installed,
  },
  {
    kind: 'cancel',
    why: 'the person stopped work that was going wrong or no longer wanted',
    is: (e) => e.type === 'cancel',
  },
  {
    kind: 'edit',
    why: 'the person rewrote a task that was waiting or stuck to get a different outcome (edits to a proposal or a failed task are left out)',
    is: (e) => e.type === 'edit' && (e.from_status === 'queued' || e.from_status === 'blocked'),
  },
  {
    kind: 'manual_merge',
    why: 'auto-merge was on, yet the person merged the PR by hand',
    is: (e, task) =>
      e.type === 'merge' && task.auto_merge_from !== null && e.at >= task.auto_merge_from && !(e.reason ?? '').startsWith('auto-merged'),
  },
];

export const INTERVENTION_KINDS = INTERVENTIONS.map((i) => i.kind);

/** The intervention kind of an event, or null if a person's event of that kind does not count. */
export function interventionKind(e: ScorecardEvent, task: ScorecardTask): string | null {
  return INTERVENTIONS.find((i) => i.is(e, task))?.kind ?? null;
}

export interface InterventionCount {
  total: number;
  /** Distinct tasks that had at least one. */
  tasks: number;
  by_kind: Record<string, number>;
}

export function countInterventions(events: ScorecardEvent[], tasks: Map<number, ScorecardTask>): InterventionCount {
  const by_kind = Object.fromEntries(INTERVENTION_KINDS.map((k) => [k, 0]));
  const hit = new Set<number>();
  let total = 0;
  for (const e of events) {
    const task = tasks.get(e.task_id);
    const kind = task ? interventionKind(e, task) : null;
    if (!kind) continue;
    by_kind[kind]++;
    total++;
    hit.add(e.task_id);
  }
  return { total, tasks: hit.size, by_kind };
}

/** The middle value (the mean of the two middle ones for an even count), or null for none. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface CycleMinutes {
  /** From the task being queued (added, or approved from a proposal) to its first claim. */
  queued: number | null;
  /** Claim to the end of the run, summed over the task's runs; null if no run ended. */
  running: number | null;
  /** From the first run that finished done to the PR's merge; null if it was not merged. */
  review: number | null;
}

/** The times of one task, read from its history (oldest event first). */
export function cycleOf(events: ScorecardEvent[]): CycleMinutes {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const ready = sorted.find((e) => e.type === 'approve') ?? sorted.find((e) => e.type === 'created');
  const firstClaim = sorted.find((e) => e.type === 'claim');
  let running: number | null = null;
  sorted.forEach((e, i) => {
    if (e.type !== 'claim') return;
    // The run ends at the next change out of running (a plan_unfinished or sync row keeps the status).
    const end = sorted
      .slice(i + 1)
      .find((n) => (n.from_status === 'running' || n.from_status === 'cancel_requested') && n.to_status !== n.from_status);
    if (end) running = (running ?? 0) + minutesBetween(e.at, end.at);
  });
  const finished = sorted.find((e) => e.type === 'finish' && e.to_status === 'done');
  const merged = finished && sorted.find((e) => (e.type === 'merge' || e.type === 'pr_merged') && e.at >= finished.at);
  return {
    queued: ready && firstClaim ? minutesBetween(ready.at, firstClaim.at) : null,
    running,
    review: finished && merged ? minutesBetween(finished.at, merged.at) : null,
  };
}

export interface ChecksSummary {
  /** PRs whose checks were recorded when they opened. */
  recorded: number;
  /** Of those, the PRs with checks, none failing and none pending. */
  green: number;
  /** green / recorded, or null with none recorded. */
  rate: number | null;
}

/** Whether a PR's recorded checks were green: there were some, and none failed or was pending. */
export function checksGreen(json: string): boolean | null {
  try {
    const c = JSON.parse(json) as { total?: unknown; failing?: unknown; pending?: unknown };
    if (typeof c.total !== 'number' || typeof c.failing !== 'number' || typeof c.pending !== 'number') return null;
    return c.total > 0 && c.failing === 0 && c.pending === 0;
  } catch {
    return null;
  }
}

export function summarizeChecks(tasks: ScorecardTask[]): ChecksSummary {
  const verdicts = tasks.flatMap((t) => (t.pr_checks_opened === null ? [] : [checksGreen(t.pr_checks_opened)])).filter((v) => v !== null);
  const green = verdicts.filter(Boolean).length;
  return { recorded: verdicts.length, green, rate: verdicts.length ? green / verdicts.length : null };
}

/** The Monday (UTC) of the week a sqlite stamp falls in, as "YYYY-MM-DD". "" for an unreadable stamp. */
export function weekOf(stamp: string): string {
  const t = Date.parse(`${stamp.replace(' ', 'T')}Z`);
  if (!Number.isFinite(t)) return '';
  const day = new Date(t);
  const sinceMonday = (day.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() - sinceMonday)).toISOString().slice(0, 10);
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

/**
 * Percentage points of the 7-day window spent between readings, each with the time it was seen. A reading higher than the
 * one before adds the difference. A lower one means the window reset, so everything it shows was spent since. The first
 * reading is only a baseline: what came before it was not seen.
 */
export function quotaSpends(samples: QuotaSample[]): { at: string; points: number }[] {
  return samples.flatMap((s, i) => {
    if (i === 0) return [];
    const before = samples[i - 1].utilization;
    const points = (s.utilization >= before ? s.utilization - before : s.utilization) * 100;
    return points > 0 ? [{ at: s.observed_at, points }] : [];
  });
}

export interface ScorecardMeasures {
  interventions: InterventionCount;
  /** Tasks the three medians below are over. */
  tasks: number;
  queued_minutes: number | null;
  running_minutes: number | null;
  review_minutes: number | null;
  pr_checks: ChecksSummary;
}

/** The measures over tasks and the events that belong to the same group. Each median skips tasks without that time. */
export function scorecardMeasures(
  byTask: Map<number, ScorecardTask>,
  tasks: ScorecardTask[],
  events: ScorecardEvent[],
  interventionEvents: ScorecardEvent[],
): ScorecardMeasures {
  const eventsOf = new Map<number, ScorecardEvent[]>();
  for (const e of events) eventsOf.set(e.task_id, [...(eventsOf.get(e.task_id) ?? []), e]);
  const cycles = tasks.map((t) => cycleOf(eventsOf.get(t.id) ?? []));
  const med = (pick: (c: CycleMinutes) => number | null) => median(cycles.flatMap((c) => pick(c) ?? []));
  return {
    interventions: countInterventions(interventionEvents, byTask),
    tasks: tasks.length,
    queued_minutes: med((c) => c.queued),
    running_minutes: med((c) => c.running),
    review_minutes: med((c) => c.review),
    pr_checks: summarizeChecks(tasks),
  };
}

/** Read each task's auto-merge off its own setting, its repo's setting and the repo's first merge by the daemon. */
export function resolveAutoMerge(rows: ScorecardTaskRow[], events: ScorecardEvent[]): ScorecardTask[] {
  const firstAuto = new Map<number, string>();
  for (const e of events) {
    if (e.type !== 'merge' || !(e.reason ?? '').startsWith('auto-merged')) continue;
    const first = firstAuto.get(e.repo_id);
    if (first === undefined || e.at < first) firstAuto.set(e.repo_id, e.at);
  }
  return rows.map(({ auto_merge, repo_auto_merge, ...task }) => ({
    ...task,
    auto_merge_from: auto_merge === true ? '' : auto_merge === false || !repo_auto_merge ? null : (firstAuto.get(task.repo_id) ?? null),
  }));
}

export interface ScorecardInput {
  tasks: ScorecardTaskRow[];
  events: ScorecardEvent[];
  samples: QuotaSample[];
  repoName: (id: number) => string;
  /** Only tasks created, interventions made and quota seen at or after this stamp ("YYYY-MM-DD HH:MM:SS"). */
  since?: string;
  by?: 'week';
}

export interface Scorecard {
  since: string | null;
  by: 'week' | null;
  repos: { repo: string; measures: ScorecardMeasures }[];
  total: ScorecardMeasures;
  /** Percentage points of the 7-day window spent. */
  quota_points: number;
  /** One per week with anything in it, oldest first; empty unless `by` is week. */
  weeks: { week: string; measures: ScorecardMeasures; quota_points: number }[];
}

/**
 * The scorecard. Which week and which `since` a number falls in depends on its subject: a task's times and PR checks go
 * by when the task was created, an intervention by when it happened, quota by when it was seen.
 */
export function buildScorecard(input: ScorecardInput): Scorecard {
  const since = input.since ?? null;
  const all = resolveAutoMerge(input.tasks, input.events);
  const byTask = new Map(all.map((t) => [t.id, t])); // interventions may be on a task created before `since`
  const tasks = all.filter((t) => since === null || t.created_at >= since);
  const ids = new Set(tasks.map((t) => t.id));
  const own = input.events.filter((e) => ids.has(e.task_id));
  const interventions = input.events.filter((e) => since === null || e.at >= since);
  const spends = quotaSpends(input.samples).filter((s) => since === null || s.at >= since);
  const sum = (items: { points: number }[]) => items.reduce((n, s) => n + s.points, 0);

  const repoIds = [...new Set([...tasks.map((t) => t.repo_id), ...interventions.map((e) => e.repo_id)])];
  const repos = repoIds
    .map((id) => ({
      repo: input.repoName(id),
      measures: scorecardMeasures(
        byTask,
        tasks.filter((t) => t.repo_id === id),
        own.filter((e) => e.repo_id === id),
        interventions.filter((e) => e.repo_id === id),
      ),
    }))
    .sort((a, b) => a.repo.localeCompare(b.repo));

  const weeks =
    input.by === 'week'
      ? [
          ...new Set([
            ...tasks.map((t) => weekOf(t.created_at)),
            ...interventions.map((e) => weekOf(e.at)),
            ...spends.map((s) => weekOf(s.at)),
          ]),
        ]
          .filter(Boolean)
          .sort()
          .map((week) => {
            const weekTasks = tasks.filter((t) => weekOf(t.created_at) === week);
            const weekIds = new Set(weekTasks.map((t) => t.id));
            return {
              week,
              measures: scorecardMeasures(
                byTask,
                weekTasks,
                own.filter((e) => weekIds.has(e.task_id)),
                interventions.filter((e) => weekOf(e.at) === week),
              ),
              quota_points: sum(spends.filter((s) => weekOf(s.at) === week)),
            };
          })
      : [];

  return {
    since,
    by: input.by ?? null,
    repos,
    total: scorecardMeasures(byTask, tasks, own, interventions),
    quota_points: sum(spends),
    weeks,
  };
}

/** "2026-10-01" or "2026-10-01 08:30" read as UTC, as the sqlite stamp it compares with; null if it is not a date. */
export function parseSince(text: string): string | null {
  const m = text.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const stamp = `${m[1]} ${m[2] ?? '00:00'}:${m[3] ?? '00'}`;
  const t = new Date(`${stamp.replace(' ', 'T')}Z`);
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== m[1] ? null : stamp;
}

const num = (v: number | null, digits = 1) => (v === null ? '–' : v.toFixed(digits));
const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(0)}%`);

function table(head: string[], rows: string[][]): string {
  const lines = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines
    .map((l) =>
      l
        .map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const cells = (name: string, m: ScorecardMeasures, quota?: number): string[] => [
  name,
  String(m.interventions.total),
  num(m.queued_minutes),
  num(m.running_minutes),
  num(m.review_minutes),
  m.pr_checks.rate === null ? '–' : `${pct(m.pr_checks.rate)} (${m.pr_checks.green}/${m.pr_checks.recorded})`,
  ...(quota === undefined ? [] : [num(quota)]),
];

/** The scorecard as aligned tables: per repo with a total, then per week with `by`; the interventions by kind and the quota below. */
export function scorecardText(card: Scorecard): string {
  const head = ['', 'interventions', 'queued min', 'running min', 'review min', 'PRs green'];
  const parts = [
    table(
      head.map((h, i) => (i === 0 ? 'repo' : h)),
      [...card.repos.map((r) => cells(r.repo, r.measures)), cells('total', card.total)],
    ),
  ];
  if (card.by === 'week')
    parts.push(
      table(
        [...head.map((h, i) => (i === 0 ? 'week of' : h)), 'quota pts'],
        card.weeks.map((w) => cells(w.week, w.measures, w.quota_points)),
      ),
    );
  const kinds = INTERVENTION_KINDS.map((k) => `${k} ${card.total.interventions.by_kind[k]}`).join(', ');
  parts.push(
    `interventions: ${card.total.interventions.total} on ${card.total.interventions.tasks} task${card.total.interventions.tasks === 1 ? '' : 's'} (${kinds})`,
    `times are medians in minutes; quota spent: ${num(card.quota_points)} points of the 7-day window${card.since ? ` since ${card.since}` : ''}`,
  );
  return parts.join('\n\n');
}
