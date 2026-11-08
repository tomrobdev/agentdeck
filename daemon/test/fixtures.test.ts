import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitFor } from './fixtures.ts';

test('waitFor returns what the check returned once it is truthy', async () => {
  let polls = 0;
  assert.equal(await waitFor(() => ++polls >= 3 && 'ready', { what: 'the third poll' }), 'ready');
  assert.equal(polls, 3);
});

test('waitFor throws, naming what it waited for, at the deadline', async () => {
  const started = Date.now();
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 100, what: 'a state that never comes' }),
    {
      message: 'timed out after 100 ms waiting for a state that never comes',
    },
  );
  const took = Date.now() - started;
  assert.ok(took >= 100 && took < 1_000, `gave up after ${took} ms`);
});

test('waitFor ends with the error of a check that throws', async () => {
  await assert.rejects(
    waitFor(
      () => {
        throw new Error('the daemon exited');
      },
      { what: 'anything' },
    ),
    /the daemon exited/,
  );
});
