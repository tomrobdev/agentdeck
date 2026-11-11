import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/id.ts';
import {
  type DomainEvent,
  type DomainEventType,
  MAX_RESTARTS,
  RULES,
  type RuleKey,
  type TaskCounters,
  type TaskEvent,
  type TaskStatus,
  type TransitionTask,
  ruleKey,
  transition,
} from '#domain/work/lifecycle/lifecycle.ts';
import type { PullRequest } from '#domain/landing/pull-request/pr.ts';
import type { TaskEventType } from '#domain/work/lifecycle/history.ts';
import type { Needs } from '#domain/work/task/needs.ts';
import type { TaskState } from '#domain/work/task/task.ts';
import { type TaskChanges, noMergeRequestChanges } from '#domain/work/lifecycle/task-writes.ts';

const SET_ASIDE: TaskChanges = {
  pr_state: null,
  auto_merge_check: null,
  auto_merge_checked_at: null,
  merge_requested_at: null,
  merge_request_method: null,
  merge_request_check: null,
};

interface Case {
  name: string;
  from: TaskStatus;
  event: TaskEvent;
  opts?: { reason?: string | null; needs?: Needs | null };
  task?: { attempts?: number; max_attempts?: number; restarts?: number; pr?: Pick<PullRequest, 'state'> | null };
  to: TaskState;
  counters: TaskCounters;
  changes?: TaskChanges;
  history: TaskEventType;
}

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

