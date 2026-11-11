// Pure tests of a task's branch, checkout, ids, stage, start waits and state.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prNeedsPerson, prRetry } from '#domain/landing/index.ts';
import { asTaskId } from '#domain/shared/index.ts';
import {
  type Task,
  type TaskState,
  attemptsLeft,
  branchName,
  canOpenPr,
  canStartMerge,
  checkoutOf,
  defaultTitle,
  describeWait,
  hasOpenPr,
  isBlocked,
  isMerged,
  isReview,
  isStuck,
  isWaiting,
  leftoversMessage,
  modelSourceText,
  newTaskModel,
  parseTaskIds,
  stageOf,
  startDecision,
  startWait,
  stateFields,
  stopReasonOf,
  waitingFor,
} from '#domain/work/index.ts';

const id = asTaskId;
const governor = { allow: true, max_concurrent: 3, reason: null, until: null, weekly_allowed: null };

test('branchName is the checkout branch, else agentdeck/task-<id>', () => {
  assert.equal(branchName({ id: id(4), checkout: null }), 'agentdeck/task-4');
  assert.equal(branchName({ id: id(4), checkout: { branch: null } }), 'agentdeck/task-4');
  assert.equal(branchName({ id: id(4), checkout: { branch: 'feature/x' } }), 'feature/x');
});

test('checkoutOf is null only when the branch, worktree and sync are all null', () => {
  assert.equal(checkoutOf({ branch: null, worktree: null, syncing_since: null }), null);
  const set = { branch: 'b', worktree: null, syncing_since: null };
  assert.deepEqual(checkoutOf(set), set);
  assert.notEqual(checkoutOf({ branch: null, worktree: null, syncing_since: '2026-01-01 00:00:00' }), null);
});

test('parseTaskIds reads ids from a list or a string, drops repeats, and refuses anything else', () => {
  assert.deepEqual(parseTaskIds(undefined), []);
  assert.deepEqual(parseTaskIds(''), []);
  assert.deepEqual(parseTaskIds('1, 2 3,2'), [1, 2, 3]);
  assert.deepEqual(parseTaskIds([4, '5', 4]), [4, 5]);
  assert.equal(parseTaskIds('1,x'), null);
  assert.equal(parseTaskIds({}), null);
  assert.equal(parseTaskIds([0]), null);
});

test('a done task with an open PR is in review; only that one can start a merge, and not while it syncs or has a merge request', () => {
  const review = stageOf({ status: 'done', pr: { state: 'open' } as never });
  assert.equal(review.pr_state, 'open');
  assert.ok(hasOpenPr(review));
  assert.ok(isReview(review));
  assert.ok(canStartMerge(review));
  assert.ok(!canStartMerge({ ...review, sync: {} }));
  assert.ok(!canStartMerge({ ...review, merge_request: {} }));
  assert.ok(!isReview(stageOf({ status: 'running', pr: { state: 'open' } as never })));
  assert.equal(stageOf({ status: 'queued', pr: null }).pr_state, null);
});

test('a done task can open its PR when a retry is pending or the PR was closed; a merged PR is merged', () => {
  assert.ok(canOpenPr({ status: 'done', pr_state: 'failed', pr_retry: { state: 'due' } }));
  assert.ok(canOpenPr({ status: 'done', pr_state: 'closed' }));
  assert.ok(!canOpenPr({ status: 'done', pr_state: 'open' }));
  assert.ok(!canOpenPr({ status: 'blocked', pr_state: 'closed' }));
  assert.ok(isMerged({ status: 'done', pr_state: 'merged' }));
  assert.ok(!isMerged({ status: 'done', pr_state: 'open' }));
});

