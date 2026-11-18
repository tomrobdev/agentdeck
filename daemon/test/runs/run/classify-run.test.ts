// What a claude process's end means: a cancel wins, a rate limit beats a failure, a missing result is a failure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ClaudeRunLike, classifyRun } from '#domain/runs/run-result.ts';

const base: ClaudeRunLike = { result: { result: 'ok' }, exitCode: 0, rateLimitedUntil: undefined, cancelled: false, stderr: '' };

test('a clean exit with a result is finished', () => {
  const end = classifyRun(base);
  assert.equal(end.kind, 'finished');
  assert.equal(end.kind === 'finished' && end.result.result, 'ok');
});

test('cancel wins over a rate limit', () => {
  assert.deepEqual(classifyRun({ ...base, cancelled: true, rateLimitedUntil: 2_000_000_000, exitCode: 1 }), { kind: 'cancelled' });
});

test('a 429 with no reset time stays a failure, as before: there is no time to wait until', () => {
  const end = classifyRun({ ...base, result: undefined, exitCode: 1, rateLimitedUntil: undefined, stderr: 'API Error: 429' });
  assert.deepEqual(end, { kind: 'failed', reason: 'claude exited with code 1: API Error: 429' });
});

test('a rate limit with a reset time is rate limited until then', () => {
  const end = classifyRun({ ...base, result: undefined, exitCode: 1, rateLimitedUntil: 2_000_000_000 });
  assert.deepEqual(end, { kind: 'rate_limited', until: 2_000_000_000, reason: 'rate limited until 2033-05-18T03:33:20.000Z' });
});

test('no result is failed with the stderr tail', () => {
  const end = classifyRun({ ...base, result: undefined, exitCode: 2, stderr: 'warming up\nsandbox unavailable\n' });
  assert.deepEqual(end, { kind: 'failed', reason: 'claude exited with code 2: sandbox unavailable' });
});

test('a clean exit with no result is failed as "ended without a result", not "code 0"', () => {
  assert.deepEqual(classifyRun({ ...base, result: undefined }), { kind: 'failed', reason: 'claude ended without a result' });
});

test('an error result is failed with its subtype', () => {
  const end = classifyRun({ ...base, result: { result: 'x', is_error: true, subtype: 'error_max_turns' } });
  assert.deepEqual(end, { kind: 'failed', reason: 'error_max_turns' });
});

test('an error claude reported under the subtype success is named by what it said, never "success"', () => {
  const result = { is_error: true, subtype: 'success', result: 'Retrying…\nAPI Error: 529 Overloaded' };
  assert.deepEqual(classifyRun({ ...base, exitCode: 1, result }), { kind: 'failed', reason: 'API Error: 529 Overloaded' });
  assert.deepEqual(classifyRun({ ...base, exitCode: 1, result: { is_error: true, subtype: 'success', result: '' } }), {
    kind: 'failed',
    reason: 'claude exited with code 1',
  });
});

test('a good result from a process that exited non-zero is failed by its exit code', () => {
  const end = classifyRun({
    ...base,
    exitCode: 1,
    stderr: 'hook failed',
    result: { is_error: false, subtype: 'success', result: 'STATUS: DONE' },
  });
  assert.deepEqual(end, { kind: 'failed', reason: 'claude exited with code 1: hook failed' });
});

test('an error subtype is still the reason', () => {
  const end = classifyRun({ ...base, exitCode: 1, result: { is_error: true, subtype: 'error_max_turns', result: 'x' } });
  assert.deepEqual(end, { kind: 'failed', reason: 'error_max_turns' });
});