const CASES: Case[] = [
  {
    name: 'claim',
    from: 'queued',
    event: { type: 'claim' },
    task: { attempts: 1 },
    to: { status: 'running' },
    counters: { attempts: 2 },
    history: 'claim',
  },
  {
    name: 'finish:done leaves no stop reason',
    from: 'running',
    event: { type: 'finish', outcome: 'done' },
    to: { status: 'done', done_by: null },
    counters: {},
    history: 'finish',
  },
  {
    name: 'finish:blocked sets the stop reason and needs',
    from: 'running',
    event: { type: 'finish', outcome: 'blocked' },
    opts: { reason: 'no network', needs: { kind: 'host', items: ['x'] } },
    to: { status: 'blocked', needs: { kind: 'host', items: ['x'] }, question: null, stop_reason: 'no network' },
    counters: {},
    history: 'finish',
  },
  {
    name: 'finish:blocked without needs',
    from: 'running',
    event: { type: 'finish', outcome: 'blocked' },
    opts: { reason: 'stuck' },
    to: { status: 'blocked', needs: null, question: null, stop_reason: 'stuck' },
    counters: {},
    history: 'finish',
  },
  {
    name: 'finish:blocked by the environment gives the attempt back',
    from: 'running',
    event: { type: 'finish', outcome: 'blocked', environment: true },
    opts: { reason: 'no git' },
    task: { attempts: 2 },
    to: { status: 'blocked', needs: null, question: null, stop_reason: 'no git' },
    counters: { attempts: 1 },
    history: 'environment_block',
  },
  {
    name: 'finish:cancelled',
    from: 'running',
    event: { type: 'finish', outcome: 'cancelled' },
    to: { status: 'cancelled', stop_reason: null },
    counters: {},
    history: 'finish',
  },
  {
    name: 'finish:failed with no attempts left fails the task',
    from: 'running',
    event: { type: 'finish', outcome: 'failed' },
    opts: { reason: 'tests fail' },
    task: { attempts: 3, max_attempts: 3 },
    to: { status: 'failed', stop_reason: 'tests fail' },
    counters: {},
    history: 'finish',
  },
  {
    name: 'finish:failed with retry false (the worker crashed) fails the task though attempts are left',
    from: 'running',
    event: { type: 'finish', outcome: 'failed', retry: false },
    opts: { reason: 'worker crashed' },
    task: { attempts: 1, max_attempts: 3 },
    to: { status: 'failed', stop_reason: 'worker crashed' },
    counters: {},
    history: 'finish',
  },
  {
    name: 'finish:failed:retry requeues while attempts are left and carries nothing',
    from: 'running',
    event: { type: 'finish', outcome: 'failed' },
    opts: { reason: 'tests fail' },
    task: { attempts: 2, max_attempts: 3 },
    to: { status: 'queued' },
    counters: {},
    history: 'finish',
  },
  {
    name: 'rate_limited gives the attempt back',
    from: 'running',
    event: { type: 'rate_limited' },
    task: { attempts: 1 },
    to: { status: 'queued' },
    counters: { attempts: 0 },
    history: 'rate_limited',
  },
  {
    name: 'rate_limited never takes attempts below zero',
    from: 'running',
    event: { type: 'rate_limited' },
    task: { attempts: 0 },
    to: { status: 'queued' },
    counters: { attempts: 0 },
    history: 'rate_limited',
  },
  {
    name: 'conflict blocks a done task and clears done_by',
    from: 'done',
    event: { type: 'conflict' },
    opts: { reason: 'conflicts in a.ts' },
    task: { pr: { state: 'open' } },
    to: { status: 'blocked', needs: null, question: null, stop_reason: 'conflicts in a.ts' },
    counters: {},
    changes: noMergeRequestChanges(),
    history: 'conflict',
  },
  {
    name: 'cancel a queued task',
    from: 'queued',
    event: { type: 'cancel' },
    to: { status: 'cancelled', stop_reason: null },
    counters: {},
    history: 'cancel',
  },
  {
    name: 'cancel a running task',
    from: 'running',
    event: { type: 'cancel' },
    to: { status: 'cancel_requested' },
    counters: {},
    history: 'cancel',
  },
  {
    name: 'approve carries nothing',
    from: 'proposed',
    event: { type: 'approve' },
    to: { status: 'queued' },
    counters: {},
    history: 'approve',
  },
  {
    name: 'reject',
    from: 'proposed',
    event: { type: 'reject' },
    to: { status: 'cancelled', stop_reason: null },
    counters: {},
    history: 'reject',
  },
  {
    name: 'retry allows one more attempt and starts the restarts afresh',
    from: 'failed',
    event: { type: 'retry' },
    task: { attempts: 3, restarts: MAX_RESTARTS },
    to: { status: 'queued' },
    counters: { max_attempts: 4, restarts: 0 },
    history: 'retry',
  },
  {
    name: 'retry of a done task clears done_by and drops the merge request, keeping its open PR',
    from: 'done',
    event: { type: 'retry' },
    task: { attempts: 1, pr: { state: 'open' } },
    to: { status: 'queued' },
    counters: { max_attempts: 2, restarts: 0 },
    changes: noMergeRequestChanges(),
    history: 'retry',
  },
  {
    name: 'retry of a done task whose PR merged sets the PR aside',
    from: 'done',
    event: { type: 'retry' },
    task: { attempts: 1, pr: { state: 'merged' } },
    to: { status: 'queued' },
    counters: { max_attempts: 2, restarts: 0 },
    changes: SET_ASIDE,
    history: 'retry',
  },
  {
    name: 'retry of a done task with no PR changes none',
    from: 'done',
    event: { type: 'retry' },
    task: { attempts: 1, pr: null },
    to: { status: 'queued' },
    counters: { max_attempts: 2, restarts: 0 },
    changes: noMergeRequestChanges(),
    history: 'retry',
  },
  {
    name: 'retry of a failed task whose PR was closed sets the PR aside',
    from: 'failed',
    event: { type: 'retry' },
    task: { attempts: 1, pr: { state: 'closed' } },
    to: { status: 'queued' },
    counters: { max_attempts: 2, restarts: 0 },
    changes: SET_ASIDE,
    history: 'retry',
  },
  {
    name: 'retry of a blocked task keeps its open PR',
    from: 'blocked',
    event: { type: 'retry' },
    task: { attempts: 1, pr: { state: 'open' } },
    to: { status: 'queued' },
    counters: { max_attempts: 2, restarts: 0 },
    history: 'retry',
  },
  {
    name: 'unblock_retry queues a blocked task without touching its attempts, and starts the restarts afresh',
    from: 'blocked',
    event: { type: 'unblock_retry' },
    opts: { reason: 'Unblock run: use sqlite' },
    task: { attempts: 1, restarts: 2 },
    to: { status: 'queued' },
    counters: { restarts: 0 },
    history: 'unblock_retry',
  },
  {
    name: 'unblock_retry sets aside a PR that failed to open',
    from: 'blocked',
    event: { type: 'unblock_retry' },
    task: { attempts: 1, pr: { state: 'failed' } },
    to: { status: 'queued' },
    counters: { restarts: 0 },
    changes: SET_ASIDE,
    history: 'unblock_retry',
  },
  {
    name: 'review_retry queues a done task with one attempt more, as a person’s retry does',
    from: 'done',
    event: { type: 'review_retry' },
    opts: { reason: 'Review run: handle the empty list' },
    task: { attempts: 2, restarts: 1, pr: { state: 'open' } },
    to: { status: 'queued' },
    counters: { max_attempts: 3, restarts: 0 },
    changes: noMergeRequestChanges(),
    history: 'review_retry',
  },
  {
    name: 'mark_done',
    from: 'blocked',
    event: { type: 'mark_done' },
    to: { status: 'done', done_by: 'person' },
    counters: {},
    history: 'mark_done',
  },
  {
    name: 'pr_merged',
    from: 'failed',
    event: { type: 'pr_merged' },
    to: { status: 'done', done_by: null },
    counters: {},
    history: 'pr_merged',
  },
  {
    name: 'recover requeues, counts the restart and gives the attempt back',
    from: 'running',
    event: { type: 'recover' },
    task: { attempts: 2, restarts: 1 },
    to: { status: 'queued' },
    counters: { restarts: 2, attempts: 1 },
    history: 'recover',
  },
  {
    name: 'recover:exhausted with restarts at MAX_RESTARTS - 1 fails the task with the reason',
    from: 'running',
    event: { type: 'recover' },
    opts: { reason: 'restarted 3 times' },
    task: { attempts: 2, restarts: MAX_RESTARTS - 1 },
    to: { status: 'failed', stop_reason: 'restarted 3 times' },
    counters: { restarts: MAX_RESTARTS },
    history: 'recover',
  },
  ...(
    [
      ['finish:done', { type: 'finish', outcome: 'done' }],
      ['finish:blocked', { type: 'finish', outcome: 'blocked', environment: true }],
      ['finish:cancelled', { type: 'finish', outcome: 'cancelled' }],
      ['finish:failed', { type: 'finish', outcome: 'failed' }],
      ['finish:failed:retry', { type: 'finish', outcome: 'failed' }],
      ['rate_limited', { type: 'rate_limited' }],
      ['recover', { type: 'recover' }],
      ['recover:exhausted', { type: 'recover' }],
    ] as [string, TaskEvent][]
  ).map(([name, event]): Case => ({
    name: `${name} from cancel_requested: the cancel wins`,
    from: 'cancel_requested',
    event,
    opts: { reason: 'r', needs: { kind: 'host', items: ['n'] } },
    task: {
      attempts: 2,
      max_attempts: name === 'finish:failed:retry' ? 3 : 2,
      restarts: name === 'recover:exhausted' ? MAX_RESTARTS - 1 : 1,
    },
    to: { status: 'cancelled', stop_reason: null },
    counters: {},
    history: event.type === 'finish' && event.outcome === 'blocked' && event.environment ? 'environment_block' : event.type,
  })),
];

