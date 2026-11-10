import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pilotStats } from '../../src/application/actions.ts';
import { openDb } from '../fixtures/open-db.ts';
import {
  type ScorecardEvent,
  type ScorecardTask,
  type ScorecardTaskRow,
  buildScorecard,
  checksGreen,
  resolveAutoMerge,
  cycleOf,
  parseSince,
  scorecardText,
  summarizeChecks,
} from '../../src/domain/insights/scorecard.ts';
import { countInterventions } from '../../src/domain/insights/interventions.ts';
import { type StatRun, measureByWeek } from '../../src/domain/insights/stats.ts';
import { quotaSpends } from '../../src/domain/capacity/quota.ts';
import { asRepoId, asTaskId, doneTask, queuedTask } from '../fixtures/fixtures.ts';

const near = (actual: number | null | undefined, expected: number, eps = 1e-9) =>
  assert.ok(actual !== undefined && actual !== null && Math.abs(actual - expected) < eps, `${actual} is not ${expected}`);

const ev = (o: Partial<ScorecardEvent> & { type: string; at: string }): ScorecardEvent => ({
  task_id: asTaskId(1),
  repo_id: asRepoId(1),
  from_status: null,
  to_status: null,
  reason: null,
  ...o,
});
const task = (o: Partial<ScorecardTask> = {}): ScorecardTask => ({
  id: asTaskId(1),
  repo_id: asRepoId(1),
  created_at: '2026-10-05 10:00:00',
  auto_merge_from: null,
  pr_checks_opened: null,
  ...o,
});
test('measureByWeek puts a task in the week of its first run, oldest week first', () => {
  const run = (o: Partial<StatRun>): StatRun => ({
    repo_id: asRepoId(1),
    task_id: asTaskId(1),
    attempt: 1,
    outcome: 'done',
    started_at: '2026-10-05 10:00:00',
    ended_at: '2026-10-05 10:10:00',
    cost_usd: 1,
    denials: 0,
    task_status: 'done',
    model: 'sonnet',
    ...o,
  });
  const weeks = measureByWeek([
    run({ task_id: asTaskId(2), started_at: '2026-10-13 09:00:00', ended_at: '2026-10-13 09:30:00', cost_usd: 3 }),
    run({ task_id: asTaskId(1), outcome: 'failed' }),
    run({ task_id: asTaskId(1), attempt: 2, started_at: '2026-10-12 08:00:00', ended_at: '2026-10-12 08:20:00', cost_usd: 2 }),
  ]);
  assert.deepEqual(
    weeks.map((w) => w.week),
    ['2026-10-05', '2026-10-12'],
  );
  assert.equal(weeks[0].measures.runs, 2);
  assert.equal(weeks[0].measures.first_run_rate, 0);
  near(weeks[0].measures.cost_per_done_task, 3);
  near(weeks[0].measures.minutes_per_done_task, 30);
  assert.equal(weeks[1].measures.first_run_rate, 1);
  near(weeks[1].measures.cost_per_done_task, 3);
});

const row = (o: Partial<ScorecardTaskRow> = {}): ScorecardTaskRow => ({
  id: asTaskId(1),
  repo_id: asRepoId(1),
  created_at: '2026-10-05 10:00:00',
  auto_merge: null,
  repo_auto_merge: false,
  pr_checks_opened: null,
  ...o,
});

