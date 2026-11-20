import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type MergeWait, SLOWEST_TASKS, measureMergeWait, mergeWaitOf, mergeWaitText } from '#domain/insights/merge-wait.ts';
import type { ScorecardEvent } from '#domain/insights/scorecard.ts';
import { asRepoId, asTaskId } from '#test/fixtures/fixtures.ts';

const ev = (type: string, at: string, o: Partial<ScorecardEvent> = {}, task = 1): ScorecardEvent => ({
  task_id: asTaskId(task),
  repo_id: asRepoId(1),
  type,
  from_status: null,
  to_status: null,
  reason: null,
  at,
  ...o,
});
const done = (at: string, task = 1) => ev('finish', at, { from_status: 'running', to_status: 'done' }, task);
const has = (w: MergeWait | null) => {
  assert.ok(w);
  return w;
};

test('a task whose PR auto-merged waited on checks', () => {
  const w = has(
    mergeWaitOf([
      done('2026-10-05 10:00:00'),
      ev('pr', '2026-10-05 10:01:00'),
      ev('merge', '2026-10-05 10:20:00', { reason: 'auto-merged (squash)' }),
    ]),
  );
  assert.equal(w.minutes, 20);
  assert.deepEqual(w.waits, { person: 0, checks: 19, conflict: 0, sync: 0, other: 1 });
});

test('a task a person merged waited on a person', () => {
  const w = has(
    mergeWaitOf([
      done('2026-10-05 10:00:00'),
      ev('pr', '2026-10-05 10:00:00'),
      ev('merge', '2026-10-05 12:00:00', { reason: 'squash merge' }),
    ]),
  );
  assert.equal(w.minutes, 120);
  assert.equal(w.waits.person, 120);
});

test('a task whose PR conflicted waited on a conflict, then a sync, then checks', () => {
  const w = has(
    mergeWaitOf([
      done('2026-10-05 10:00:00'),
      ev('sync', '2026-10-05 10:30:00', { reason: 'Resolved conflicts in 2 files' }),
      ev('sync', '2026-10-05 10:40:00', { reason: 'Synced with main: clean' }),
      ev('merge', '2026-10-05 10:50:00', { reason: 'auto-merged (squash)' }),
    ]),
  );
  assert.deepEqual(w.waits, { person: 0, checks: 10, conflict: 30, sync: 10, other: 0 });
  assert.equal(w.minutes, 50);
});

test('a task that is not done or not merged has no wait', () => {
  assert.equal(mergeWaitOf([ev('claim', '2026-10-05 10:00:00')]), null);
  assert.equal(mergeWaitOf([done('2026-10-05 10:00:00')]), null);
});

test('the median and the slowest five are over the tasks that merged', () => {
  const byTask = new Map<ReturnType<typeof asTaskId>, ScorecardEvent[]>();
  const ids = [1, 2, 3, 4, 5, 6, 7].map(asTaskId);
  ids.forEach((id, i) => {
    byTask.set(id, [done('2026-10-05 10:00:00', id), ev('merge', `2026-10-05 1${i}:00:00`, { reason: 'squash merge' }, id)]);
  });
  const m = measureMergeWait(byTask, [...ids, asTaskId(8)]);
  assert.equal(m.tasks, 7);
  assert.equal(m.median_minutes, 180);
  assert.equal(m.slowest.length, SLOWEST_TASKS);
  assert.equal(m.slowest[0].task_id, 7);
  assert.match(mergeWaitText(m), /median 180\.0 min over 7 tasks/);
});
