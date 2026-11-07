import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus, runOutcome } from '../src/domain/runs/run.ts';

const finished = { end: { kind: 'finished' } as const, testsPassed: null, commitsAhead: 1, denials: 0 };

test('a done run with no commits is blocked', () => {
  const r = runOutcome({ ...finished, status: parseStatus('STATUS: DONE'), commitsAhead: 0 });
  assert.deepEqual(r.result, { outcome: 'blocked', reason: 'agent finished without changing anything' });
  assert.equal(r.pause, false);
  assert.equal(runOutcome({ ...finished, status: parseStatus('STATUS: DONE') }).result.outcome, 'done');
});

test('a blocked run with refused tool uses is the environment, and pauses the repo', () => {
  const r = runOutcome({ ...finished, status: parseStatus('STATUS: BLOCKED: stuck'), commitsAhead: null, denials: 2 });
  assert.equal(r.result.outcome, 'blocked');
  assert.equal(r.result.environment, true);
  assert.equal(r.pause, true);
});

test('a block the worker reported as a need does not pause the repo, refusals or not', () => {
  const needs = runOutcome({
    ...finished,
    status: parseStatus('STATUS: BLOCKED: NEEDS edit: .claude/settings.json'),
    commitsAhead: null,
    denials: 1,
  });
  assert.equal(needs.result.outcome, 'blocked');
  assert.equal(needs.result.environment, true);
  assert.deepEqual(needs.result.needs, { kind: 'edit', items: ['.claude/settings.json'] });
  assert.equal(needs.pause, false);
  // A refusal with no need named still pauses: nobody said what was wrong.
  const unnamed = runOutcome({ ...finished, status: parseStatus('STATUS: BLOCKED: could not write'), commitsAhead: null, denials: 1 });
  assert.equal(unnamed.pause, true);
});

test('failed tests with refused tool uses fail the run without pausing', () => {
  const r = runOutcome({ ...finished, status: parseStatus('STATUS: DONE'), testsPassed: false, commitsAhead: null, denials: 3 });
  assert.deepEqual(r.result, { outcome: 'failed', reason: 'tests failed' });
  assert.equal(r.pause, false);
});

test('a cancel or a rate limit never pauses', () => {
  assert.equal(runOutcome({ ...finished, end: { kind: 'cancelled' }, denials: 1 }).pause, false);
  const limited = runOutcome({ ...finished, end: { kind: 'rate_limited', reason: 'later' }, denials: 1 });
  assert.deepEqual(limited, { result: { outcome: 'rate_limited', reason: 'later' }, pause: false });
});
