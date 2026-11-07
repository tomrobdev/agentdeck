import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionError, pilotStats } from '../src/application/actions.ts';
import { openDb } from '../src/db/index.ts';
import type { TaskId } from '../src/domain/id/id.ts';
import type { RunOutcome } from '../src/domain/run/run.ts';
import { type StatRun, measure, statsTable, wilson } from '../src/domain/run/stats.ts';
import { asRepoId, asTaskId, blockedTask, doneTask, failedTask } from './fixtures.ts';

const near = (actual: number | undefined, expected: number, eps = 1e-3) =>
  assert.ok(actual !== undefined && Math.abs(actual - expected) < eps, `${actual} is not ${expected}`);

test('wilson: hand-checked intervals', () => {
  // 8 of 10: centre 0.71672, half-width 0.22657
  near(wilson(8, 10)?.low, 0.4902);
  near(wilson(8, 10)?.high, 0.9433);
  // 4 of 4: the upper end is capped at 1
  near(wilson(4, 4)?.low, 0.51);
  assert.equal(wilson(4, 4)?.high, 1);
  // 0 of 5: the lower end is 0
  assert.equal(wilson(0, 5)?.low, 0);
  near(wilson(0, 5)?.high, 0.4345);
  assert.equal(wilson(0, 0), null);
});

const run = (o: Partial<StatRun>): StatRun => ({
  repo_id: asRepoId(1),
  task_id: asTaskId(1),
  attempt: 1,
  outcome: 'done',
  started_at: '2026-10-01 10:00:00',
  ended_at: '2026-10-01 10:10:00',
  cost_usd: 1,
  denials: 0,
  task_status: 'done',
  ...o,
});

test('measure: first-run success, denials per run, cost and minutes per done task', () => {
  const m = measure([
    run({ task_id: asTaskId(1), cost_usd: 1, denials: 0 }), // done first time
    run({ task_id: asTaskId(2), attempt: 1, outcome: 'failed', cost_usd: 0.5, denials: 2 }), // failed, then
    run({ task_id: asTaskId(2), attempt: 2, cost_usd: 1.5, ended_at: '2026-10-01 10:20:00' }), // done on the retry
    run({ task_id: asTaskId(3), outcome: 'blocked', task_status: 'blocked', cost_usd: 9, denials: 1 }),
    run({ task_id: asTaskId(4), outcome: null, ended_at: null, task_status: 'running' }), // unfinished: not a first run yet
  ]);
  assert.equal(m.tasks, 4);
  assert.equal(m.runs, 5);
  assert.equal(m.first_runs, 3);
  assert.equal(m.first_run_done, 1);
  near(m.first_run_rate ?? NaN, 1 / 3);
  near(m.first_run_interval?.low, 0.0615);
  near(m.first_run_interval?.high, 0.7923);
  assert.equal(m.denials, 3);
  assert.equal(m.denials_per_run, 3 / 5);
  assert.equal(m.done_tasks, 2);
  assert.equal(m.cost_per_done_task, (1 + 0.5 + 1.5) / 2); // the blocked task's $9 is not counted
  assert.equal(m.minutes_per_done_task, (10 + 10 + 20) / 2);
});

test('measure: a run a daemon restart cut off is not a first run; the run that resumed it is', () => {
  const m = measure([
    run({ task_id: asTaskId(1), outcome: 'interrupted' }), // cut off by a restart
    run({ task_id: asTaskId(1) }), // the same attempt, resumed: done
  ]);
  assert.equal(m.runs, 2);
  assert.equal(m.first_runs, 1);
  assert.equal(m.first_run_done, 1);
  assert.equal(m.first_run_rate, 1);
});

test('measure: nothing to measure gives nulls, not NaN', () => {
  const m = measure([]);
  assert.equal(m.first_run_rate, null);
  assert.equal(m.first_run_interval, null);
  assert.equal(m.denials_per_run, null);
  assert.equal(m.cost_per_done_task, null);
  assert.match(statsTable({ repos: [], total: m }), /total\s+0\s+0\s+–\s+–\s+–\s+–/);
});

