// Reviews: the domain rules, and the use cases end to end on an in-memory db.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { asReviewId, asTaskId } from '../src/domain/id/id.ts';
import { commentsToAddress, nextCommentState, reviewReason } from '../src/domain/review/review.ts';
import type { ReviewComment, ReviewWithComments } from '../src/domain/review/review.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-reviews-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const actions = await import('../src/application/actions.ts');
const { recordAnswers } = await import('../src/application/review/address.ts');
const { doneTask, runningTask } = await import('./fixtures.ts');

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  return { db, repo };
}

const comment = { path: 'src/a.ts', line: 3, side: 'new', head_commit: 'abc1234def', body: 'rename this' };

const c = (id: number, state: ReviewComment['state']): ReviewComment => ({
  id,
  review_id: asReviewId(1),
  path: 'a.ts',
  line: id,
  side: 'new',
  head_commit: 'x',
  body: `b${id}`,
  answer: null,
  state,
  created_at: '',
  updated_at: '',
});

test('a comment moves open → answered → resolved, and reopens', () => {
  assert.equal(nextCommentState('open', 'answer'), 'answered');
  assert.equal(nextCommentState('answered', 'answer'), 'answered');
  assert.equal(nextCommentState('resolved', 'answer'), null);
  assert.equal(nextCommentState('open', 'resolve'), 'resolved');
  assert.equal(nextCommentState('answered', 'resolve'), 'resolved');
  assert.equal(nextCommentState('resolved', 'resolve'), null);
  assert.equal(nextCommentState('resolved', 'reopen'), 'open');
  assert.equal(nextCommentState('answered', 'reopen'), 'open');
  assert.equal(nextCommentState('open', 'reopen'), null);
});

test('a run must address the open comments of submitted request_changes reviews only', () => {
  const review = (id: number, kind: 'comment' | 'request_changes', submitted: boolean, comments: ReviewComment[]): ReviewWithComments => ({
    id: asReviewId(id),
    task_id: asTaskId(1),
    kind: submitted ? kind : null,
    body: '',
    created_at: '',
    submitted_at: submitted ? 'now' : null,
    comments,
  });
  const due = commentsToAddress([
    review(1, 'request_changes', true, [c(1, 'open'), c(2, 'answered'), c(3, 'resolved')]),
    review(2, 'comment', true, [c(4, 'open')]),
    review(3, 'request_changes', false, [c(5, 'open')]),
    review(4, 'request_changes', true, [c(6, 'open')]),
  ]);
  assert.deepEqual(
    due.map((x) => x.id),
    [1, 6],
  );
});

test('the retry reason is the note, then each comment with where it points', () => {
  assert.equal(reviewReason('Please fix', [c(2, 'open')]), 'Please fix\n\n- a.ts:2: b2');
  assert.equal(reviewReason('', [{ ...c(2, 'open'), side: 'old' }]), '- a.ts:2 (old): b2');
});

test('a draft is built, edited and submitted as a Comment without touching the task', () => {
  const { db, repo } = setup();
  const task = doneTask(db, repo);
  const draft = actions.startReview(db, task.id);
  assert.equal(draft.submitted_at, null);
  assert.equal(actions.startReview(db, task.id).id, draft.id, 'one draft per task');

  const added = actions.addReviewComment(db, draft.id, comment);
  const id = added.comments[0].id;
  assert.equal(added.comments[0].state, 'open');
  assert.equal(actions.deleteReviewComment(db, id).comments.length, 0);
  assert.throws(() => actions.submitReview(db, draft.id, { kind: 'comment' }), /needs a note or at least one comment/);

  actions.addReviewComment(db, draft.id, comment);
  actions.editReview(db, draft.id, { body: 'Mostly fine' });
  const sent = actions.submitReview(db, draft.id, { kind: 'comment' });
  assert.equal(sent.kind, 'comment');
  assert.ok(sent.submitted_at);
  assert.equal(db.getTask(task.id)?.status, 'done');

  assert.throws(() => actions.editReview(db, draft.id, { body: 'x' }), /already submitted/);
  assert.throws(() => actions.addReviewComment(db, draft.id, comment), /already submitted/);
  assert.throws(() => actions.deleteReviewComment(db, sent.comments[0].id), /already submitted/);
  assert.throws(() => actions.submitReview(db, draft.id, { kind: 'comment' }), /already submitted/);
  assert.notEqual(actions.startReview(db, task.id).id, draft.id, 'a new draft after submitting');
});

