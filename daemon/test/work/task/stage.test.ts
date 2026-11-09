// A task's stage (domain/work/stage.ts) as tables: stageOf's fields, then what each predicate and statusGroup say for
// each status, pull request state and wait. Plain values, no database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STATUS_GROUPS,
  TASK_STATUSES,
  canStartMerge,
  hasOpenPr,
  isMerged,
  isReview,
  isStuck,
  isWaiting,
  stageOf,
  statusGroup,
} from '../../../src/domain/work/index.ts';
import type { TaskStatus, Waiting } from '../../../src/domain/work/index.ts';
import type { PrState } from '../../../src/domain/landing/index.ts';
import { asTaskId } from '../../fixtures/fixtures.ts';

const ON_ITS_WAY: Waiting = { on: [asTaskId(1)], stuck: null };
const STUCK: Waiting = { on: [asTaskId(1)], stuck: '#1 was cancelled' };
const PR_STATES: (PrState | null)[] = [null, 'open', 'merged', 'closed', 'failed'];
const WAITS: (Waiting | null | undefined)[] = [undefined, null, ON_ITS_WAY, STUCK];

test('stageOf takes the status, the pull request state, the wait and the PR retry, and nothing else', () => {
  const rows: [Parameters<typeof stageOf>[0], ReturnType<typeof stageOf>][] = [
    [
      { status: 'queued', pr: null },
      { status: 'queued', pr_state: null, waiting: undefined, pr_retry: undefined },
    ],
    [
      { status: 'queued', pr: null, waiting: null },
      { status: 'queued', pr_state: null, waiting: null, pr_retry: undefined },
    ],
    [
      { status: 'queued', pr: null, waiting: STUCK },
      { status: 'queued', pr_state: null, waiting: STUCK, pr_retry: undefined },
    ],
    [
      { status: 'done', pr: { state: 'open' } },
      { status: 'done', pr_state: 'open', waiting: undefined, pr_retry: undefined },
    ],
    [
      { status: 'done', pr: { state: 'merged' } },
      { status: 'done', pr_state: 'merged', waiting: undefined, pr_retry: undefined },
    ],
    [
      { status: 'blocked', pr: { state: 'failed' } },
      { status: 'blocked', pr_state: 'failed', waiting: undefined, pr_retry: undefined },
    ],
    [
      { status: 'done', pr: { state: 'failed' }, pr_retry: { state: 'wait' } },
      { status: 'done', pr_state: 'failed', waiting: undefined, pr_retry: { state: 'wait' } },
    ],
  ];
  for (const [task, stage] of rows) assert.deepEqual(stageOf(task), stage, JSON.stringify(task));
  const extra = { status: 'done' as const, pr: { state: 'open' as const, url: 'https://x/pull/1' }, title: 'kept out' };
  assert.deepEqual(Object.keys(stageOf(extra)).sort(), ['pr_retry', 'pr_state', 'status', 'waiting']);
});

test('isWaiting and isStuck: only a queued task waits, on its way or stuck, never both', () => {
  // [status, waiting, isWaiting, isStuck]
  const rows: [TaskStatus, Waiting | null | undefined, boolean, boolean][] = [
    ['queued', undefined, false, false],
    ['queued', null, false, false],
    ['queued', ON_ITS_WAY, true, false],
    ['queued', { on: [], stuck: null }, true, false],
    ['queued', STUCK, false, true],
    ['proposed', ON_ITS_WAY, false, false],
    ['proposed', STUCK, false, false],
    ['running', ON_ITS_WAY, false, false],
    ['running', STUCK, false, false],
    ['blocked', STUCK, false, false],
    ['done', STUCK, false, false],
    ['cancelled', ON_ITS_WAY, false, false],
  ];
  for (const [status, waiting, waits, stuck] of rows) {
    const label = `${status} ${JSON.stringify(waiting)}`;
    assert.equal(isWaiting({ status, waiting }), waits, `isWaiting: ${label}`);
    assert.equal(isStuck({ status, waiting }), stuck, `isStuck: ${label}`);
  }
  for (const status of TASK_STATUSES)
    for (const waiting of WAITS) assert.ok(!(isWaiting({ status, waiting }) && isStuck({ status, waiting })), `${status}: both`);
});

