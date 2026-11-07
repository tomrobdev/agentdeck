import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RULES,
  type RuleKey,
  type TaskCounters,
  type TaskEvent,
  type TaskStatus,
  ruleKey,
  transition,
} from '../src/domain/work/lifecycle.ts';
import type { TaskEventType } from '../src/domain/work/history.ts';
import type { Needs } from '../src/domain/work/needs.ts';
import type { TaskState } from '../src/domain/work/task.ts';

interface Case {
  name: string;
  from: TaskStatus;
  event: TaskEvent;
  opts?: { reason?: string | null; needs?: Needs | null };
  task?: { attempts?: number; restarts?: number };
  to: TaskState;
  counters: TaskCounters;
  history: TaskEventType;
}

/** A task's state in `status`, with what it carries there empty. */
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
    name: 'finish:failed',
    from: 'running',
    event: { type: 'finish', outcome: 'failed', retry: false },
    opts: { reason: 'tests fail' },
    to: { status: 'failed', stop_reason: 'tests fail' },
    counters: {},
    history: 'finish',
  },
  {
    name: 'finish:failed:retry requeues and carries nothing',
    from: 'running',
    event: { type: 'finish', outcome: 'failed', retry: true },
    opts: { reason: 'tests fail' },
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
    to: { status: 'blocked', needs: null, question: null, stop_reason: 'conflicts in a.ts' },
    counters: {},
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
    name: 'retry allows one more attempt',
    from: 'failed',
    event: { type: 'retry' },
    task: { attempts: 3 },
    to: { status: 'queued' },
    counters: { max_attempts: 4 },
    history: 'retry',
  },
  {
    name: 'retry of a done task clears done_by',
    from: 'done',
    event: { type: 'retry' },
    task: { attempts: 1 },
    to: { status: 'queued' },
    counters: { max_attempts: 2 },
    history: 'retry',
  },
  {
    name: 'unblock_retry queues a blocked task without touching its attempts',
    from: 'blocked',
    event: { type: 'unblock_retry' },
    opts: { reason: 'Unblock run: use sqlite' },
    task: { attempts: 1 },
    to: { status: 'queued' },
    counters: {},
    history: 'unblock_retry',
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
    event: { type: 'recover', exhausted: false },
    task: { attempts: 2, restarts: 1 },
    to: { status: 'queued' },
    counters: { restarts: 2, attempts: 1 },
    history: 'recover',
  },
  {
    name: 'recover:exhausted fails the task with the reason',
    from: 'running',
    event: { type: 'recover', exhausted: true },
    opts: { reason: 'restarted 3 times' },
    task: { attempts: 2, restarts: 2 },
    to: { status: 'failed', stop_reason: 'restarted 3 times' },
    counters: { restarts: 3 },
    history: 'recover',
  },
  // The cancel wins: a run that ends after cancel_requested leaves the task cancelled and changes nothing else.
  ...(
    [
      ['finish:done', { type: 'finish', outcome: 'done' }],
      ['finish:blocked', { type: 'finish', outcome: 'blocked', environment: true }],
      ['finish:cancelled', { type: 'finish', outcome: 'cancelled' }],
      ['finish:failed', { type: 'finish', outcome: 'failed', retry: false }],
      ['finish:failed:retry', { type: 'finish', outcome: 'failed', retry: true }],
      ['rate_limited', { type: 'rate_limited' }],
      ['recover', { type: 'recover', exhausted: false }],
      ['recover:exhausted', { type: 'recover', exhausted: true }],
    ] as [string, TaskEvent][]
  ).map(([name, event]): Case => ({
    name: `${name} from cancel_requested: the cancel wins`,
    from: 'cancel_requested',
    event,
    opts: { reason: 'r', needs: { kind: 'host', items: ['n'] } },
    task: { attempts: 2, restarts: 1 },
    to: { status: 'cancelled', stop_reason: null },
    counters: {},
    history: event.type === 'finish' && event.outcome === 'blocked' && event.environment ? 'environment_block' : event.type,
  })),
];

for (const c of CASES) {
  test(`transition: ${c.name}`, () => {
    const t = transition({ ...stateIn(c.from), attempts: 0, restarts: 0, ...c.task }, c.event, c.opts);
    assert.deepEqual(t, { state: c.to, counters: c.counters, history: c.history });
  });
}

test('transition: every rule key has a case', () => {
  const covered = new Set(CASES.map((c) => ruleKey(c.event)));
  for (const key of Object.keys(RULES) as RuleKey[]) assert.ok(covered.has(key), `no case for ${key}`);
});

test('transition: null where the event is refused', () => {
  assert.equal(transition({ ...stateIn('done'), attempts: 1, restarts: 0 }, { type: 'claim' }), null);
  assert.equal(transition({ ...stateIn('cancelled'), attempts: 1, restarts: 0 }, { type: 'mark_done' }), null);
});

test('transition: a cancel keeps the stop reason of the block or failure it ended, and drops the needs and the question', () => {
  const blocked: TaskState = {
    status: 'blocked',
    stop_reason: 'no network',
    needs: { kind: 'host', items: ['x'] },
    question: { question: 'Which?', options: [] },
  };
  assert.deepEqual(transition({ ...blocked, attempts: 1, restarts: 0 }, { type: 'cancel' })?.state, {
    status: 'cancelled',
    stop_reason: 'no network',
  });
  assert.deepEqual(transition({ status: 'failed', stop_reason: 'tests fail', attempts: 1, restarts: 0 }, { type: 'cancel' })?.state, {
    status: 'cancelled',
    stop_reason: 'tests fail',
  });
});
