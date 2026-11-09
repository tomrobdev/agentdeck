import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type TaskEvent,
  type PersonEvent,
  type RuleCounters,
  type TaskStatus,
  MAX_RESTARTS,
  RULES,
  TASK_STATUSES,
  canApply,
  fromStatuses,
  nextStatus,
  personEvents,
} from '../../../src/domain/work/lifecycle.ts';

const EVENTS: Record<string, TaskEvent> = {
  claim: { type: 'claim' },
  'finish done': { type: 'finish', outcome: 'done' },
  'finish blocked': { type: 'finish', outcome: 'blocked' },
  'finish cancelled': { type: 'finish', outcome: 'cancelled' },
  'finish failed (no attempts left)': { type: 'finish', outcome: 'failed' },
  'finish failed (worker crashed)': { type: 'finish', outcome: 'failed', retry: false },
  'finish failed (attempts left)': { type: 'finish', outcome: 'failed' },
  rate_limited: { type: 'rate_limited' },
  conflict: { type: 'conflict' },
  cancel: { type: 'cancel' },
  approve: { type: 'approve' },
  reject: { type: 'reject' },
  retry: { type: 'retry' },
  mark_done: { type: 'mark_done' },
  pr_merged: { type: 'pr_merged' },
  'recover after restart': { type: 'recover' },
  'recover after too many restarts': { type: 'recover' },
};

/**
 * The counters of a task before each event: one restart short of too many makes the next recover the last, and a failed run
 * is requeued only with attempts left. A task with neither has used its one attempt.
 */
const COUNTERS: Record<string, RuleCounters> = {
  'recover after too many restarts': { restarts: MAX_RESTARTS - 1 },
  'finish failed (worker crashed)': { attempts: 1, max_attempts: 3 },
  'finish failed (attempts left)': { attempts: 1, max_attempts: 3 },
};
const countersOf = (name: string): RuleCounters => COUNTERS[name] ?? { attempts: 1, max_attempts: 1 };

// event → status it is allowed from → status it leads to. Anything not listed must be refused.
const ALLOWED: Record<string, Partial<Record<TaskStatus, TaskStatus>>> = {
  claim: { queued: 'running' },
  'finish done': { running: 'done', cancel_requested: 'cancelled' },
  'finish blocked': { running: 'blocked', cancel_requested: 'cancelled' },
  'finish cancelled': { running: 'cancelled', cancel_requested: 'cancelled' },
  'finish failed (no attempts left)': { running: 'failed', cancel_requested: 'cancelled' },
  'finish failed (worker crashed)': { running: 'failed', cancel_requested: 'cancelled' },
  'finish failed (attempts left)': { running: 'queued', cancel_requested: 'cancelled' },
  rate_limited: { running: 'queued', cancel_requested: 'cancelled' },
  conflict: { done: 'blocked' },
  cancel: { proposed: 'cancelled', queued: 'cancelled', blocked: 'cancelled', failed: 'cancelled', running: 'cancel_requested' },
  approve: { proposed: 'queued' },
  reject: { proposed: 'cancelled' },
  retry: { blocked: 'queued', failed: 'queued', cancelled: 'queued', done: 'queued' },
  mark_done: { blocked: 'done', failed: 'done' },
  pr_merged: { blocked: 'done', failed: 'done' },
  'recover after restart': { running: 'queued', cancel_requested: 'cancelled' },
  'recover after too many restarts': { running: 'failed', cancel_requested: 'cancelled' },
};

for (const [name, event] of Object.entries(EVENTS)) {
  for (const from of TASK_STATUSES) {
    const to = ALLOWED[name][from];
    test(`${name} from ${from}: ${to ? `-> ${to}` : 'refused'}`, () => {
      assert.equal(nextStatus(from, event, countersOf(name)), to);
      assert.equal(canApply(from, event), to !== undefined);
      assert.equal(fromStatuses(event).includes(from), to !== undefined);
    });
  }
}

test('personEvents: what a person may do in every status', () => {
  const EXPECTED: Record<TaskStatus, PersonEvent[]> = {
    proposed: ['approve', 'reject'],
    queued: ['cancel'],
    running: ['cancel'],
    cancel_requested: [],
    done: ['retry'],
    blocked: ['retry', 'cancel', 'mark_done'],
    failed: ['retry', 'cancel', 'mark_done'],
    cancelled: ['retry'],
  };
  for (const status of TASK_STATUSES) assert.deepEqual(personEvents({ status }), EXPECTED[status], status);
});

test('RULES move a status to the statuses it can reach', () => {
  const reach = (from: TaskStatus) => [...new Set(Object.values(RULES).flatMap((r) => (r[from] ? [r[from]] : [])))].sort();
  assert.deepEqual(reach('proposed'), ['cancelled', 'queued']);
  assert.deepEqual(reach('running'), ['blocked', 'cancel_requested', 'cancelled', 'done', 'failed', 'queued']);
});

test('a finished run after cancel was requested always ends cancelled', () => {
  for (const [name, event] of Object.entries(EVENTS)) {
    if (event.type === 'finish' || event.type === 'rate_limited' || event.type === 'recover') {
      assert.equal(nextStatus('cancel_requested', event, countersOf(name)), 'cancelled', name);
    }
  }
});