test('Request changes moves a done task back to queued with the review as the reason', () => {
  const { db, repo } = setup();
  const task = doneTask(db, repo);
  const draft = actions.startReview(db, task.id);
  actions.addReviewComment(db, draft.id, comment);
  const sent = actions.submitReview(db, draft.id, { kind: 'request_changes', body: 'Needs work' });
  assert.equal(sent.kind, 'request_changes');
  assert.equal(db.getTask(task.id)?.status, 'queued');
  const retry = db.eventsForTask(task.id).findLast((e) => e.type === 'retry');
  assert.equal(retry?.reason, 'Needs work\n\n- src/a.ts:3: rename this');
  assert.deepEqual(
    commentsToAddress(actions.taskReviews(db, task.id)).map((x) => x.body),
    ['rename this'],
  );
});

test('Request changes on a task that cannot be retried leaves the review a draft', () => {
  const { db, repo } = setup();
  const task = runningTask(db, repo);
  const draft = actions.startReview(db, task.id);
  actions.addReviewComment(db, draft.id, comment);
  assert.throws(() => actions.submitReview(db, draft.id, { kind: 'request_changes' }), /is running/);
  assert.equal(db.getReview(draft.id)?.submitted_at, null);
  assert.equal(db.getTask(task.id)?.status, 'running');
});

test('comments are answered, resolved and reopened after the review is submitted', () => {
  const { db, repo } = setup();
  const task = doneTask(db, repo);
  const draft = actions.startReview(db, task.id);
  const id = actions.addReviewComment(db, draft.id, comment).comments[0].id;
  assert.throws(() => actions.resolveReviewComment(db, id), /still a draft/);
  actions.submitReview(db, draft.id, { kind: 'comment' });

  const state = () => actions.taskReviews(db, task.id)[0].comments[0];
  assert.throws(() => actions.reopenReviewComment(db, id), /nothing to reopen/);
  recordAnswers(db, [state()], 'ANSWER c1: done in abc');
  assert.deepEqual([state().state, state().answer], ['answered', 'done in abc']);
  actions.resolveReviewComment(db, id);
  assert.equal(state().state, 'resolved');
  assert.throws(() => actions.resolveReviewComment(db, id), /can't be resolved/);
  recordAnswers(db, [state()], 'ANSWER c1: x');
  assert.deepEqual([state().state, state().answer], ['resolved', 'done in abc'], 'a resolved comment stays resolved');
  actions.reopenReviewComment(db, id);
  assert.equal(state().state, 'open');
});

test('bad input is refused', () => {
  const { db, repo } = setup();
  const task = doneTask(db, repo);
  assert.throws(() => actions.startReview(db, asTaskId(999)), /no such task/);
  const draft = actions.startReview(db, task.id);
  assert.throws(() => actions.addReviewComment(db, draft.id, { ...comment, side: 'left' }), /side must be/);
  assert.throws(() => actions.addReviewComment(db, draft.id, { ...comment, line: 0 }), /line must be/);
  assert.throws(() => actions.addReviewComment(db, draft.id, { ...comment, body: '  ' }), /body/);
  assert.throws(() => actions.submitReview(db, draft.id, { kind: 'approve' }), /kind must be/);
  assert.throws(() => actions.resolveReviewComment(db, 999), /no such comment/);
});
