import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyEventsError, ntfyServerError, ntfyTopicError } from '../../src/domain/operations/notification.ts';
import { plannerIntervalError, plannerMaxTasksError, plannerModelError } from '../../src/domain/proposals/proposals.ts';
import { goalsError, networkError } from '../../src/domain/repos/rules.ts';
import {
  archivedRepoError,
  maxAttemptsError,
  maxTurnsError,
  modelError,
  priorityError,
  stepsNeedPlanError,
} from '../../src/domain/work/rules.ts';
import { validateSlots } from '../../src/domain/capacity/governor.ts';

test('priority, turn and attempt limits', () => {
  assert.equal(priorityError(-1000), null);
  assert.equal(priorityError(1000), null);
  assert.equal(priorityError(1001), 'priority must be a whole number from -1000 to 1000');
  assert.equal(priorityError(1.5), 'priority must be a whole number from -1000 to 1000');
  assert.equal(priorityError('3'), 'priority must be a whole number from -1000 to 1000');
  assert.equal(maxTurnsError(1), null);
  assert.equal(maxTurnsError(500), null);
  assert.equal(maxTurnsError(0), 'max_turns must be a whole number from 1 to 500');
  assert.equal(maxTurnsError(501), 'max_turns must be a whole number from 1 to 500');
  assert.equal(maxAttemptsError(20), null);
  assert.equal(maxAttemptsError(21), 'max_attempts must be a whole number from 1 to 20');
  assert.equal(maxAttemptsError(Number.NaN), 'max_attempts must be a whole number from 1 to 20');
});

test('task model: an alias, a full id, or none', () => {
  assert.equal(modelError(undefined), null);
  assert.equal(modelError(''), null);
  assert.equal(modelError('opus'), null);
  assert.equal(modelError('claude-sonnet-5-5'), null);
  assert.equal(modelError('opuss'), 'model must be haiku, sonnet, opus or a full claude-… model id');
});

test('steps need a plan', () => {
  assert.equal(stepsNeedPlanError(null, null), null);
  assert.equal(stepsNeedPlanError(12, ['one']), null);
  assert.equal(stepsNeedPlanError(null, ['one']), '--steps needs --plan');
});

test('an archived repo takes no tasks', () => {
  assert.equal(archivedRepoError({ name: 'r', archived_at: null }), null);
  assert.equal(archivedRepoError({ name: 'r', archived_at: '2026-01-01 00:00:00' }), 'r is archived; unarchive it first');
});

test('goals are limited to 20,000 characters', () => {
  assert.equal(goalsError('x'.repeat(20_000)), null);
  assert.equal(goalsError('x'.repeat(20_001)), 'goals are limited to 20,000 characters');
});

test('network hosts', () => {
  assert.equal(networkError([]), null);
  assert.equal(networkError(['github.com', '*.npmjs.org', 'localhost:8080', '[::1]']), null);
  assert.equal(networkError(['github.com', 'a b/c', 'x!']), 'not a host name: a b/c');
});

test('planner interval, max tasks and model', () => {
  assert.equal(plannerIntervalError(0.25), null);
  assert.equal(plannerIntervalError(168), null);
  assert.equal(plannerIntervalError(0.2), 'planner interval must be between 0.25 and 168 hours');
  assert.equal(plannerIntervalError(169), 'planner interval must be between 0.25 and 168 hours');
  assert.equal(plannerIntervalError(Number.NaN), 'planner interval must be between 0.25 and 168 hours');
  assert.equal(plannerMaxTasksError(1), null);
  assert.equal(plannerMaxTasksError(10), null);
  assert.equal(plannerMaxTasksError(0), 'planner max tasks must be a whole number from 1 to 10');
  assert.equal(plannerMaxTasksError(11), 'planner max tasks must be a whole number from 1 to 10');
  assert.equal(plannerMaxTasksError(2.5), 'planner max tasks must be a whole number from 1 to 10');
  assert.equal(plannerModelError('sonnet'), null);
  assert.equal(plannerModelError('claude-sonnet-5-5'), 'planner model must be one of haiku, sonnet, opus');
});

test('notification events, ntfy topic and server', () => {
  assert.equal(notifyEventsError(['done', 'paused']), null);
  assert.equal(notifyEventsError([]), null);
  assert.equal(notifyEventsError(['done', 'oops', 'x']), 'unknown notification events: oops, x');
  assert.equal(ntfyTopicError(''), null);
  assert.equal(ntfyTopicError('my_topic-1'), null);
  assert.equal(ntfyTopicError('a'.repeat(64)), null);
  assert.equal(ntfyTopicError('a'.repeat(65)), 'ntfy topic: letters, digits, - and _ only');
  assert.equal(ntfyTopicError('has space'), 'ntfy topic: letters, digits, - and _ only');
  assert.equal(ntfyServerError('https://ntfy.sh'), null);
  assert.equal(ntfyServerError('http://localhost:8080'), null);
  assert.equal(ntfyServerError('ntfy.sh'), 'ntfy server must be an http(s) URL');
  assert.equal(ntfyServerError('https://a b'), 'ntfy server must be an http(s) URL');
});

test('slot count', () => {
  assert.equal(validateSlots(1), null);
  assert.equal(validateSlots(8), null);
  assert.equal(validateSlots(0), 'max_concurrent must be a whole number from 1 to 8');
  assert.equal(validateSlots(9), 'max_concurrent must be a whole number from 1 to 8');
  assert.equal(validateSlots('2'), 'max_concurrent must be a whole number from 1 to 8');
});