const id = asTaskId(7);

for (const c of CASES) {
  test(`transition: ${c.name}`, () => {
    const t = transition({ ...stateIn(c.from), id, attempts: 0, max_attempts: 0, restarts: 0, pr: null, ...c.task }, c.event, c.opts);
    assert.ok(t);
    const { event, ...rest } = t;
    assert.deepEqual(rest, { state: c.to, counters: c.counters, changes: c.changes ?? {} });
    assert.deepEqual([event.history, event.from, event.to, event.reason], [c.history, c.from, c.to.status, c.opts?.reason ?? null]);
  });
}

test('transition: every rule key has a case', () => {
  const covered = new Set(CASES.map((c) => ruleKey(c.event, c.task ?? {})));
  for (const key of Object.keys(RULES) as RuleKey[]) assert.ok(covered.has(key), `no case for ${key}`);
});

test('transition: a failed run is requeued while the task has attempts left, unless the worker crashed', () => {
  const table: [attempts: number, max_attempts: number, event: TaskEvent, to: TaskStatus][] = [
    [1, 3, { type: 'finish', outcome: 'failed' }, 'queued'],
    [2, 3, { type: 'finish', outcome: 'failed' }, 'queued'],
    [3, 3, { type: 'finish', outcome: 'failed' }, 'failed'],
    [4, 3, { type: 'finish', outcome: 'failed' }, 'failed'],
    [1, 3, { type: 'finish', outcome: 'failed', retry: false }, 'failed'],
  ];
  for (const [attempts, max_attempts, event, to] of table) {
    const t = transition({ status: 'running', id, attempts, max_attempts, restarts: 0, pr: null }, event);
    assert.equal(t?.state.status, to, `attempt ${attempts} of ${max_attempts}${'retry' in event ? ', worker crashed' : ''}`);
    assert.equal(t?.event.type, to === 'queued' ? 'TaskQueued' : 'TaskFailed');
  }
});

test('transition: a retried task gets MAX_RESTARTS restarts again', () => {
  let task: TransitionTask = {
    status: 'failed',
    stop_reason: 'restarts',
    id,
    attempts: 1,
    max_attempts: 1,
    restarts: MAX_RESTARTS,
    pr: null,
  };
  const step = (event: TaskEvent): TaskStatus => {
    const t = transition(task, event)!;
    task = { ...task, ...t.state, ...t.counters } as TransitionTask;
    return t.state.status;
  };
  assert.equal(step({ type: 'retry' }), 'queued');
  assert.equal(task.restarts, 0);
  const statuses: TaskStatus[] = [];
  for (let i = 0; i < MAX_RESTARTS; i++) {
    step({ type: 'claim' });
    statuses.push(step({ type: 'recover' }));
  }
  assert.deepEqual(statuses, [...Array(MAX_RESTARTS - 1).fill('queued'), 'failed'], 'the restart limit counts from the retry');
});

