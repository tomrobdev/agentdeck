import assert from 'node:assert/strict';
import { test } from 'node:test';
import { median, minutesBetween, sqliteMs, sqliteUtc, weekOf } from '../../src/domain/shared/time.ts';

test('sqliteMs reads a sqlite stamp as UTC', () => {
  assert.equal(sqliteMs('2026-10-01 10:00:00'), Date.UTC(2026, 9, 1, 10));
  assert.ok(Number.isNaN(sqliteMs('nonsense')));
});

test('sqliteUtc writes an ISO date as a sqlite stamp, and sqliteMs reads it back', () => {
  assert.equal(sqliteUtc('2026-10-01T12:30:45+02:00'), '2026-10-01 10:30:45');
  assert.equal(sqliteMs(sqliteUtc('2026-10-01T10:30:45Z')), Date.UTC(2026, 9, 1, 10, 30, 45));
});

test('minutesBetween reads sqlite timestamps', () => {
  assert.equal(minutesBetween('2026-10-01 10:00:00', '2026-10-01 10:12:30'), 12.5);
  assert.equal(minutesBetween('nonsense', '2026-10-01 10:00:00'), 0);
  assert.equal(minutesBetween('2026-10-01 10:00:00', '2026-10-01 09:00:00'), 0);
});

test('weekOf: the Monday of the week, in UTC', () => {
  assert.equal(weekOf('2026-10-05 10:00:00'), '2026-10-05'); // a Monday
  assert.equal(weekOf('2026-10-11 23:59:59'), '2026-10-05'); // the Sunday after
  assert.equal(weekOf('2026-10-12 00:00:00'), '2026-10-12');
  assert.equal(weekOf('2026-10-04 12:00:00'), '2026-09-28'); // the Sunday before
  assert.equal(weekOf('nonsense'), '');
});

test('median: the middle value, or the mean of the two middle ones', () => {
  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([120, 30]), 75);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});
