import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_BUDGET, decide, validateBudget } from '#domain/capacity/governor.ts';

const NOW = 1_800_000_000;
const DAY = 86400;
const week = (utilization: number, daysIn: number) => ({ window: 'seven_day', utilization, resets_at: NOW + (7 - daysIn) * DAY });
const five = (utilization: number) => ({ window: 'five_hour', utilization, resets_at: NOW + 3600 });

test('no data: run freely', () => {
  assert.deepEqual(decide([], DEFAULT_BUDGET, 2, NOW), { allow: true, max_concurrent: 2, reason: null, until: null, weekly_allowed: null });
});

test('5h soft limit throttles to one task, cap holds until reset', () => {
  const soft = decide([five(0.65)], DEFAULT_BUDGET, 2, NOW);
  assert.equal(soft.allow, true);
  assert.equal(soft.max_concurrent, 1);
  assert.match(soft.reason!, /one task at a time/);

  const cap = decide([five(0.86)], DEFAULT_BUDGET, 2, NOW);
  assert.equal(cap.allow, false);
  assert.equal(cap.until, NOW + 3600);
});

test('expired windows are ignored', () => {
  const stale = { window: 'five_hour', utilization: 0.99, resets_at: NOW - 1 };
  assert.equal(decide([stale], DEFAULT_BUDGET, 2, NOW).allow, true);
});

test('weekly pacing allows linear spend plus slack', () => {
  const ok = decide([week(0.45, 3.5)], DEFAULT_BUDGET, 2, NOW);
  assert.equal(ok.allow, true);
  assert.ok(Math.abs(ok.weekly_allowed! - 0.5) < 1e-9);

  const ahead = decide([week(0.6, 3.5)], DEFAULT_BUDGET, 2, NOW);
  assert.equal(ahead.allow, false);
  assert.match(ahead.reason!, /ahead of pace/);
  assert.equal(ahead.until, NOW + Math.ceil(0.875 * DAY));
});

test('weekly cap holds until the window resets', () => {
  const d = decide([week(0.81, 6.9)], DEFAULT_BUDGET, 2, NOW);
  assert.equal(d.allow, false);
  assert.equal(d.until, NOW + Math.round(0.1 * DAY));
});

test('the later of two holds wins', () => {
  const d = decide([five(0.9), week(0.81, 2)], DEFAULT_BUDGET, 2, NOW);
  assert.equal(d.until, NOW + 5 * DAY);
  assert.match(d.reason!, /5h usage 90%.*7d usage 81%/);
});

test('budget validation', () => {
  assert.equal(validateBudget(DEFAULT_BUDGET), null);
  assert.match(validateBudget({ ...DEFAULT_BUDGET, weekly_max: 1.5 })!, /weekly_max/);
  assert.match(validateBudget({ ...DEFAULT_BUDGET, five_hour_soft: 0.9 })!, /five_hour_soft/);
});
