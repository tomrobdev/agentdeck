import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Stats } from '../../../../app/src/api/types.ts';
import { MEASURES, hasData, seriesOf, thisWeek, weekLabel } from '../../../../app/src/lib/insights/insights.ts';

type Measures = Stats['total'];
type Card = Stats['scorecard']['total'];

const runs = (over: Partial<Measures> = {}): Measures => ({
  tasks: 0,
  runs: 0,
  first_runs: 0,
  first_run_done: 0,
  first_run_rate: null,
  first_run_interval: null,
  denials: 0,
  denials_per_run: null,
  done_tasks: 0,
  cost_per_done_task: null,
  minutes_per_done_task: null,
  ...over,
});
const card = (over: Partial<Card> = {}): Card => ({
  interventions: { total: 0, tasks: 0, by_kind: {} },
  tasks: 0,
  queued_minutes: null,
  running_minutes: null,
  review_minutes: null,
  pr_checks: { recorded: 0, green: 0, rate: null },
  ...over,
});
const stats = (weeks: Stats['weeks'] = [], cardWeeks: Stats['scorecard']['weeks'] = [], quota = 0): Stats => ({
  repos: [],
  total: runs(),
  weeks,
  scorecard: { since: null, by: 'week', repos: [], total: card(), quota_points: quota, weeks: cardWeeks },
});

const NOW = new Date('2026-11-04T12:00:00Z'); // a Wednesday; its week starts Monday 2026-11-02

test('thisWeek is the Monday of the week', () => {
  assert.equal(thisWeek(NOW), '2026-11-02');
  assert.equal(thisWeek(new Date('2026-11-08T23:59:00Z')), '2026-11-02');
  assert.equal(thisWeek(new Date('2026-11-09T00:00:00Z')), '2026-11-09');
});

test('weekLabel is a short date', () => {
  assert.equal(weekLabel('2026-10-27'), 'Oct 27');
});

test('seriesOf with no data gives every measure an empty series, and hasData says so', () => {
  const series = seriesOf(stats(), NOW);
  assert.equal(series.length, MEASURES.length);
  assert.ok(series.every((s) => s.points.length === 0 && s.total === null && s.met === null));
  assert.equal(hasData(series), false);
});

test('seriesOf fills the weeks from the first with data to this one', () => {
  const series = seriesOf(stats([{ week: '2026-10-19', measures: runs({ first_runs: 4, first_run_done: 3, first_run_rate: 0.75 }) }]), NOW);
  const first = series.find((s) => s.measure.key === 'first_run')!;
  assert.deepEqual(
    first.points.map((p) => [p.week, p.value]),
    [
      ['2026-10-19', 0.75],
      ['2026-10-26', null],
      ['2026-11-02', null],
    ],
  );
  assert.equal(first.points[0].detail, '3 of 4 first runs');
  assert.equal(first.met, null); // this week has no value
  assert.equal(hasData(series), true);
});

test('seriesOf judges this week against the target, and quota by its total', () => {
  const series = seriesOf(
    stats(
      [{ week: '2026-11-02', measures: runs({ first_runs: 2, first_run_done: 2, first_run_rate: 1, done_tasks: 2 }) }],
      [{ week: '2026-11-02', measures: card({ interventions: { total: 1, tasks: 1, by_kind: {} } }), quota_points: 3 }],
      3,
    ),
    NOW,
  );
  const by = (key: string) => series.find((s) => s.measure.key === key)!;
  assert.equal(by('first_run').met, true);
  assert.equal(by('interventions').points.at(-1)!.detail, 'on 1 task');
  assert.equal(by('cost').met, null);
  assert.equal(by('quota').total, 3);
  assert.equal(typeof by('quota').met, 'boolean');
});

test('seriesOf shows a week after this one when the data runs ahead of the clock', () => {
  const series = seriesOf(stats([{ week: '2026-11-16', measures: runs({ first_run_rate: 0.5 }) }]), NOW);
  assert.equal(series[0].points.at(-1)!.week, '2026-11-16');
});
