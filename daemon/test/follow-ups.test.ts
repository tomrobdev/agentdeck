// The follow-up table (domain/work/follow-ups.ts), pinned against what settling did before it: for every entry in RULES.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '../src/domain/shared/id.ts';
import { FOLLOW_UPS, type FollowUp, followUpsOf } from '../src/domain/work/follow-ups.ts';
import { linkState } from '../src/domain/work/link.ts';
import { DOMAIN_EVENT_TYPES, RULES, type RuleKey, type TaskEvent, type TaskStatus, transition } from '../src/domain/work/lifecycle.ts';
import type { TaskState } from '../src/domain/work/task.ts';

const id = asTaskId(4);

const EVENT_OF: Record<RuleKey, TaskEvent> = {
  claim: { type: 'claim' },
  'finish:done': { type: 'finish', outcome: 'done' },
  'finish:blocked': { type: 'finish', outcome: 'blocked' },
  'finish:cancelled': { type: 'finish', outcome: 'cancelled' },
  'finish:failed': { type: 'finish', outcome: 'failed', retry: false },
  'finish:failed:retry': { type: 'finish', outcome: 'failed', retry: true },
  rate_limited: { type: 'rate_limited' },
  conflict: { type: 'conflict' },
  cancel: { type: 'cancel' },
  approve: { type: 'approve' },
  reject: { type: 'reject' },
  retry: { type: 'retry' },
  unblock_retry: { type: 'unblock_retry' },
  mark_done: { type: 'mark_done' },
  pr_merged: { type: 'pr_merged' },
  recover: { type: 'recover', exhausted: false },
  'recover:exhausted': { type: 'recover', exhausted: true },
};

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

/** What the daemon runs now: the table's follow-ups of the move's events; crash recovery runs the failed ones only. */
function now(key: RuleKey, from: TaskStatus): FollowUp[] {
  const t = transition({ ...stateIn(from), id, attempts: 1, restarts: 0 }, EVENT_OF[key])!;
  if (key === 'recover' || key === 'recover:exhausted') return t.state.status === 'failed' ? FOLLOW_UPS.TaskFailed : [];
  return followUpsOf(t.events);
}

test('follow-ups: every entry in RULES is followed up as before, less the warnings that found no one', () => {
  for (const [key, rule] of Object.entries(RULES) as [RuleKey, Partial<Record<TaskStatus, TaskStatus>>][]) {
    for (const [from, to] of Object.entries(rule) as [TaskStatus, TaskStatus][]) {
      const expected = before(key, to).filter((f) => !(f === 'warn_dependents' && warnsNoOne(to)));
      assert.deepEqual(now(key, from), expected, `${key} from ${from}`);
    }
  }
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
      const t = transition({ ...stateIn(from), id, attempts: 1, restarts: 0 }, EVENT_OF[key])!;
      if (t.events[0].by !== 'person') continue;
      const f = followUpsOf(t.events);
      assert.ok(!f.includes('notify') && !f.includes('open_pr'), `${key} from ${from}`);
      if ((key === 'cancel' && from !== 'running') || key === 'reject') assert.deepEqual(f, ['warn_dependents'], `${key} from ${from}`);
      if (key === 'mark_done') assert.deepEqual(f, [], 'mark_done warns no one');
    }
  }
});

test('follow-ups: every domain event has a row, and followUpsOf runs each once, the PR first', () => {
  assert.deepEqual(Object.keys(FOLLOW_UPS).sort(), [...DOMAIN_EVENT_TYPES].sort());
  assert.deepEqual(followUpsOf([{ type: 'TaskCancelled' }, { type: 'TaskFinished' }, { type: 'TaskBlocked' }]), [
    'open_pr',
    'warn_dependents',
    'notify',
  ]);
  assert.deepEqual(followUpsOf([]), []);
});
