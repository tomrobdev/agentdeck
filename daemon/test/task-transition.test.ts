import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RULES,
  type RuleKey,
  type TaskChanges,
  type TaskEvent,
  type TaskStatus,
  ruleKey,
  transition,
} from '../src/domain/task/lifecycle.ts';
import type { TaskEventType } from '../src/domain/task/history.ts';

interface Case {
  name: string;
  from: TaskStatus;
  event: TaskEvent;
  opts?: { reason?: string | null; needs?: string | null };
  task?: { attempts?: number; restarts?: number };
  to: TaskStatus;
  changes: TaskChanges;
  history: TaskEventType;
}

const CASES: Case[] = [
  {
    name: 'claim',
    from: 'queued',
    event: { type: 'claim' },
    task: { attempts: 1 },
    to: 'running',
    changes: { attempts: 2 },
    history: 'claim',
  },
  {
    name: 'finish:done clears the stop reason',
    from: 'running',
    event: { type: 'finish', outcome: 'done' },
    to: 'done',
    changes: { stop_reason: null },
    history: 'finish',
  },
  {
    name: 'finish:blocked sets the stop reason and needs',
    from: 'running',
    event: { type: 'finish', outcome: 'blocked' },
    opts: { reason: 'no network', needs: 'host: x' },
    to: 'blocked',
    changes: { needs: 'host: x', question: null, stop_reason: 'no network' },
    history: 'finish',
  },
  {
    name: 'finish:blocked without needs',
    from: 'running',
    event: { type: 'finish', outcome: 'blocked' },
    opts: { reason: 'stuck' },
    to: 'blocked',
    changes: { needs: null, question: null, stop_reason: 'stuck' },
    history: 'finish',
  },
  {
    name: 'finish:blocked by the environment gives the attempt back',
    from: 'running',
    event: { type: 'finish', outcome: 'blocked', environment: true },
    opts: { reason: 'no git' },
    task: { attempts: 2 },
    to: 'blocked',
    changes: { attempts: 1, needs: null, question: null, stop_reason: 'no git' },
    history: 'environment_block',
  },
  {
    name: 'finish:cancelled',
    from: 'running',
    event: { type: 'finish', outcome: 'cancelled' },
    to: 'cancelled',
    changes: {},
    history: 'finish',
  },
  {
    name: 'finish:failed',
    from: 'running',
    event: { type: 'finish', outcome: 'failed', retry: false },
    opts: { reason: 'tests fail' },
    to: 'failed',
    changes: { stop_reason: 'tests fail' },
    history: 'finish',
  },
  {
    name: 'finish:failed:retry requeues and clears needs',
    from: 'running',
    event: { type: 'finish', outcome: 'failed', retry: true },
    opts: { reason: 'tests fail' },
    to: 'queued',
    changes: { needs: null, question: null, stop_reason: null },
    history: 'finish',
  },
  {
    name: 'rate_limited gives the attempt back',
    from: 'running',
    event: { type: 'rate_limited' },
    task: { attempts: 1 },
    to: 'queued',
    changes: { attempts: 0, needs: null, stop_reason: null, question: null },
    history: 'rate_limited',
  },
  {
    name: 'rate_limited never takes attempts below zero',
    from: 'running',
    event: { type: 'rate_limited' },
    task: { attempts: 0 },
    to: 'queued',
    changes: { attempts: 0, needs: null, stop_reason: null, question: null },
    history: 'rate_limited',
  },
  {
    name: 'conflict blocks a done task and clears done_by',
    from: 'done',
    event: { type: 'conflict' },
    opts: { reason: 'conflicts in a.ts' },
    to: 'blocked',
    changes: { done_by: null, stop_reason: 'conflicts in a.ts' },
    history: 'conflict',
  },
  { name: 'cancel a queued task', from: 'queued', event: { type: 'cancel' }, to: 'cancelled', changes: {}, history: 'cancel' },
  { name: 'cancel a running task', from: 'running', event: { type: 'cancel' }, to: 'cancel_requested', changes: {}, history: 'cancel' },
  {
    name: 'approve clears needs',
    from: 'proposed',
    event: { type: 'approve' },
    to: 'queued',
    changes: { needs: null, stop_reason: null, question: null },
    history: 'approve',
  },
  { name: 'reject', from: 'proposed', event: { type: 'reject' }, to: 'cancelled', changes: {}, history: 'reject' },
  {
    name: 'retry allows one more attempt',
    from: 'failed',
    event: { type: 'retry' },
    task: { attempts: 3 },
    to: 'queued',
    changes: { max_attempts: 4, needs: null, stop_reason: null, question: null },
    history: 'retry',
  },
  {
    name: 'retry of a done task clears done_by',
    from: 'done',
    event: { type: 'retry' },
    task: { attempts: 1 },
    to: 'queued',
    changes: { max_attempts: 2, done_by: null, needs: null, stop_reason: null, question: null },
    history: 'retry',
  },
  {
    name: 'unblock_retry queues a blocked task without touching its attempts',
    from: 'blocked',
    event: { type: 'unblock_retry' },
    opts: { reason: 'Unblock run: use sqlite' },
    task: { attempts: 1 },
    to: 'queued',
    changes: { needs: null, stop_reason: null, question: null },
    history: 'unblock_retry',
  },
  {
    name: 'mark_done',
    from: 'blocked',
    event: { type: 'mark_done' },
    to: 'done',
    changes: { stop_reason: null, needs: null, question: null, done_by: 'person' },
    history: 'mark_done',
  },
  {
    name: 'pr_merged',
    from: 'failed',
    event: { type: 'pr_merged' },
    to: 'done',
    changes: { stop_reason: null, needs: null, question: null },
    history: 'pr_merged',
  },
  {
    name: 'recover requeues, counts the restart and gives the attempt back',
    from: 'running',
    event: { type: 'recover', exhausted: false },
    task: { attempts: 2, restarts: 1 },
    to: 'queued',
    changes: { restarts: 2, attempts: 1, needs: null, stop_reason: null, question: null },
    history: 'recover',
  },
  {
    name: 'recover:exhausted fails the task with the reason',
    from: 'running',
    event: { type: 'recover', exhausted: true },
    opts: { reason: 'restarted 3 times' },
    task: { attempts: 2, restarts: 2 },
    to: 'failed',
    changes: { restarts: 3, stop_reason: 'restarted 3 times' },
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
    opts: { reason: 'r', needs: 'n' },
    task: { attempts: 2, restarts: 1 },
    to: 'cancelled',
    changes: {},
    history: event.type === 'finish' && event.outcome === 'blocked' && event.environment ? 'environment_block' : event.type,
  })),
];

for (const c of CASES) {
  test(`transition: ${c.name}`, () => {
    const t = transition({ status: c.from, attempts: 0, restarts: 0, ...c.task }, c.event, c.opts);
    assert.deepEqual(t, { to: c.to, changes: c.changes, history: c.history });
  });
}

test('transition: every rule key has a case', () => {
  const covered = new Set(CASES.map((c) => ruleKey(c.event)));
  for (const key of Object.keys(RULES) as RuleKey[]) assert.ok(covered.has(key), `no case for ${key}`);
});

test('transition: null where the event is refused', () => {
  assert.equal(transition({ status: 'done', attempts: 1, restarts: 0 }, { type: 'claim' }), null);
  assert.equal(transition({ status: 'cancelled', attempts: 1, restarts: 0 }, { type: 'mark_done' }), null);
});