test('countInterventions: only a person event that changes the outcome counts', () => {
  const tasks = new Map([
    [1, task({ id: asTaskId(1), auto_merge_from: '' })],
    [2, task({ id: asTaskId(2) })],
    [3, task({ id: asTaskId(3), auto_merge_from: '2026-10-06 00:00:00' })],
  ]);
  const at = '2026-10-05 12:00:00';
  const c = countInterventions(
    [
      ev({ type: 'retry', reason: 'use the helper in lib/', at }),
      ev({ type: 'retry', reason: null, at }),
      ev({ type: 'retry', reason: '  ', at }),
      ev({ type: 'retry', reason: "AgentDeck installed lodash on the branch at the person's request.", at }),
      ev({ type: 'unblock_retry', reason: 'Unblock run: use sqlite', at }),
      ev({ type: 'review_retry', reason: 'Review run: handle tabs', at }),
      ev({ type: 'mark_done', from_status: 'blocked', to_status: 'done', at }),
      ev({ type: 'cancel', from_status: 'queued', to_status: 'cancelled', at }),
      ev({ type: 'edit', from_status: 'queued', to_status: 'queued', at }),
      ev({ type: 'edit', from_status: 'blocked', to_status: 'blocked', at }),
      ev({ type: 'edit', from_status: 'proposed', to_status: 'proposed', at }),
      ev({ type: 'edit', from_status: 'failed', to_status: 'failed', at }),
      ev({ type: 'merge', reason: 'squash merge', at }),
      ev({ type: 'merge', reason: 'auto-merged (squash)', at }),
      ev({ type: 'merge', reason: 'squash merge', task_id: asTaskId(2), at }),
      ev({ type: 'merge', reason: 'squash merge', task_id: asTaskId(3), at }),
      ev({ type: 'merge', reason: 'squash merge', task_id: asTaskId(3), at: '2026-10-07 09:00:00' }),
      ev({ type: 'approve', from_status: 'proposed', to_status: 'queued', at }),
      ev({ type: 'claim', at }),
      ev({ type: 'retry', reason: 'orphan', task_id: asTaskId(99), at }),
    ],
    tasks,
  );
  assert.deepEqual(c.by_kind, {
    retry_with_note: 1,
    mark_done: 1,
    install_needs: 1,
    cancel: 1,
    edit: 2,
    manual_merge: 2,
  });
  assert.equal(c.total, 8);
  assert.equal(c.tasks, 2);
});

test('cycleOf: queued, running and review minutes from a task history', () => {
  const c = cycleOf([
    ev({ type: 'created', to_status: 'queued', at: '2026-10-05 10:00:00' }),
    ev({ type: 'claim', from_status: 'queued', to_status: 'running', at: '2026-10-05 10:10:00' }),
    ev({ type: 'finish', from_status: 'running', to_status: 'queued', at: '2026-10-05 10:35:00' }),
    ev({ type: 'claim', from_status: 'queued', to_status: 'running', at: '2026-10-05 11:00:00' }),
    ev({ type: 'plan_unfinished', from_status: 'running', to_status: 'running', at: '2026-10-05 11:10:00' }),
    ev({ type: 'finish', from_status: 'running', to_status: 'done', at: '2026-10-05 11:20:00' }),
    ev({ type: 'merge', from_status: 'done', to_status: 'done', at: '2026-10-05 13:20:00' }),
  ]);
  assert.deepEqual(c, { queued: 10, running: 45, review: 120 });

  assert.deepEqual(
    cycleOf([
      ev({ type: 'created', to_status: 'proposed', at: '2026-10-05 09:00:00' }),
      ev({ type: 'approve', from_status: 'proposed', to_status: 'queued', at: '2026-10-05 10:00:00' }),
      ev({ type: 'claim', from_status: 'queued', to_status: 'running', at: '2026-10-05 10:30:00' }),
    ]),
    { queued: 30, running: null, review: null },
  );
  assert.deepEqual(cycleOf([]), { queued: null, running: null, review: null });
});

test('PR checks: green is some checks, none failing or pending', () => {
  assert.equal(checksGreen({ total: 3, failing: 0, pending: 0 }), true);
  assert.equal(checksGreen({ total: 3, failing: 1, pending: 0 }), false);
  assert.equal(checksGreen({ total: 3, failing: 0, pending: 1 }), false);
  assert.equal(checksGreen({ total: 0, failing: 0, pending: 0 }), false);
  const s = summarizeChecks([
    task({ pr_checks_opened: { total: 2, failing: 0, pending: 0 } }),
    task({ pr_checks_opened: { total: 2, failing: 1, pending: 0 } }),
    task({ pr_checks_opened: { total: 5, failing: 0, pending: 0 } }),
    task({ pr_checks_opened: { total: 1, failing: 0, pending: 0 } }),
    task({ pr_checks_opened: null }),
  ]);
  assert.deepEqual(s, { recorded: 4, green: 3, rate: 0.75 });
  assert.deepEqual(summarizeChecks([]), { recorded: 0, green: 0, rate: null });
});

test('quotaSpends: rises add up, a reset counts what the new window shows', () => {
  const sample = (utilization: number, resets_at: number, observed_at: string) => ({ utilization, resets_at, observed_at });
  const spends = quotaSpends([
    sample(0.1, 100, '2026-10-05 10:00:00'),
    sample(0.25, 100, '2026-10-05 11:00:00'),
    sample(0.4, 100, '2026-10-05 12:00:00'),
    sample(0.05, 200, '2026-10-12 09:00:00'),
    sample(0.12, 200, '2026-10-12 10:00:00'),
  ]);
  assert.deepEqual(
    spends.map((s) => s.at),
    ['2026-10-05 11:00:00', '2026-10-05 12:00:00', '2026-10-12 09:00:00', '2026-10-12 10:00:00'],
  );
  assert.deepEqual(
    spends.map((s) => Math.round(s.points * 1e6) / 1e6),
    [15, 15, 5, 7],
  );
  assert.deepEqual(quotaSpends([]), []);
});

