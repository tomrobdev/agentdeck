import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWait, startDecision, startWait, waitingFor } from '#domain/work/task/start.ts';
import type { Decision } from '#domain/capacity/governor.ts';
import type { StartState } from '#domain/work/links/link.ts';
import { asTaskId } from '#test/fixtures/fixtures.ts';

const allow: Decision = { allow: true, max_concurrent: 2, reason: null, until: null, weekly_allowed: null };
const held: Decision = { ...allow, allow: false, reason: '5h window at 92%', until: 2000 };
const free = {
  queue: null,
  repoPaused: null,
  draining: null,
  dependency: { kind: 'none' } as const,
  unblocking: false,
  running: 0,
  max: 2,
};

test('startDecision checks pause, then rate limit, then the governor', () => {
  const at = (q: Parameters<typeof startDecision>[0]) => startDecision(q, { ignorePause: false, used: 0, now: 1000 });
  assert.deepEqual(at({ paused: true, rate_limited_until: 2000, governor: held }), { wait: { kind: 'daemon-paused' }, free: 0 });
  assert.deepEqual(at({ paused: false, rate_limited_until: 2000, governor: held }), {
    wait: { kind: 'rate-limited', until: 2000 },
    free: 0,
  });
  assert.deepEqual(at({ paused: false, rate_limited_until: 500, governor: held }), {
    wait: { kind: 'governor', reason: '5h window at 92%', until: 2000 },
    free: 0,
  });
  assert.deepEqual(at({ paused: false, rate_limited_until: null, governor: allow }), { wait: null, free: 2 });
});

test('startDecision ignores the pause for run-once, but not the rate limit', () => {
  const q = { paused: true, rate_limited_until: null, governor: allow };
  assert.deepEqual(startDecision(q, { ignorePause: true, used: 0, now: 1000 }), { wait: null, free: 2 });
  assert.deepEqual(startDecision({ ...q, rate_limited_until: 2000 }, { ignorePause: true, used: 0, now: 1000 }).wait, {
    kind: 'rate-limited',
    until: 2000,
  });
});

test('startDecision frees max_concurrent minus the slots used, never below 0', () => {
  const q = { paused: false, rate_limited_until: null, governor: allow };
  assert.equal(startDecision(q, { ignorePause: false, used: 1, now: 1000 }).free, 1);
  assert.equal(startDecision(q, { ignorePause: false, used: 2, now: 1000 }).free, 0);
  assert.equal(startDecision(q, { ignorePause: false, used: 5, now: 1000 }).free, 0);
});

test('describeWait words each wait as the scheduler logs it', () => {
  assert.equal(describeWait({ kind: 'daemon-paused' }), 'paused');
  assert.equal(describeWait({ kind: 'rate-limited', until: 2000 }), `rate limited until ${new Date(2000 * 1000).toLocaleTimeString()}`);
  assert.equal(describeWait({ kind: 'governor', reason: '5h window at 92%', until: 2000 }), '5h window at 92%');
});

test('startWait names what a queued task waits for', () => {
  assert.equal(startWait({ status: 'queued' }, free), null);
  assert.equal(startWait({ status: 'running' }, { ...free, queue: { kind: 'daemon-paused' } }), null);
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, queue: { kind: 'daemon-paused' }, repoPaused: 'refused' }), {
    kind: 'daemon-paused',
  });
  assert.deepEqual(
    startWait({ status: 'queued' }, { ...free, repoPaused: 'refused', dependency: { kind: 'waiting', on: [asTaskId(3)] } }),
    {
      kind: 'repo-paused',
      reason: 'refused',
    },
  );
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, dependency: { kind: 'stuck', on: asTaskId(3), reason: '#3 failed' } }), {
    kind: 'dependency',
    on: [3],
    stuck: '#3 failed',
  });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, dependency: { kind: 'waiting', on: [asTaskId(3), asTaskId(4)] } }), {
    kind: 'dependency',
    on: [3, 4],
    stuck: null,
  });
  assert.equal(startWait({ status: 'queued' }, { ...free, dependency: { kind: 'met' } }), null);
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, running: 2 }), { kind: 'slots', running: 2, max: 2, repo: null });
});

test("startWait: a queued task waits on its repo's slots before the daemon's", () => {
  const repo = { name: 'demo', running: 1, max: 1 };
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, running: 1, repo }), { kind: 'slots', running: 1, max: 1, repo: 'demo' });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, running: 2, repo }), { kind: 'slots', running: 1, max: 1, repo: 'demo' });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, running: 2, repo: { ...repo, max: 2 } }), {
    kind: 'slots',
    running: 2,
    max: 2,
    repo: null,
  });
  assert.equal(startWait({ status: 'queued' }, { ...free, running: 1, repo: { ...repo, max: 2 } }), null);
});

test('startWait: a queued task waits for its unblock run to stop, after its dependencies and before the slots', () => {
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, unblocking: true }), { kind: 'unblocking' });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, unblocking: true, running: 2 }), { kind: 'unblocking' });
  assert.equal(
    startWait({ status: 'queued' }, { ...free, unblocking: true, dependency: { kind: 'waiting', on: [asTaskId(3)] } })?.kind,
    'dependency',
  );
  assert.equal(startWait({ status: 'queued' }, { ...free, unblocking: true, repoPaused: 'refused' })?.kind, 'repo-paused');
  assert.equal(startWait({ status: 'blocked' }, { ...free, unblocking: true }), null, 'only a queued task waits to start');
});

test('startWait: a task that never ran waits out a drain, after a pause and before its links', () => {
  const draining = { ...free, draining: 'repo' as const, dependency: { kind: 'waiting' as const, on: [asTaskId(3)] } };
  assert.deepEqual(startWait({ status: 'queued' }, draining), { kind: 'draining', repo: true });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, draining: 'daemon' }), { kind: 'draining', repo: false });
  assert.equal(startWait({ status: 'queued' }, { ...draining, repoPaused: 'refused' })?.kind, 'repo-paused');
});

test('waitingFor: only a queued task waits on its builds-on links', () => {
  const waiting: StartState = { kind: 'waiting', on: [asTaskId(3)] };
  assert.deepEqual(waitingFor({ status: 'queued' }, waiting), { on: [3], stuck: null });
  assert.deepEqual(waitingFor({ status: 'queued' }, { kind: 'stuck', on: asTaskId(3), reason: '#3 failed' }), {
    on: [3],
    stuck: '#3 failed',
  });
  assert.equal(waitingFor({ status: 'queued' }, { kind: 'met' }), null);
  for (const status of ['running', 'blocked', 'done'] as const) assert.equal(waitingFor({ status }, waiting), null, status);
});
