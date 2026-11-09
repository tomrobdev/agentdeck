// Task history: every status change records one task_events row, atomically with the change.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskId } from '../../../src/domain/shared/id.ts';
import { MAX_RESTARTS } from '../../../src/domain/work/lifecycle/lifecycle.ts';
import { asTaskId } from '../../fixtures/fixtures.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-events-'));

const { openDb } = await import('../../../src/db/index.ts');
type Db = ReturnType<typeof openDb>;

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const add = (status: 'queued' | 'proposed' = 'queued') => db.addTask({ repo_id: repo.id, title: 't', prompt: 'p', status });
  return { db, add };
}

const last = (db: Db, id: TaskId) => {
  const events = db.eventsForTask(id);
  return events[events.length - 1];
};
const brief = (db: Db, id: TaskId) => db.eventsForTask(id).map((e) => [e.type, e.from_status, e.to_status, e.reason]);

test('addTask records created with the initial status', () => {
  const { db, add } = setup();
  const q = add();
  const p = add('proposed');
  assert.deepEqual(brief(db, q.id), [['created', null, 'queued', null]]);
  assert.deepEqual(brief(db, p.id), [['created', null, 'proposed', null]]);
  const e = last(db, q.id);
  assert.equal(e.task_id, q.id);
  assert.match(e.at, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  db.close();
});

test('claimNextTask records claim from queued to running', () => {
  const { db, add } = setup();
  const t = add();
  assert.equal(db.claimNextTask()?.id, t.id);
  assert.deepEqual(brief(db, t.id).at(-1), ['claim', 'queued', 'running', null]);
  // Nothing to claim: nothing recorded.
  assert.equal(db.claimNextTask(), undefined);
  assert.equal(db.eventsForTask(t.id).length, 2);
  db.close();
});

test('a claim writes its row through applyEvent: claimNextTask and applyEvent leave the same task and timeline', () => {
  const { db, add } = setup();
  const byClaim = add();
  const byEvent = add();
  // The higher id waits behind the lower one, so claimNextTask takes byClaim.
  const claimed = db.claimNextTask()!;
  assert.equal(claimed.id, byClaim.id);
  const applied = db.applyEvent(byEvent.id, { type: 'claim' })!;
  assert.deepEqual(
    [applied.event.type, applied.event.history, applied.event.from, applied.event.to],
    ['TaskStarted', 'claim', 'queued', 'running'],
  );
  assert.deepEqual(applied.pending, [], 'a claim has no follow-ups, so its row is not pending');
  const { id: _a, updated_at: _ua, created_at: _ca, ...fromClaim } = claimed;
  const { id: _b, updated_at: _ub, created_at: _cb, ...fromEvent } = applied.task;
  assert.deepEqual(fromClaim, fromEvent);
  assert.equal(claimed.attempts, 1);
  assert.deepEqual(brief(db, byClaim.id), brief(db, byEvent.id));
  assert.deepEqual(db.pendingFollowUps(), [], 'nor is the row claimNextTask wrote');
  db.close();
});

test('no claim row is written outside applyEvent', () => {
  const dir = new URL('../../../src/db/', import.meta.url);
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  assert.ok(files.includes('work/tasks-status.ts'), 'found the task store in db/work/');
  for (const file of files) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    for (const call of source.match(/recordEvent\([^;]*\)/g) ?? []) assert.doesNotMatch(call, /'claim'/, `${file}: ${call}`);
  }
  const tasks = readFileSync(new URL('work/tasks-status.ts', dir), 'utf8');
  const claim = /claimNextTask\(\)[^]*?\n {4}\},/.exec(tasks)?.[0] ?? '';
  assert.match(claim, /applyEvent\(id, \{ type: 'claim' \}\)/, 'claimNextTask claims through applyEvent');
  assert.doesNotMatch(claim, /recordEvent|\.update\(tasks\)/, 'claimNextTask writes no row of its own');
});

test('each lifecycle event records its type, from and to status and reason', () => {
  const { db, add } = setup();
  const cases: [string, () => TaskId, Parameters<Db['applyEvent']>[1], string, string, string | null][] = [];
  const running = () => {
    const t = add();
    db.applyEvent(t.id, { type: 'claim' });
    return t.id;
  };
  const proposed = () => add('proposed').id;
  const blocked = () => {
    const id = running();
    db.applyEvent(id, { type: 'finish', outcome: 'blocked' }, { reason: 'stuck' });
    return id;
  };
  cases.push(['claim', () => add().id, { type: 'claim' }, 'queued', 'running', null]);
  cases.push(['finish done', running, { type: 'finish', outcome: 'done' }, 'running', 'done', null]);
  cases.push(['finish blocked', running, { type: 'finish', outcome: 'blocked' }, 'running', 'blocked', 'needs a key']);
  cases.push(['finish failed', running, { type: 'finish', outcome: 'failed', retry: false }, 'running', 'failed', 'tests failed']);
  // One attempt used of DEFAULTS.maxAttempts (2): the failed run is requeued.
  cases.push(['finish failed retry', running, { type: 'finish', outcome: 'failed' }, 'running', 'queued', null]);
  cases.push(['rate_limited', running, { type: 'rate_limited' }, 'running', 'queued', null]);
  cases.push(['cancel queued', () => add().id, { type: 'cancel' }, 'queued', 'cancelled', null]);
  cases.push(['cancel running', running, { type: 'cancel' }, 'running', 'cancel_requested', null]);
  cases.push(['approve', proposed, { type: 'approve' }, 'proposed', 'queued', null]);
  cases.push(['reject', proposed, { type: 'reject' }, 'proposed', 'cancelled', null]);
  cases.push(['retry', blocked, { type: 'retry' }, 'blocked', 'queued', null]);
  // One restart short of too many: the next recover fails it.
  const restarted = () => {
    const id = running();
    db.raw.prepare('UPDATE tasks SET restarts = ? WHERE id = ?').run(MAX_RESTARTS - 1, id);
    return id;
  };
  cases.push(['recover', running, { type: 'recover' }, 'running', 'queued', 'restarted']);
  cases.push(['recover exhausted', restarted, { type: 'recover' }, 'running', 'failed', 'restarted']);

  for (const [name, make, event, from, to, reason] of cases) {
    const id = make();
    const before = db.eventsForTask(id).length;
    assert.ok(db.applyEvent(id, event, { reason }), name);
    const events = db.eventsForTask(id);
    assert.equal(events.length, before + 1, name);
    assert.deepEqual(brief(db, id).at(-1), [event.type, from, to, reason], name);
  }
  db.close();
});

