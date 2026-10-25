import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueWait, startWait } from '../src/domain/task/start.ts';
import type { Decision } from '../src/domain/usage/governor.ts';

const allow: Decision = { allow: true, max_concurrent: 2, reason: null, until: null, weekly_allowed: null };
const held: Decision = { ...allow, allow: false, reason: '5h window at 92%', until: 2000 };
const free = { queue: null, repoPaused: null, dependency: { kind: 'none' } as const, after: null, running: 0, max: 2 };

test('queueWait checks pause, then rate limit, then the governor', () => {
  assert.deepEqual(queueWait({ paused: true, rate_limited_until: 2000, governor: held }, 1000), { kind: 'daemon-paused' });
  assert.deepEqual(queueWait({ paused: false, rate_limited_until: 2000, governor: held }, 1000), { kind: 'rate-limited', until: 2000 });
  assert.deepEqual(queueWait({ paused: false, rate_limited_until: 500, governor: held }, 1000), {
    kind: 'governor',
    reason: '5h window at 92%',
    until: 2000,
  });
  assert.equal(queueWait({ paused: false, rate_limited_until: null, governor: allow }, 1000), null);
});

test('startWait names what a queued task waits for', () => {
  assert.equal(startWait({ status: 'queued' }, free), null);
  assert.equal(startWait({ status: 'running' }, { ...free, queue: { kind: 'daemon-paused' } }), null);
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, queue: { kind: 'daemon-paused' }, repoPaused: 'refused' }), {
    kind: 'daemon-paused',
  });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, repoPaused: 'refused', after: 3, dependency: { kind: 'waiting' } }), {
    kind: 'repo-paused',
    reason: 'refused',
  });
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, after: 3, dependency: { kind: 'stuck', reason: '#3 failed' } }), {
    kind: 'dependency',
    on: 3,
    stuck: '#3 failed',
  });
  assert.equal(startWait({ status: 'queued' }, { ...free, after: 3, dependency: { kind: 'met' } }), null);
  assert.deepEqual(startWait({ status: 'queued' }, { ...free, running: 2 }), { kind: 'slots', running: 2, max: 2 });
});
