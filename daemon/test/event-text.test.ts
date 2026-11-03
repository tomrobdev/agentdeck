import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeEvent } from '../src/domain/task/event-text.ts';
import type { TaskEventRow } from '../src/domain/task/history.ts';

const person = (type: string, to_status: string | null = null, reason: string | null = null) =>
  describeEvent({ type, to_status, reason } as Pick<TaskEventRow, 'type' | 'to_status' | 'reason'>, 'person');

test('the person variant words a sync as a sync', () => {
  assert.deepEqual(person('sync'), { text: 'synced with the base branch' });
  // The reason is the sentence for a sync, so it is not shown again beside it.
  assert.deepEqual(person('sync', null, 'synced with main'), { text: 'synced with main' });
  assert.deepEqual(person('conflict', 'blocked', 'CONFLICT in a.ts'), {
    text: "the sync hit conflicts it couldn't settle; blocked",
    reason: 'CONFLICT in a.ts',
  });
});

test('the person variant shows the reason beside the sentence, except where the sentence says it', () => {
  assert.deepEqual(person('retry', 'queued', 'tests failed'), { text: 'requested changes', reason: 'tests failed' });
  assert.deepEqual(person('retry', 'queued'), { text: 'queued another attempt' });
  assert.deepEqual(person('plan_unfinished', null, 'step 2 left'), { text: 'step 2 left' });
  assert.deepEqual(person('pr_merged', 'done', 'PR is merged'), { text: 'PR merged on GitHub' });
  assert.deepEqual(person('pr', null, 'opened https://x/pull/1'), { text: 'pull request opened https://x/pull/1' });
  assert.deepEqual(person('pr', null, 'PR is merged'), { text: 'pull request merged' });
  assert.deepEqual(person('pr'), { text: 'pull request changed' });
});

test('the person variant reads merge reasons', () => {
  assert.deepEqual(person('merge', 'done', 'auto-merged (squash)'), {
    text: 'auto-merged the pull request',
    reason: 'auto-merged (squash)',
  });
  assert.deepEqual(person('merge', 'done', 'requested (squash)'), {
    text: 'merged the pull request as requested',
    reason: 'requested (squash)',
  });
  assert.deepEqual(person('merge', 'done', 'squash merge'), { text: 'merged the pull request', reason: 'squash merge' });
});

test('the person variant leaves out rows the timeline does not show', () => {
  assert.equal(person('claim', 'running'), null);
  assert.equal(person('finish', 'done'), null);
  assert.equal(person('created', 'queued'), null);
});

test('the person variant words cancels and restarts by status', () => {
  assert.deepEqual(person('cancel', 'cancel_requested'), { text: 'asked the run to stop' });
  assert.deepEqual(person('cancel', 'cancelled'), { text: 'cancelled the task' });
  assert.deepEqual(person('recover', 'failed', 'x'), { text: 'failed after repeated daemon restarts', reason: 'x' });
  assert.deepEqual(person('recover', 'queued'), { text: 'requeued after a daemon restart' });
});
