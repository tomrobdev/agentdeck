import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeWait, startDecision, startWait } from '../src/domain/task/start.ts';
import type { Decision } from '../src/domain/usage/governor.ts';

const allow: Decision = { allow: true, max_concurrent: 2, reason: null, until: null, weekly_allowed: null };
const held: Decision = { ...allow, allow: false, reason: '5h window at 92%', until: 2000 };
const free = { queue: null, repoPaused: null, dependency: { kind: 'none' } as const, running: 0, max: 2 };

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
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, repoPaused: 'refused', dependency: { kind: 'waiting', on: [3] } }), {
    kind: 'repo-paused',
    reason: 'refused',
  });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, dependency: { kind: 'stuck', on: 3, reason: '#3 failed' } }), {
    kind: 'dependency',
    on: 3,
    stuck: '#3 failed',
  });
  assert.equal(startWait({ status: 'queued' }, { ...free, dependency: { kind: 'met' } }), null);
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, running: 2 }), { kind: 'slots', running: 2, max: 2 });
});