test("resolveAutoMerge: auto-merge is known to be on from the repo's first merge by the daemon", () => {
  const events = [
    ev({ repo_id: asRepoId(1), type: 'merge', reason: 'squash merge', at: '2026-10-01 10:00:00' }),
    ev({ repo_id: asRepoId(1), type: 'merge', reason: 'auto-merged (squash)', at: '2026-10-08 10:00:00' }),
    ev({ repo_id: asRepoId(1), type: 'merge', reason: 'auto-merged (squash)', at: '2026-10-06 10:00:00' }),
  ];
  const from = (o: Partial<ScorecardTaskRow>) => resolveAutoMerge([row(o)], events)[0].auto_merge_from;
  assert.equal(from({ repo_auto_merge: true }), '2026-10-06 10:00:00');
  assert.equal(from({ repo_auto_merge: true, auto_merge: false }), null);
  assert.equal(from({ repo_auto_merge: false, auto_merge: true }), '');
  assert.equal(from({ repo_auto_merge: false }), null);
  assert.equal(from({ repo_id: asRepoId(2), repo_auto_merge: true }), null);
});

test('parseSince: a date, or a date and time, as a sqlite stamp', () => {
  assert.equal(parseSince('2026-10-18'), '2026-10-18 00:00:00');
  assert.equal(parseSince('2026-10-18 08:30'), '2026-10-18 08:30:00');
  assert.equal(parseSince('2026-10-18T08:30:15'), '2026-10-18 08:30:15');
  assert.equal(parseSince('2026-02-30'), null);
  assert.equal(parseSince('last week'), null);
});

