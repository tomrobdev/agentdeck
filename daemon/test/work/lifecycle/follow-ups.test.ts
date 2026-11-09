// The follow-up table (domain/work/lifecycle/follow-ups.ts), pinned against what settling did before it: for every entry in RULES.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '../../../src/domain/shared/id.ts';
import { FOLLOW_UPS, type FollowUp, followUpsOf, followUpsOfRow } from '../../../src/domain/work/lifecycle/follow-ups.ts';
import { linkState } from '../../../src/domain/work/links/link.ts';
import {
  DOMAIN_EVENT_TYPES,
  MAX_RESTARTS,
  RULES,
  type RuleKey,
  type TaskEvent,
  type TaskStatus,
  domainEventOfRow,
  transition,
} from '../../../src/domain/work/lifecycle/lifecycle.ts';
import type { TaskState } from '../../../src/domain/work/task/task.ts';

const id = asTaskId(4);

const EVENT_OF: Record<RuleKey, TaskEvent> = {
  claim: { type: 'claim' },
  'finish:done': { type: 'finish', outcome: 'done' },
  'finish:blocked': { type: 'finish', outcome: 'blocked' },
  'finish:cancelled': { type: 'finish', outcome: 'cancelled' },
  'finish:failed': { type: 'finish', outcome: 'failed' },
  'finish:failed:retry': { type: 'finish', outcome: 'failed' },
  rate_limited: { type: 'rate_limited' },
  conflict: { type: 'conflict' },
  cancel: { type: 'cancel' },
  approve: { type: 'approve' },
  reject: { type: 'reject' },
  retry: { type: 'retry' },
  unblock_retry: { type: 'unblock_retry' },
  review_retry: { type: 'review_retry' },
  mark_done: { type: 'mark_done' },
  pr_merged: { type: 'pr_merged' },
  recover: { type: 'recover' },
  'recover:exhausted': { type: 'recover' },
};

/** A task in `from`, ready for rule `key`: one restart short of too many for the last recover. */
const taskFor = (key: RuleKey, from: TaskStatus) => ({
  ...stateIn(from),
  id,
  attempts: 1,
  max_attempts: key === 'finish:failed:retry' ? 2 : 1,
  restarts: key === 'recover:exhausted' ? MAX_RESTARTS - 1 : 0,
  pr: null,
});

const stateIn = (status: TaskStatus): TaskState => {
  switch (status) {
    case 'done':
      return { status, done_by: null };
    case 'blocked':
      return { status, stop_reason: null, needs: null, question: null };
    case 'failed':
    case 'cancelled':
      return { status, stop_reason: null };
    default:
      return { status };
  }
};

/**
 * What followed each move before the table, read off the code it replaced:
 * - the claim (claimNextTask) was followed by nothing;
 * - a person's cancel and reject warned dependents, and approve, retry and mark_done did nothing;
 * - crash recovery followed up only the tasks it failed (settleRecovered), as any daemon event but without a PR;
 * - any other daemon event (settle) opened the PR when the task was done unless its PR had just merged, always warned
 *   dependents, and notified, which sent something only for done, blocked and failed.
 */
function before(key: RuleKey, to: TaskStatus): FollowUp[] {
  if (key === 'claim') return [];
  if (key === 'cancel' || key === 'reject') return ['warn_dependents'];
  if (key === 'approve' || key === 'retry' || key === 'mark_done') return [];
  if ((key === 'recover' || key === 'recover:exhausted') && to !== 'failed') return [];
  const openPr = to === 'done' && key !== 'pr_merged' && key !== 'recover:exhausted';
  const notifies = to === 'done' || to === 'blocked' || to === 'failed';
  return [...(openPr ? ['open_pr' as const] : []), 'warn_dependents', ...(notifies ? ['notify' as const] : [])];
}

/** The statuses whose warning found no one stuck, so the table leaves it out. */
const WARNS_NO_ONE: Exclude<TaskStatus, 'done'>[] = ['queued', 'running', 'cancel_requested'];
const warnsNoOne = (s: TaskStatus) => (WARNS_NO_ONE as TaskStatus[]).includes(s);

/** The rule keys a person asks for; the daemon asks for every other. */
const BY_PERSON: RuleKey[] = ['approve', 'reject', 'retry', 'cancel', 'mark_done'];