test('the pull request predicates: open is review only when done, merged is history only when done', () => {
  // [status, pr_state, hasOpenPr, isReview, isMerged]
  const rows: [TaskStatus, PrState | null, boolean, boolean, boolean][] = [
    ['done', 'open', true, true, false],
    ['done', 'merged', false, false, true],
    ['done', 'closed', false, false, false],
    ['done', 'failed', false, false, false],
    ['done', null, false, false, false],
    ['blocked', 'open', true, false, false],
    ['queued', 'open', true, false, false],
    ['running', 'merged', false, false, false],
  ];
  for (const [status, pr_state, open, review, merged] of rows) {
    const label = `${status} ${pr_state}`;
    assert.equal(hasOpenPr({ pr_state }), open, `hasOpenPr: ${label}`);
    assert.equal(isReview({ status, pr_state }), review, `isReview: ${label}`);
    assert.equal(isMerged({ status, pr_state }), merged, `isMerged: ${label}`);
  }
});

test('canStartMerge: a task in review, not syncing and with no merge request waiting', () => {
  const review = { status: 'done' as const, pr_state: 'open' as const };
  assert.equal(canStartMerge(review), true);
  assert.equal(canStartMerge({ ...review, sync: null, merge_request: null }), true);
  assert.equal(canStartMerge({ ...review, sync: { phase: 'merging' } }), false);
  assert.equal(canStartMerge({ ...review, merge_request: { requested_at: 'now' } }), false);
  assert.equal(canStartMerge({ status: 'done', pr_state: 'merged' }), false);
  assert.equal(canStartMerge({ status: 'blocked', pr_state: 'open' }), false);
});

test('statusGroup: each status, pull request state and wait lands in the group the table says', () => {
  // [status, pr_state, waiting, group]
  const rows: [TaskStatus, PrState | null, Waiting | null | undefined, string][] = [
    ['proposed', null, undefined, 'proposed'],
    ['queued', null, undefined, 'queued'],
    ['queued', null, ON_ITS_WAY, 'queued'],
    ['queued', null, STUCK, 'needs-you'],
    ['queued', 'open', undefined, 'queued'],
    ['running', null, undefined, 'running'],
    ['cancel_requested', null, undefined, 'running'],
    ['blocked', null, undefined, 'needs-you'],
    ['blocked', 'open', undefined, 'needs-you'],
    ['failed', 'open', undefined, 'needs-you'],
    ['done', 'open', undefined, 'review'],
    ['done', 'merged', undefined, 'done'],
    ['done', 'closed', undefined, 'done'],
    ['done', 'failed', undefined, 'done'],
    ['done', null, undefined, 'done'],
    ['cancelled', null, undefined, 'cancelled'],
    ['cancelled', 'closed', undefined, 'cancelled'],
  ];
  for (const [status, pr_state, waiting, group] of rows)
    assert.equal(statusGroup({ status, pr_state, waiting }), group, `${status} ${pr_state} ${JSON.stringify(waiting)}`);
});

test('every status, pull request state and wait is in exactly one of the status groups', () => {
  const keys = STATUS_GROUPS.map((g) => g.key) as string[];
  for (const status of TASK_STATUSES)
    for (const pr_state of PR_STATES)
      for (const waiting of WAITS) {
        const group = statusGroup({ status, pr_state, waiting });
        assert.ok(keys.includes(group), `${status} ${pr_state} ${JSON.stringify(waiting)}: ${group} is not a group`);
        assert.equal(group === 'needs-you' && status === 'queued', isStuck({ status, waiting }), 'a queued task needs you only when stuck');
      }
});