test('a queued task waits when what it builds on is on its way, and is stuck when it will not get there', () => {
  assert.ok(isWaiting({ status: 'queued', waiting: { on: [id(1)], stuck: null } }));
  assert.ok(!isWaiting({ status: 'queued', waiting: { on: [id(1)], stuck: 'rejected' } }));
  assert.ok(!isWaiting({ status: 'running', waiting: { on: [id(1)], stuck: null } }));
  assert.ok(isStuck({ status: 'queued', waiting: { on: [id(1)], stuck: 'rejected' } }));
  assert.ok(!isStuck({ status: 'queued', waiting: null }));
});

test('startDecision: a paused daemon, a rate limit or a governor hold wait and free no slot; otherwise the free slots are the max less the used', () => {
  const o = { ignorePause: false, used: 1, now: 100 };
  const open = { paused: false, rate_limited_until: null, governor };
  assert.deepEqual(startDecision(open, o), { wait: null, free: 2 });
  assert.deepEqual(startDecision({ ...open, paused: true }, o), { wait: { kind: 'daemon-paused' }, free: 0 });
  assert.deepEqual(startDecision({ ...open, paused: true }, { ...o, ignorePause: true }), { wait: null, free: 2 });
  assert.deepEqual(startDecision({ ...open, rate_limited_until: 200 }, o), { wait: { kind: 'rate-limited', until: 200 }, free: 0 });
  assert.equal(startDecision({ ...open, rate_limited_until: 50 }, o).wait, null);
  const held = { ...governor, allow: false, reason: 'five hour', until: 300 };
  assert.deepEqual(startDecision({ ...open, governor: held }, o), { wait: { kind: 'governor', reason: 'five hour', until: 300 }, free: 0 });
  assert.equal(startDecision({ ...open, governor: { ...held, reason: null } }, o).wait?.kind, 'governor');
  assert.equal(startDecision(open, { ...o, used: 9 }).free, 0);
});

test('describeWait says why the queue waits', () => {
  assert.equal(describeWait({ kind: 'daemon-paused' }), 'paused');
  assert.match(describeWait({ kind: 'rate-limited', until: 1_800_000_000 }), /^rate limited until /);
  assert.equal(describeWait({ kind: 'governor', reason: 'weekly pace', until: null }), 'weekly pace');
});

test('waitingFor: only a queued task waits, on the builds-on links that are on their way or stuck', () => {
  assert.deepEqual(waitingFor({ status: 'queued' }, { kind: 'waiting', on: [id(2)] }), { on: [2], stuck: null });
  assert.deepEqual(waitingFor({ status: 'queued' }, { kind: 'stuck', on: id(2), reason: 'rejected' }), { on: [2], stuck: 'rejected' });
  assert.equal(waitingFor({ status: 'queued' }, { kind: 'met' }), null);
  assert.equal(waitingFor({ status: 'running' }, { kind: 'waiting', on: [id(2)] }), null);
});

test('startWait checks the queue, the repo pause, the links, an unblock run and the slots, in that order', () => {
  const ctx = { queue: null, repoPaused: null, dependency: { kind: 'none' } as const, unblocking: false, running: 0, max: 2 };
  const queued = { status: 'queued' } as const;
  assert.equal(startWait({ status: 'running' }, ctx), null);
  assert.equal(startWait(queued, ctx), null);
  const all = { ...ctx, repoPaused: 'paused', dependency: { kind: 'waiting' as const, on: [id(3)] }, unblocking: true, running: 2 };
  assert.deepEqual(startWait(queued, { ...all, queue: { kind: 'daemon-paused' } }), { kind: 'daemon-paused' });
  assert.deepEqual(startWait(queued, all), { kind: 'repo-paused', reason: 'paused' });
  assert.deepEqual(startWait(queued, { ...all, repoPaused: null }), { kind: 'dependency', on: [3], stuck: null });
  assert.deepEqual(startWait(queued, { ...all, repoPaused: null, dependency: { kind: 'none' } }), { kind: 'unblocking' });
  assert.deepEqual(startWait(queued, { ...ctx, running: 2 }), { kind: 'slots', running: 2, max: 2 });
});

