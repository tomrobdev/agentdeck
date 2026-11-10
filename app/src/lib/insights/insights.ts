// The Insights page's numbers: each scorecard measure as a value per week, set against the pilot's target.
import type { Stats } from '../../../../daemon/src/api/contract/insights.ts';
import { SCORECARD_TARGETS } from '../../../../daemon/src/domain/insights/index.ts';
import { plural } from '../../../../daemon/src/domain/shared/index.ts';
import { sqliteUtc, weekOf } from '../../../../daemon/src/domain/shared/index.ts';

export type MeasureKey = 'first_run' | 'interventions' | 'cost' | 'minutes' | 'review' | 'quota' | 'ci';

export interface Measure {
  key: MeasureKey;
  label: string;
  hint: string;
  target: { value: number; goal: 'atLeast' | 'atMost'; text: string } | null;
  format: (v: number) => string;
  floor?: number;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const minutes = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} min`;

export const MEASURES: Measure[] = [
  {
    key: 'first_run',
    label: 'First-run success',
    hint: 'Tasks whose first run ended done',
    target: { value: SCORECARD_TARGETS.first_run_rate, goal: 'atLeast', text: `≥ ${pct(SCORECARD_TARGETS.first_run_rate)}` },
    format: pct,
    floor: 1,
  },
  {
    key: 'interventions',
    label: 'Interventions',
    hint: 'Times a person stepped in',
    target: { value: SCORECARD_TARGETS.interventions, goal: 'atMost', text: String(SCORECARD_TARGETS.interventions) },
    format: (v) => String(v),
    floor: 1,
  },
  {
    key: 'cost',
    label: 'Cost per done task',
    hint: 'Every run of the done tasks',
    target: null,
    format: (v) => `$${v.toFixed(2)}`,
  },
  { key: 'minutes', label: 'Minutes per done task', hint: 'Finished runs of the done tasks', target: null, format: minutes },
  { key: 'review', label: 'Time in review', hint: 'Median, done to merged', target: null, format: minutes },
  {
    key: 'quota',
    label: 'Quota spent',
    hint: 'Points of the 7-day window',
    target: { value: SCORECARD_TARGETS.quota_points, goal: 'atMost', text: `≤ ${SCORECARD_TARGETS.quota_points} points in all` },
    format: (v) => `${v.toFixed(1)} pts`,
    floor: SCORECARD_TARGETS.quota_points,
  },
  {
    key: 'ci',
    label: 'CI green',
    hint: 'PRs whose checks all passed when opened',
    target: { value: SCORECARD_TARGETS.pr_green_rate, goal: 'atLeast', text: pct(SCORECARD_TARGETS.pr_green_rate) },
    format: pct,
    floor: 1,
  },
];

export interface WeekPoint {
  week: string;
  value: number | null;
  detail: string | null;
}

export interface Series {
  measure: Measure;
  points: WeekPoint[];
  total: number | null;
  met: boolean | null;
}

const DAY_MS = 86_400_000;

function weeksBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(first); t <= Date.parse(last); t += 7 * DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

export const thisWeek = (now: Date = new Date()): string => weekOf(sqliteUtc(now.toISOString()));

const ratio = (done: number, of: number, what: string) => (of ? `${done} of ${of} ${what}` : null);

export function seriesOf(stats: Stats, now: Date = new Date()): Series[] {
  const runs = new Map(stats.weeks.map((w) => [w.week, w.measures]));
  const card = new Map(stats.scorecard.weeks.map((w) => [w.week, w]));
  const known = [...runs.keys(), ...card.keys()].sort();
  const current = thisWeek(now);
  const weeks = known.length ? weeksBetween(known[0], known[known.length - 1] > current ? known[known.length - 1] : current) : [];

  const pick: Record<MeasureKey, (week: string) => { value: number | null; detail: string | null }> = {
    first_run: (w) => {
      const m = runs.get(w);
      return { value: m?.first_run_rate ?? null, detail: m ? ratio(m.first_run_done, m.first_runs, 'first runs') : null };
    },
    interventions: (w) => {
      const m = card.get(w)?.measures.interventions;
      return { value: m ? m.total : null, detail: m ? `on ${plural(m.tasks, 'task')}` : null };
    },
    cost: (w) => {
      const m = runs.get(w);
      return { value: m?.cost_per_done_task ?? null, detail: m?.done_tasks ? `${m.done_tasks} done` : null };
    },
    minutes: (w) => {
      const m = runs.get(w);
      return { value: m?.minutes_per_done_task ?? null, detail: m?.done_tasks ? `${m.done_tasks} done` : null };
    },
    review: (w) => ({ value: card.get(w)?.measures.review_minutes ?? null, detail: null }),
    quota: (w) => {
      const w2 = card.get(w);
      return { value: w2 ? w2.quota_points : null, detail: null };
    },
    ci: (w) => {
      const m = card.get(w)?.measures.pr_checks;
      return { value: m?.rate ?? null, detail: m ? ratio(m.green, m.recorded, 'PRs') : null };
    },
  };

  return MEASURES.map((measure) => {
    const points = weeks.map((week) => ({ week, ...pick[measure.key](week) }));
    const total = measure.key === 'quota' && points.some((p) => p.value !== null) ? stats.scorecard.quota_points : null;
    const latest = points.find((p) => p.week === current)?.value ?? null;
    const judged = measure.key === 'quota' ? total : latest;
    const t = measure.target;
    const met = t === null || judged === null ? null : t.goal === 'atLeast' ? judged >= t.value : judged <= t.value;
    return { measure, points, total, met };
  });
}

export function weekLabel(week: string): string {
  const d = new Date(`${week}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export const hasData = (series: Series[]): boolean => series.some((s) => s.points.some((p) => p.value !== null));
