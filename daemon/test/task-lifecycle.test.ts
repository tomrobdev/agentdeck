import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type TaskEvent,
  type PersonEvent,
  type TaskStatus,
  TASK_STATUSES,
  TRANSITIONS,
  canApply,
  fromStatuses,
  nextStatus,
  personEvents,
} from '../src/domain/task/lifecycle.ts';

const EVENTS: Record<string, TaskEvent> = {
  claim: { type: 'claim' },
  'finish done': { type: 'finish', outcome: 'done' },
  'finish blocked': { type: 'finish', outcome: 'blocked' },
  'finish cancelled': { type: 'finish', outcome: 'cancelled' },
  'finish failed (no retry)': { type: 'finish', outcome: 'failed', retry: false },
  'finish failed (retry)': { type: 'finish', outcome: 'failed', retry: true },
  rate_limited: { type: 'rate_limited' },
  conflict: { type: 'conflict' },
  cancel: { type: 'cancel' },
  approve: { type: 'approve' },
  reject: { type: 'reject' },
  retry: { type: 'retry' },
  mark_done: { type: 'mark_done' },
  pr_merged: { type: 'pr_merged' },
  'recover after restart': { type: 'recover', exhausted: false },
  'recover after too many restarts': { type: 'recover', exhausted: true },
};

// event → status it is allowed from → status it leads to. Anything not listed must be refused.
const ALLOWED: Record<string, Partial<Record<TaskStatus, TaskStatus>>> = {
  claim: { queued: 'running' },
  'finish done': { running: 'done', cancel_requested: 'cancelled' },
  'finish blocked': { running: 'blocked', cancel_requested: 'cancelled' },
  'finish cancelled': { running: 'cancelled', cancel_requested: 'cancelled' },
  'finish failed (no retry)': { running: 'failed', cancel_requested: 'cancelled' },
  'finish failed (retry)': { running: 'queued', cancel_requested: 'cancelled' },
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
      assert.equal(nextStatus(from, event), to);
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

test('TRANSITIONS lists the statuses each status can move to', () => {
  assert.deepEqual([...TRANSITIONS.proposed].sort(), ['cancelled', 'queued']);
  assert.deepEqual([...TRANSITIONS.running].sort(), ['blocked', 'cancel_requested', 'cancelled', 'done', 'failed', 'queued']);
});

test('a finished run after cancel was requested always ends cancelled', () => {
  for (const [name, event] of Object.entries(EVENTS)) {
    if (event.type === 'finish' || event.type === 'rate_limited' || event.type === 'recover') {
      assert.equal(nextStatus('cancel_requested', event), 'cancelled', name);
    }
  }
});