test('attemptsLeft is true while the attempts used are fewer than the maximum', () => {
  assert.ok(attemptsLeft({ attempts: 1, max_attempts: 2 }));
  assert.ok(!attemptsLeft({ attempts: 2, max_attempts: 2 }));
});

test('defaultTitle is the first sentence of the prompt, cut at a word when long', () => {
  assert.equal(defaultTitle('Fix the bug. Then more.'), 'Fix the bug');
  assert.equal(defaultTitle('Add a thing\nsecond line'), 'Add a thing');
  const long = defaultTitle(`${'word '.repeat(30)}end`);
  assert.ok(long.endsWith('…') && long.length <= 73);
  assert.equal(defaultTitle('x'.repeat(100)), `${'x'.repeat(72)}…`);
});

test('the leftovers message names the task and its title', () => {
  assert.equal(leftoversMessage({ id: id(7), title: 'Do it' }), 'agentdeck: uncommitted work from task 7\n\nDo it');
});

test('a new task takes the asked model, else its repo default, else the default setting, and says where it came from', () => {
  assert.deepEqual(newTaskModel('opus', { model: 'haiku' }, 'sonnet'), { model: 'opus', source: 'asked' });
  assert.deepEqual(newTaskModel(undefined, { model: 'haiku' }, 'sonnet'), { model: 'haiku', source: 'repo' });
  assert.deepEqual(newTaskModel('', { model: null }, 'sonnet'), { model: 'sonnet', source: 'setting' });
  assert.equal(modelSourceText('asked'), null);
  assert.equal(modelSourceText('repo'), "the repo's default");
  assert.equal(modelSourceText('setting'), 'the default_model setting');
});

test('a state carries only its own fields: stop reason, needs, question and who finished it', () => {
  const blocked: TaskState = { status: 'blocked', stop_reason: 'no deps', needs: null, question: null };
  const done: TaskState = { status: 'done', done_by: 'person' };
  assert.equal(stopReasonOf(blocked), 'no deps');
  assert.equal(stopReasonOf(done), null);
  assert.equal(stopReasonOf({ status: 'failed', stop_reason: 'out of attempts' }), 'out of attempts');
  assert.deepEqual(stateFields(blocked), { stop_reason: 'no deps', needs: null, question: null, done_by: null });
  assert.deepEqual(stateFields(done), { stop_reason: null, needs: null, question: null, done_by: 'person' });
  assert.ok(isBlocked({ status: 'blocked' } as unknown as Task));
  assert.ok(!isBlocked({ status: 'done' } as unknown as Task));
});

test('a failed PR open is retried at growing waits, and a person must open it once the retries are used', () => {
  const at = '2026-01-01 00:00:00';
  const start = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(prRetry({ count: 1, error: 'e', at }, start + 4 * 60_000).state, 'due');
  const wait = prRetry({ count: 1, error: 'e', at }, start + 60_000);
  assert.equal(wait.state, 'wait');
  assert.equal(wait.next_at, '2026-01-01 00:03:00');
  assert.equal(prRetry({ count: 2, error: 'e', at }, start + 4 * 60_000).state, 'wait');
  assert.deepEqual(prRetry({ count: 6, error: 'e', at }, start), { failures: 6, error: 'e', state: 'person', next_at: null });
  assert.equal(prRetry({ count: 1, error: 'e', at: 'garbage' }, start).state, 'due');
});

test('only a done task whose PR failed and whose retries are used needs a person', () => {
  assert.ok(prNeedsPerson({ status: 'done', pr_state: 'failed', pr_retry: { state: 'person' } }));
  assert.ok(!prNeedsPerson({ status: 'done', pr_state: 'failed', pr_retry: { state: 'wait' } }));
  assert.ok(!prNeedsPerson({ status: 'done', pr_state: 'open', pr_retry: { state: 'person' } }));
  assert.ok(!prNeedsPerson({ status: 'blocked', pr_state: 'failed', pr_retry: { state: 'person' } }));
  assert.ok(!prNeedsPerson({ status: 'done', pr_state: 'failed' }));
});