/** A finished work run with the numbers a test checks. */
function work(
  db: ReturnType<typeof openDb>,
  task_id: TaskId,
  attempt: number,
  outcome: RunOutcome,
  cost_usd: number,
  denials: number,
  minutes: number,
) {
  const id = db.startRun(task_id, attempt, 'log');
  db.finishRun(id, { outcome, cost_usd, denials });
  db.raw
    .prepare(`UPDATE runs SET started_at = '2026-10-01 10:00:00', ended_at = datetime('2026-10-01 10:00:00', ?) WHERE id = ?`)
    .run(`+${minutes} minutes`, id);
  return id;
}

test('pilotStats: the report per repo, a total row, --repo and unknown repos', () => {
  const db = openDb(':memory:');
  const a = db.addRepo({ name: 'alpha', path: '/tmp/a', base_branch: 'main' });
  const b = db.addRepo({ name: 'beta', path: '/tmp/b', base_branch: 'main' });
  db.addRepo({ name: 'idle', path: '/tmp/i', base_branch: 'main' });

  // alpha: one task done first time, one done on its retry, one blocked: 1 of 3 first runs done
  const a1 = doneTask(db, a);
  work(db, a1.id, 1, 'done', 1, 0, 10);
  const a2 = doneTask(db, a);
  work(db, a2.id, 1, 'failed', 0.5, 2, 5);
  work(db, a2.id, 2, 'done', 1.5, 0, 15);
  const a3 = blockedTask(db, a);
  work(db, a3.id, 1, 'blocked', 3, 1, 20);
  // a resolve run is not an attempt: it counts for nothing
  const resolve = db.startRun(a1.id, 1, 'log', 'resolve');
  db.finishRun(resolve, { outcome: 'done', cost_usd: 100, denials: 50 });

  // beta: four tasks done first time, and one failed
  for (let i = 0; i < 4; i++) work(db, doneTask(db, b).id, 1, 'done', 2, 0, 6);
  work(db, failedTask(db, b).id, 1, 'failed', 1, 0, 3);

  const report = pilotStats(db);
  assert.deepEqual(
    report.repos.map((r) => r.repo),
    ['alpha', 'beta'],
  );
  const [alpha, beta] = report.repos.map((r) => r.measures);
  assert.equal(alpha.tasks, 3);
  assert.equal(alpha.runs, 4);
  assert.equal(alpha.first_runs, 3);
  assert.equal(alpha.first_run_done, 1);
  near(alpha.first_run_interval?.low, 0.0615);
  assert.equal(alpha.denials, 3);
  assert.equal(alpha.denials_per_run, 3 / 4);
  assert.equal(alpha.done_tasks, 2);
  assert.equal(alpha.cost_per_done_task, 1.5); // (1 + 0.5 + 1.5) / 2
  assert.equal(alpha.minutes_per_done_task, 15); // (10 + 5 + 15) / 2
  assert.equal(beta.tasks, 5);
  assert.equal(beta.first_runs, 5);
  assert.equal(beta.first_run_done, 4);
  assert.equal(beta.denials_per_run, 0);
  assert.equal(beta.cost_per_done_task, 2);
  assert.equal(beta.minutes_per_done_task, 6);
  assert.equal(report.total.tasks, 8);
  assert.equal(report.total.first_runs, 8);
  assert.equal(report.total.first_run_done, 5);
  assert.equal(report.total.runs, 9);
  assert.equal(report.total.done_tasks, 6);
  assert.match(statsTable(report), /^repo\b[^\n]*\nalpha\b[^\n]*\nbeta\b[^\n]*\ntotal\b/);

  const onlyBeta = pilotStats(db, { repo: 'beta' });
  assert.deepEqual(
    onlyBeta.repos.map((r) => r.repo),
    ['beta'],
  );
  assert.deepEqual(onlyBeta.total, beta);
  assert.deepEqual(pilotStats(db, { repo: 'idle' }).total.runs, 0);
  assert.throws(
    () => pilotStats(db, { repo: 'nope' }),
    (e) => e instanceof ActionError && /no repo "nope"/.test(e.message),
  );
  db.close();
});