/** What the daemon runs now: the table's follow-ups of the move's events, crash recovery's too (the outbox keeps them all). */
function now(key: RuleKey, from: TaskStatus): FollowUp[] {
  return followUpsOf(transition(taskFor(key, from), EVENT_OF[key])!.event);
}

/** Since the outbox, crash recovery's events are followed up like any other: a task it cancelled now warns its dependents. */
const recoveryCancels = (key: RuleKey, to: TaskStatus) => (key === 'recover' || key === 'recover:exhausted') && to === 'cancelled';

test('follow-ups: every entry in RULES is followed up as before, less the warnings that found no one', () => {
  for (const [key, rule] of Object.entries(RULES) as [RuleKey, Partial<Record<TaskStatus, TaskStatus>>][]) {
    for (const [from, to] of Object.entries(rule) as [TaskStatus, TaskStatus][]) {
      const expected = recoveryCancels(key, to)
        ? ['warn_dependents']
        : before(key, to).filter((f) => !(f === 'warn_dependents' && (warnsNoOne(to) || key === 'pr_merged')));
      assert.deepEqual(now(key, from), expected, `${key} from ${from}`);
    }
  }
});

test('follow-ups: a history row reads back as the domain event that wrote it, so the outbox runs the same follow-ups', () => {
  for (const [key, rule] of Object.entries(RULES) as [RuleKey, Partial<Record<TaskStatus, TaskStatus>>][]) {
    for (const from of Object.keys(rule) as TaskStatus[]) {
      const e = transition(taskFor(key, from), EVENT_OF[key])!.event;
      assert.equal(domainEventOfRow({ type: e.history, to_status: e.to }), e.type, `${key} from ${from}`);
      assert.deepEqual(followUpsOfRow({ type: e.history, to_status: e.to }), followUpsOf(e), `${key} from ${from}`);
    }
  }
  const blocked = transition(taskFor('finish:blocked', 'running'), {
    type: 'finish',
    outcome: 'blocked',
    environment: true,
  })!.event;
  assert.equal(blocked.history, 'environment_block');
  assert.equal(domainEventOfRow({ type: blocked.history, to_status: blocked.to }), 'TaskBlocked');
  assert.equal(domainEventOfRow({ type: 'created', to_status: 'proposed' }), null);
  assert.deepEqual(followUpsOfRow({ type: 'created', to_status: 'queued' }), []);
});

test('follow-ups: a task queued, running or asked to stop leaves no one stuck, so warning about it did nothing', () => {
  for (const status of WARNS_NO_ONE) {
    const state = linkState({ on: id, kind: 'builds_on' }, { status, pr: null, pr_mode: 'ready' });
    assert.notEqual(state.kind, 'stuck', status);
  }
});

test("follow-ups: only the daemon's events notify or open a PR, and a person's cancel and reject warn dependents", () => {
  for (const [key, rule] of Object.entries(RULES) as [RuleKey, Partial<Record<TaskStatus, TaskStatus>>][]) {
    for (const from of Object.keys(rule) as TaskStatus[]) {
      if (!BY_PERSON.includes(key)) continue;
      const f = followUpsOf(transition(taskFor(key, from), EVENT_OF[key])!.event);
      assert.ok(!f.includes('notify') && !f.includes('open_pr'), `${key} from ${from}`);
      if ((key === 'cancel' && from !== 'running') || key === 'reject') assert.deepEqual(f, ['warn_dependents'], `${key} from ${from}`);
      if (key === 'mark_done') assert.deepEqual(f, [], 'mark_done warns no one');
    }
  }
});

test('follow-ups: every domain event has a row, and followUpsOf runs each once, the PR first', () => {
  assert.deepEqual(Object.keys(FOLLOW_UPS).sort(), [...DOMAIN_EVENT_TYPES].sort());
  assert.deepEqual(followUpsOf({ type: 'TaskFinished' }), ['open_pr', 'warn_dependents', 'notify']);
  assert.deepEqual(followUpsOf({ type: 'TaskCancelled' }), ['warn_dependents']);
  assert.deepEqual(followUpsOf({ type: 'TaskStarted' }), []);
});
