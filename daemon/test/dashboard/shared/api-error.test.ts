// The dashboard retries a failed query only when asking again could help: not offline, not a 4xx.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, OfflineError, retryQuery } from '#app/api/api-error.ts';

test('a query that gets a 4xx is not retried, a 5xx or an unknown failure is retried twice', () => {
  assert.equal(retryQuery(0, new ApiError('no such task', 404)), false);
  assert.equal(retryQuery(0, new ApiError('is running', 409, 'builds_on_started')), false);
  assert.equal(retryQuery(0, new ApiError('could not read the PR', 502)), true);
  assert.equal(retryQuery(1, new ApiError('could not read the PR', 502)), true);
  assert.equal(retryQuery(2, new ApiError('could not read the PR', 502)), false);
  assert.equal(retryQuery(0, new Error('boom')), true);
  assert.equal(retryQuery(0, new OfflineError()), false);
});

test('an ApiError keeps its status and code', () => {
  const err = new ApiError('x', 409, 'builds_on_started');
  assert.equal(err.status, 409);
  assert.equal(err.code, 'builds_on_started');
  assert.equal(new ApiError('x').status, null);
});
