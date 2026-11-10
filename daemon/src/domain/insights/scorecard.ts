// The rest of the pilot scorecard (docs/pilot/scorecard.md), computed from plain rows: interventions, time queued, running and in review, quota spent and PRs green on CI.
import type { RepoId, TaskId } from '../shared/index.ts';
import type { CheckCounts } from '../landing/index.ts';
import { type QuotaSample, quotaSpends } from '../capacity/index.ts';
import { isAutoMergeReason } from '../work/index.ts';
import { median, minutesBetween, sqliteMs, weekOf } from '../shared/index.ts';
import { type InterventionCount, INTERVENTION_KINDS, countInterventions } from './interventions.ts';
import { num, pct, table } from './report-text.ts';
import {
  type ReviewRunMeasures,
  type ScorecardReviewRun,
  type ScorecardRunReview,
  measureReviewRuns,
  reviewRunsText,
} from './review-runs.ts';

export const SCORECARD_TARGETS = { first_run_rate: 0.8, interventions: 0, pr_green_rate: 1, quota_points: 15 } as const;

/** One row of a task's history (`task_events`), with the task's repo. */
export interface ScorecardEvent {
  task_id: TaskId;
  repo_id: RepoId;
  type: string;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  at: string;
}

/** The fields of a task the scorecard reads, as the database has them. */
export interface ScorecardTaskRow {
  id: TaskId;
  repo_id: RepoId;
  created_at: string;
  /** The task's own auto-merge setting; null follows the repo. */
  auto_merge: boolean | null;
  repo_auto_merge: boolean;
  /** The PR's checks the first time they settled after it opened; null if never recorded (or unreadable). */
  pr_checks_opened: CheckCounts | null;
  /** The PR's checks when it merged; null if it has not merged or they were not recorded. */
  pr_checks_merged?: CheckCounts | null;
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

export function cycleOf(events: ScorecardEvent[]): CycleMinutes {
  const sorted = [...events].sort((a, b) => a.at.localeCompare(b.at));
  const ready = sorted.find((e) => e.type === 'approve') ?? sorted.find((e) => e.type === 'created');
  const firstClaim = sorted.find((e) => e.type === 'claim');
  let running: number | null = null;
  sorted.forEach((e, i) => {
    if (e.type !== 'claim') return;
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

export const checksGreen = (c: CheckCounts): boolean => c.total > 0 && c.failing === 0 && c.pending === 0;

export function summarizeChecks(tasks: ScorecardTask[]): ChecksSummary {
  const verdicts = tasks.flatMap((t) => (t.pr_checks_opened === null ? [] : [checksGreen(t.pr_checks_opened)]));
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
  /** The review runs of the group, by when they started. */
  review_runs: ReviewRunMeasures;
}

function scorecardMeasures(
  byTask: Map<number, ScorecardTask>,
  tasks: ScorecardTask[],
  events: ScorecardEvent[],
  interventionEvents: ScorecardEvent[],
  review_runs: ReviewRunMeasures,
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
    review_runs,
  };
}

export function resolveAutoMerge(rows: ScorecardTaskRow[], events: ScorecardEvent[]): ScorecardTask[] {
  const firstAuto = new Map<number, string>();
  for (const e of events) {
    if (e.type !== 'merge' || !isAutoMergeReason(e.reason)) continue;
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
  /** The review runs, and the reviews they left (`by` review_run); missing means none. */
  review_runs?: ScorecardReviewRun[];
  run_reviews?: ScorecardRunReview[];
  repoName: (id: RepoId) => string;
  /**
   * Only tasks created, interventions made, review runs started and quota seen at or after this stamp
   * ("YYYY-MM-DD HH:MM:SS").
   */
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

export function buildScorecard(input: ScorecardInput): Scorecard {
  const since = input.since ?? null;
  const all = resolveAutoMerge(input.tasks, input.events);
  const byTask = new Map(all.map((t) => [t.id, t]));
  const tasks = all.filter((t) => since === null || t.created_at >= since);
  const ids = new Set(tasks.map((t) => t.id));
  const own = input.events.filter((e) => ids.has(e.task_id));
  const interventions = input.events.filter((e) => since === null || e.at >= since);
  const spends = quotaSpends(input.samples).filter((s) => since === null || s.at >= since);
  const sum = (items: { points: number }[]) => items.reduce((n, s) => n + s.points, 0);
  const reviewRuns = (input.review_runs ?? []).filter((r) => since === null || r.started_at >= since);
  const historyOf = new Map<number, ScorecardEvent[]>();
  for (const e of input.events) historyOf.set(e.task_id, [...(historyOf.get(e.task_id) ?? []), e]);
  const reviewMeasures = (runs: ScorecardReviewRun[]) =>
    measureReviewRuns(runs, input.run_reviews ?? [], (task) => historyOf.get(task) ?? []);

  const repoIds = [
    ...new Set([...tasks.map((t) => t.repo_id), ...interventions.map((e) => e.repo_id), ...reviewRuns.map((r) => r.repo_id)]),
  ];
  const repos = repoIds
    .map((id) => ({
      repo: input.repoName(id),
      measures: scorecardMeasures(
        byTask,
        tasks.filter((t) => t.repo_id === id),
        own.filter((e) => e.repo_id === id),
        interventions.filter((e) => e.repo_id === id),
        reviewMeasures(reviewRuns.filter((r) => r.repo_id === id)),
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
            ...reviewRuns.map((r) => weekOf(r.started_at)),
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
                reviewMeasures(reviewRuns.filter((r) => weekOf(r.started_at) === week)),
              ),
              quota_points: sum(spends.filter((s) => weekOf(s.at) === week)),
            };
          })
      : [];

  return {
    since,
    by: input.by ?? null,
    repos,
    total: scorecardMeasures(byTask, tasks, own, interventions, reviewMeasures(reviewRuns)),
    quota_points: sum(spends),
    weeks,
  };
}

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
    reviewRunsText(card.total.review_runs),
    `times are medians in minutes; quota spent: ${num(card.quota_points)} points of the 7-day window${card.since ? ` since ${card.since}` : ''}`,
  );
  return parts.join('\n\n');
}
