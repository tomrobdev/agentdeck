import assert from 'node:assert/strict';
import { test } from 'node:test';
import { syncResultOf } from '../src/domain/runs/sync.ts';
import { resolveOutcome } from '../src/domain/runs/resolve.ts';

const finished = (result: string) => ({ kind: 'finished' as const, result: { result } });

test('a cancelled resolve run is cancelled', () => {
  assert.deepEqual(resolveOutcome({ kind: 'cancelled' }), { outcome: 'cancelled' });
});

test('a rate limited resolve run keeps the reason', () => {
  assert.deepEqual(resolveOutcome({ kind: 'rate_limited', until: 1, reason: 'rate limited until later' }), {
    outcome: 'rate_limited',
    reason: 'rate limited until later',
  });
});

test('a resolve run that failed keeps the reason', () => {
  assert.deepEqual(resolveOutcome({ kind: 'failed', reason: 'claude exited with code 1' }), {
    outcome: 'failed',
    reason: 'claude exited with code 1',
  });
});

test('a resolve run that says BLOCKED is blocked, with its reason or a default', () => {
  assert.deepEqual(resolveOutcome(finished('tried\nSTATUS: BLOCKED: two designs clash')), {
    outcome: 'blocked',
    reason: 'two designs clash',
  });
  assert.deepEqual(resolveOutcome(finished('STATUS: BLOCKED')), {
    outcome: 'blocked',
    reason: 'the agent could not resolve the conflicts',
  });
});

test('a resolve run that says DONE, or nothing, is left to the merge and test check', () => {
  assert.deepEqual(resolveOutcome(finished('Resolved.\nSTATUS: DONE')), { outcome: 'check' });
  assert.deepEqual(resolveOutcome(finished('Resolved.')), { outcome: 'check' });
});

test('syncResultOf turns a resolve run outcome into the sync result', () => {
  assert.deepEqual(syncResultOf('done', ['a.ts'], ''), { kind: 'resolved', files: ['a.ts'] });
  assert.deepEqual(syncResultOf('cancelled', ['a.ts'], ''), { kind: 'cancelled' });
  assert.deepEqual(syncResultOf('rate_limited', ['a.ts'], 'later'), { kind: 'rate_limited', reason: 'later' });
  assert.deepEqual(syncResultOf('failed', ['a.ts'], 'tests failed'), { kind: 'failed', files: ['a.ts'], reason: 'tests failed' });
  assert.deepEqual(syncResultOf('blocked', ['a.ts'], 'clash'), { kind: 'failed', files: ['a.ts'], reason: 'clash' });
});