test('buildScorecard: per repo, per week, with --since', () => {
  const week1 = '2026-10-05';
  const week2 = '2026-10-12';
  const tasks = [
    row({
      id: asTaskId(1),
      repo_id: asRepoId(1),
      created_at: '2026-10-05 10:00:00',
      pr_checks_opened: { total: 2, failing: 0, pending: 0 },
    }),
    row({ id: asTaskId(2), repo_id: asRepoId(1), created_at: '2026-10-06 10:00:00' }),
    row({
      id: asTaskId(3),
      repo_id: asRepoId(2),
      created_at: '2026-10-12 10:00:00',
      pr_checks_opened: { total: 2, failing: 1, pending: 0 },
    }),
  ];
  const life = (id: number, repo_id: number, day: string, queued: number, ran: number, review?: number): ScorecardEvent[] => {
    const at = (m: number) => new Date(Date.parse(`${day}T10:00:00Z`) + m * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    return [
      ev({ task_id: asTaskId(id), repo_id: asRepoId(repo_id), type: 'created', to_status: 'queued', at: at(0) }),
      ev({ task_id: asTaskId(id), repo_id: asRepoId(repo_id), type: 'claim', from_status: 'queued', to_status: 'running', at: at(queued) }),
      ev({
        task_id: asTaskId(id),
        repo_id: asRepoId(repo_id),
        type: 'finish',
        from_status: 'running',
        to_status: 'done',
        at: at(queued + ran),
      }),
      ...(review === undefined
        ? []
        : [
            ev({
              task_id: asTaskId(id),
              repo_id: asRepoId(repo_id),
              type: 'merge',
              from_status: 'done',
              to_status: 'done',
              at: at(queued + ran + review),
            }),
          ]),
    ];
  };
  const events = [
    ...life(1, 1, '2026-10-05', 10, 30, 120),
    ...life(2, 1, '2026-10-06', 30, 60),
    ...life(3, 2, '2026-10-12', 20, 90, 30),
    ev({
      task_id: asTaskId(2),
      repo_id: asRepoId(1),
      type: 'mark_done',
      from_status: 'blocked',
      to_status: 'done',
      at: '2026-10-07 09:00:00',
    }),
    ev({
      task_id: asTaskId(3),
      repo_id: asRepoId(2),
      type: 'cancel',
      from_status: 'queued',
      to_status: 'cancelled',
      at: '2026-10-13 09:00:00',
    }),
  ];
  const samples = [
    { utilization: 0.1, resets_at: 1, observed_at: '2026-10-05 09:00:00' },
    { utilization: 0.18, resets_at: 1, observed_at: '2026-10-06 09:00:00' },
    { utilization: 0.2, resets_at: 1, observed_at: '2026-10-13 09:00:00' },
  ];
  const input = { tasks, events, samples, repoName: (id: number) => (id === 1 ? 'alpha' : 'beta') };

  const card = buildScorecard({ ...input, by: 'week' });
  assert.deepEqual(
    card.repos.map((r) => r.repo),
    ['alpha', 'beta'],
  );
  const [alpha, beta] = card.repos.map((r) => r.measures);
  assert.equal(alpha.interventions.total, 1);
  assert.equal(beta.interventions.total, 1);
  assert.equal(alpha.queued_minutes, 20);
  assert.equal(alpha.running_minutes, 45);
  assert.equal(alpha.review_minutes, 120);
  assert.deepEqual(alpha.pr_checks, { recorded: 1, green: 1, rate: 1 });
  assert.deepEqual(beta.pr_checks, { recorded: 1, green: 0, rate: 0 });
  assert.equal(card.total.queued_minutes, 20);
  assert.equal(card.total.running_minutes, 60);
  assert.equal(card.total.review_minutes, 75);
  assert.equal(card.total.interventions.total, 2);
  assert.deepEqual(card.total.pr_checks, { recorded: 2, green: 1, rate: 0.5 });
  near(card.quota_points, 10);
  assert.deepEqual(
    card.weeks.map((w) => [w.week, w.measures.tasks, w.measures.interventions.total, Math.round(w.quota_points * 1e6) / 1e6]),
    [
      [week1, 2, 1, 8],
      [week2, 1, 1, 2],
    ],
  );
  assert.equal(card.weeks[0].measures.queued_minutes, 20);
  assert.equal(card.weeks[1].measures.review_minutes, 30);

  assert.deepEqual(buildScorecard(input).weeks, []);
  const late = buildScorecard({ ...input, since: '2026-10-06 12:00:00' });
  assert.equal(late.total.tasks, 1);
  assert.equal(late.total.interventions.by_kind.mark_done, 1);
  assert.equal(late.total.interventions.total, 2);
  const since = buildScorecard({ ...input, since: '2026-10-12 00:00:00' });
  assert.equal(since.total.tasks, 1);
  assert.equal(since.total.interventions.total, 1);
  near(since.quota_points, 2);
  assert.equal(since.since, '2026-10-12 00:00:00');
  assert.deepEqual(
    since.repos.map((r) => r.repo),
    ['beta'],
  );

  const text = scorecardText(card);
  assert.match(text, /^repo\s+interventions\s+queued min[^\n]*\nalpha\b[^\n]*\nbeta\b[^\n]*\ntotal\b/);
  assert.match(text, /week of[^\n]*quota pts\n2026-10-05\b[^\n]*\n2026-10-12\b/);
  assert.match(text, /interventions: 2 on 2 tasks \(retry_with_note 0, mark_done 1, install_needs 0, cancel 1, edit 0, manual_merge 0\)/);
  assert.match(text, /quota spent: 10\.0 points/);
});

test('pilotStats: an edit is recorded in the history, and the scorecard reads the database', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'alpha', path: '/tmp/a', base_branch: 'main' });
  const queued = queuedTask(db, repo);
  assert.ok(db.editTask(queued.id, { title: 'one, edited', priority: 2 }));
  const edit = db.eventsForTask(queued.id).find((e) => e.type === 'edit');
  assert.equal(edit?.from_status, 'queued');
  assert.equal(edit?.to_status, 'queued');
  assert.equal(edit?.reason, 'title, priority');
  const done = doneTask(db, repo);
  assert.equal(db.editTask(done.id, { title: 'x' }), undefined);
  assert.equal(db.eventsForTask(done.id).filter((e) => e.type === 'edit').length, 0);

  db.recordUsageWindow('seven_day', 0.1, 1000, null);
  db.recordUsageWindow('seven_day', 0.15, 1000, null);
  const report = pilotStats(db, { by: 'week' });
  assert.equal(report.scorecard.total.interventions.by_kind.edit, 1);
  assert.equal(report.scorecard.total.interventions.total, 1);
  near(report.scorecard.quota_points, 5, 1e-6);
  assert.equal(report.scorecard.weeks.length, 1);
  assert.equal(pilotStats(db, { since: '2999-01-01 00:00:00' }).scorecard.total.interventions.total, 0);
  db.close();
});
