// The rest of the pilot scorecard (docs/pilot/scorecard.md), computed from plain rows: interventions, time queued,
// running and in review, quota spent and PRs green on CI. Pure: no I/O. The first-run measures are in stats.ts.
import { type QuotaSample, quotaSpends } from '../usage/quota.ts';
import { median, minutesBetween, sqliteMs, weekOf } from '../time.ts';
import { type InterventionCount, INTERVENTION_KINDS, countInterventions } from './interventions.ts';
import { num, pct, table } from './report-text.ts';

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
  const t = new Date(sqliteMs(stamp));
  return Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== m[1] ? null : stamp;
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