test('a refused event records nothing', () => {
  const { db, add } = setup();
  const t = add();
  assert.equal(db.applyEvent(t.id, { type: 'approve' }), undefined);
  assert.equal(db.applyEvent(t.id, { type: 'finish', outcome: 'done' }), undefined);
  assert.equal(db.applyEvent(asTaskId(9999), { type: 'cancel' }), undefined);
  assert.deepEqual(brief(db, t.id), [['created', null, 'queued', null]]);
  assert.equal(db.eventsForTask(asTaskId(9999)).length, 0);
  db.close();
});

test('the status change and its event land together or not at all', () => {
  const { db, add } = setup();
  const t = add();
  db.raw.exec('DROP TABLE task_events');
  assert.throws(() => db.applyEvent(t.id, { type: 'cancel' }));
  assert.equal(db.getTask(t.id)?.status, 'queued');
  assert.throws(() => db.claimNextTask());
  assert.equal(db.getTask(t.id)?.status, 'queued');
  db.close();
});

test('events compose with an outer transaction', () => {
  const { db, add } = setup();
  const t = add();
  db.raw.exec('BEGIN');
  db.applyEvent(t.id, { type: 'cancel' });
  db.raw.exec('ROLLBACK');
  assert.equal(db.getTask(t.id)?.status, 'queued');
  assert.deepEqual(brief(db, t.id), [['created', null, 'queued', null]]);
  db.close();
});

test('recoverOrphans records a recover event per orphan', () => {
  const { db, add } = setup();
  const t = add();
  db.claimNextTask();
  db.recoverOrphans();
  assert.deepEqual(brief(db, t.id).at(-1), ['recover', 'running', 'queued', 'the daemon restarted 1 times while this task was running']);
  db.close();
});

test('eventsForTask uses the task_events_task index', () => {
  const { db } = setup();
  const plan = db.raw.prepare('EXPLAIN QUERY PLAN SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(1) as { detail: string }[];
  assert.match(plan.map((p) => p.detail).join('\n'), /INDEX task_events_task/);
  db.close();
});

test('PR and merge event reasons are written and read through the history functions, byte for byte', async () => {
  const { prEventReason, mergeReason, isAutoMergeReason, isRequestedMergeReason, isPrOpenedReason, prSeenState } =
    await import('../../../src/domain/work/lifecycle/history.ts');
  assert.equal(prEventReason({ type: 'opened', url: 'https://x/pull/1' }), 'opened https://x/pull/1');
  assert.equal(prEventReason({ type: 'failed', error: 'gh broke' }), 'could not open the PR: gh broke');
  assert.equal(prEventReason({ type: 'closed' }), 'closed without merging');
  assert.equal(prEventReason({ type: 'seen', state: 'merged' }), 'PR is merged');
  assert.equal(mergeReason('auto', 'squash'), 'auto-merged (squash)');
  assert.equal(mergeReason('request', 'rebase'), 'requested (rebase)');
  assert.equal(mergeReason('person', 'merge'), 'merge merge');
  assert.equal(mergeReason('person', 'squash'), 'squash merge');

  assert.equal(isAutoMergeReason(mergeReason('auto', 'squash')), true);
  assert.equal(isAutoMergeReason(mergeReason('request', 'squash')), false);
  assert.equal(isAutoMergeReason(mergeReason('person', 'squash')), false);
  assert.equal(isAutoMergeReason(null), false);
  assert.equal(isRequestedMergeReason(mergeReason('request', 'squash')), true);
  assert.equal(isRequestedMergeReason(mergeReason('auto', 'squash')), false);
  assert.equal(isPrOpenedReason(prEventReason({ type: 'opened', url: 'u' })), true);
  assert.equal(isPrOpenedReason('closed without merging'), false);
  assert.equal(prSeenState(prEventReason({ type: 'seen', state: 'closed' })), 'closed');
  assert.equal(prSeenState('closed without merging'), null);
  assert.equal(prSeenState(null), null);
});