test('transition: leaving done drops the merge request, whatever the PR', () => {
  for (const state of ['open', 'merged', 'closed', 'failed'] as const)
    for (const event of [{ type: 'retry' }, { type: 'conflict' }] as TaskEvent[]) {
      const t = transition({ status: 'done', done_by: null, id, attempts: 1, max_attempts: 1, restarts: 0, pr: { state } }, event);
      if (!t) continue;
      assert.equal(t.changes.merge_requested_at, null, `${event.type} with the PR ${state}`);
      assert.equal(t.changes.merge_request_method, null, `${event.type} with the PR ${state}`);
    }
});

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

const countersFor = (key: RuleKey) => ({
  attempts: 1,
  max_attempts: key === 'finish:failed:retry' ? 2 : 1,
  restarts: key === 'recover:exhausted' ? MAX_RESTARTS - 1 : 0,
});

const EVENTS: Record<RuleKey, Partial<Record<TaskStatus, DomainEventType>>> = {
  claim: { queued: 'TaskStarted' },
  'finish:done': { running: 'TaskFinished', cancel_requested: 'TaskCancelled' },
  'finish:blocked': { running: 'TaskBlocked', cancel_requested: 'TaskCancelled' },
  'finish:cancelled': { running: 'TaskCancelled', cancel_requested: 'TaskCancelled' },
  'finish:failed': { running: 'TaskFailed', cancel_requested: 'TaskCancelled' },
  'finish:failed:retry': { running: 'TaskQueued', cancel_requested: 'TaskCancelled' },
  rate_limited: { running: 'TaskQueued', cancel_requested: 'TaskCancelled' },
  conflict: { done: 'TaskBlocked' },
  cancel: {
    proposed: 'TaskCancelled',
    queued: 'TaskCancelled',
    blocked: 'TaskCancelled',
    failed: 'TaskCancelled',
    running: 'TaskCancelRequested',
  },
  approve: { proposed: 'TaskQueued' },
  reject: { proposed: 'TaskCancelled' },
  retry: { blocked: 'TaskQueued', failed: 'TaskQueued', cancelled: 'TaskQueued', done: 'TaskQueued' },
  unblock_retry: { blocked: 'TaskQueued' },
  review_retry: { done: 'TaskQueued' },
  mark_done: { blocked: 'TaskMarkedDone', failed: 'TaskMarkedDone' },
  pr_merged: { blocked: 'TaskPrMerged', failed: 'TaskPrMerged' },
  recover: { running: 'TaskQueued', cancel_requested: 'TaskCancelled' },
  'recover:exhausted': { running: 'TaskFailed', cancel_requested: 'TaskCancelled' },
};

test('transition: the domain events of every entry in RULES', () => {
  for (const [key, rule] of Object.entries(RULES) as [RuleKey, Partial<Record<TaskStatus, TaskStatus>>][]) {
    assert.deepEqual(Object.keys(EVENTS[key]).sort(), Object.keys(rule).sort(), `EVENTS lists each move of ${key}`);
    for (const [from, to] of Object.entries(rule) as [TaskStatus, TaskStatus][]) {
      const t = transition({ ...stateIn(from), id, ...countersFor(key), pr: null }, EVENT_OF[key], { reason: 'why' });
      const expected: DomainEvent = {
        type: EVENTS[key][from]!,
        task_id: id,
        from,
        to,
        history: EVENT_OF[key].type,
        reason: 'why',
      };
      assert.deepEqual(t?.event, expected, `${key} from ${from}`);
    }
  }
});

test('transition: null where the event is refused', () => {
  assert.equal(transition({ ...stateIn('done'), id, attempts: 1, max_attempts: 1, restarts: 0, pr: null }, { type: 'claim' }), null);
  assert.equal(
    transition({ ...stateIn('cancelled'), id, attempts: 1, max_attempts: 1, restarts: 0, pr: null }, { type: 'mark_done' }),
    null,
  );
});

test('transition: a cancel keeps the stop reason of the block or failure it ended, and drops the needs and the question', () => {
  const blocked: TaskState = {
    status: 'blocked',
    stop_reason: 'no network',
    needs: { kind: 'host', items: ['x'] },
    question: { question: 'Which?', options: [] },
  };
  assert.deepEqual(transition({ ...blocked, id, attempts: 1, max_attempts: 1, restarts: 0, pr: null }, { type: 'cancel' })?.state, {
    status: 'cancelled',
    stop_reason: 'no network',
  });
  assert.deepEqual(
    transition({ status: 'failed', stop_reason: 'tests fail', id, attempts: 1, max_attempts: 1, restarts: 0, pr: null }, { type: 'cancel' })
      ?.state,
    {
      status: 'cancelled',
      stop_reason: 'tests fail',
    },
  );
});
