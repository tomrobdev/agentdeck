// What failures are made of: failing checks by step, and failed or blocked runs by how they ended, per week and repo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countOfKept, parseChecks } from '../../src/domain/landing/pull-request/checks.ts';
import { failureReport, failuresTable } from '../../src/domain/insights/index.ts';
import type { StatRun } from '../../src/domain/insights/index.ts';
import { runEndOf } from '../../src/domain/runs/index.ts';
import { readCounts } from '../../src/db/mappers.ts';
import { asRepoId, asTaskId } from '../../src/domain/shared/index.ts';

const repo = asRepoId(1);
const W1 = '2026-11-03 10:00:00';
const W2 = '2026-11-10 10:00:00';

const run = (o: Partial<StatRun> & { task: number }): StatRun => ({
  repo_id: repo,
  task_id: asTaskId(o.task),
  attempt: 1,
  outcome: 'failed',
  started_at: W1,
  ended_at: W1,
  cost_usd: 0,
  denials: 0,
  task_status: 'failed',
  model: null,
  ...o,
});
const task = (o: Partial<Parameters<typeof failureReport>[0]['tasks'][number]>) => ({
  repo_id: repo,
  created_at: W1,
  pr_checks_opened: null,
  pr_checks_merged: null,
  ...o,
});
const name = () => 'repo';

test('counts failing checks by step and failed runs by how they ended, over two weeks', () => {
  const report = failureReport({
    repoName: name,
    tasks: [
      task({
        pr_checks_opened: {
          total: 3,
          failing: 2,
          pending: 0,
          failures: [
            { name: 'CI / check', step: 'Coverage' },
            { name: 'CI / check', step: 'Typecheck' },
          ],
        },
      }),
      task({ pr_checks_opened: { total: 2, failing: 1, pending: 0, failures: [{ name: 'CI / check', step: 'Coverage' }] } }),
      task({
        created_at: W2,
        pr_checks_opened: { total: 2, failing: 2, pending: 0 },
        pr_checks_merged: { total: 2, failing: 1, pending: 0 },
      }),
      task({ created_at: W2, pr_checks_merged: { total: 2, failing: 1, pending: 0, failures: [{ name: 'CI / check', step: null }] } }),
      task({ pr_checks_opened: { total: 2, failing: 0, pending: 0 } }),
    ],
    runs: [
      run({ task: 1, run_end: 'max_turns', last_test_failed: true }),
      run({ task: 1, attempt: 2, outcome: 'done', task_status: 'done' }),
      run({ task: 2, run_end: 'max_turns', last_test_failed: true, outcome: 'blocked', task_status: 'blocked' }),
      run({ task: 3, started_at: W2, run_end: 'error', last_test_failed: null }),
      run({ task: 4, started_at: W2 }),
      run({ task: 5, started_at: W2, run_end: 'ended', last_test_failed: false }),
      run({ task: 5, started_at: W2, attempt: 2, outcome: 'done', task_status: 'done' }),
    ],
  });
  assert.deepEqual(
    report.weeks.map((w) => w.week),
    ['2026-11-02', '2026-11-09'],
  );
  const [w1, w2] = report.weeks;
  assert.deepEqual(w1.checks_opened, [
    { cause: 'CI / check › Coverage', count: 2 },
    { cause: 'CI / check › Typecheck', count: 1 },
  ]);
  assert.deepEqual(w1.checks_merged, []);
  assert.deepEqual(w1.runs, [{ cause: 'used its turns, tests failing', count: 2 }]);
  assert.deepEqual([w1.runs_failed, w1.runs_fixed], [2, 1], 'a retry fixed task 1, task 2 is still blocked');
  assert.deepEqual(w2.checks_opened, [{ cause: 'unknown step', count: 2 }]);
  assert.deepEqual(w2.checks_merged, [
    { cause: 'CI / check › unknown step', count: 1 },
    { cause: 'unknown step', count: 1 },
  ]);
  assert.deepEqual(w2.runs, [
    { cause: 'ended on its own', count: 1 },
    { cause: 'stopped by an error', count: 1 },
    { cause: 'unknown end', count: 1 },
  ]);
  assert.deepEqual([w2.runs_failed, w2.runs_fixed], [3, 1]);
  assert.deepEqual(report.top.slice(0, 2), [
    { kind: 'check', where: 'opened', cause: 'CI / check › Coverage', count: 2 },
    { kind: 'check', where: 'opened', cause: 'unknown step', count: 2 },
  ]);
  assert.ok(report.top.some((c) => c.kind === 'run' && c.cause === 'used its turns, tests failing' && c.count === 2));
  assert.equal(report.top.length, 5);
  assert.match(failuresTable(report), /2× CI \/ check › Coverage/);
  assert.equal(failuresTable({ weeks: [], top: [] }), 'No failures recorded.');
});

test('since leaves out what began earlier but still finds the fix among all runs', () => {
  const report = failureReport({
    repoName: name,
    since: W2,
    tasks: [task({ pr_checks_opened: { total: 1, failing: 1, pending: 0 } })],
    runs: [run({ task: 1, run_end: 'cut_off' }), run({ task: 1, attempt: 2, outcome: 'done', started_at: W2 })],
  });
  assert.deepEqual(report.weeks, []);
});

test('a run ends as its summary says, and the counts keep the failing steps through storage', () => {
  assert.deepEqual(runEndOf({ end: 'max_turns', last_test: 'failed' }), { run_end: 'max_turns', last_test_failed: true });
  assert.deepEqual(runEndOf({ end: 'ended', last_test: 'passed' }), { run_end: 'ended', last_test_failed: false });
  assert.deepEqual(runEndOf({ end: 'cut_off', last_test: null }), { run_end: 'cut_off', last_test_failed: null });
  const counts = countOfKept(
    parseChecks([
      { name: 'a', conclusion: 'FAILURE' },
      { name: 'b', conclusion: 'SUCCESS' },
    ]).map((c) => (c.name === 'a' ? { ...c, step: 'Coverage' } : c)),
  );
  assert.deepEqual(counts.failures, [{ name: 'a', step: 'Coverage' }]);
  assert.deepEqual(readCounts(JSON.stringify(counts)), counts);
  assert.deepEqual(readCounts('{"total":2,"failing":1,"pending":0}'), { total: 2, failing: 1, pending: 0 }, 'old rows have no steps');
  assert.equal(countOfKept([]).failures, undefined);
});

test('stored counts drop a malformed failure and read a missing step as none', () => {
  const stored = '{"total":3,"failing":2,"pending":0,"failures":[{"name":"a","step":"x"},{"name":"b"},{"step":"y"},null]}';
  assert.deepEqual(readCounts(stored)?.failures, [
    { name: 'a', step: 'x' },
    { name: 'b', step: null },
  ]);
  assert.equal(readCounts('{"total":1,"failing":1,"pending":0,"failures":"none"}')?.failures, undefined);
  assert.equal(readCounts('{"total":1}'), null);
});
