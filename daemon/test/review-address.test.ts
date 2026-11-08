// A run addressing a review: how the prompt shows the comments, how the answers are read, and a run that answers them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  REVIEW_PROMPT_BUDGET,
  hunkAround,
  isReviewRetry,
  matchAnswers,
  parseAnswers,
  reviewPromptBlock,
  unansweredNote,
  withNote,
} from '../src/domain/landing/address.ts';
import { buildPrompt, workerSystemPrompt } from '../src/domain/runs/prompt.ts';
import type { Task } from '../src/domain/work/task.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-review-address-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('./open-db.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const actions = await import('../src/application/actions.ts');

const patchA = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,5 +1,6 @@',
  ' one',
  ' two',
  '-three',
  '+THREE',
  '+three and a half',
  ' four',
  ' five',
].join('\n');

test('hunkAround keeps a few lines either side, on the side the comment counts on', () => {
  // new line 4 is "three and a half"
  assert.equal(hunkAround(patchA, 'new', 4, 1), ['@@ -1,5 +1,6 @@', '+THREE', '+three and a half', ' four'].join('\n'));
  // old line 3 is the removed "three"
  assert.equal(hunkAround(patchA, 'old', 3, 1), ['@@ -1,5 +1,6 @@', ' two', '-three', '+THREE'].join('\n'));
  assert.equal(hunkAround(patchA, 'new', 40), null);
  assert.equal(hunkAround('', 'new', 1), null);
});

test('the prompt renders two comments in two files with id, location, hunk and comment, then the note', () => {
  const block = reviewPromptBlock({
    note: 'Mostly fine.',
    comments: [
      { comment: { path: 'src/a.ts', line: 4, side: 'new', body: 'why the half?' }, hunk: hunkAround(patchA, 'new', 4, 1) },
      { comment: { path: 'src/b.ts', line: 9, side: 'old', body: 'keep this' }, hunk: '@@ -8,3 +8,2 @@\n x\n-y' },
    ],
  });
  const lines = block.split('\n');
  assert.match(block, /^Changes requested in review\./);
  assert.match(block, /ANSWER c1:/);
  assert.ok(lines.includes('c1 — src/a.ts:4'));
  assert.ok(lines.includes('c2 — src/b.ts:9 (old)'));
  assert.ok(lines.includes('+three and a half'));
  assert.ok(lines.includes('-y'));
  assert.ok(lines.includes('Comment: why the half?'));
  assert.ok(lines.includes('Comment: keep this'));
  assert.ok(block.indexOf('c1 —') < block.indexOf('c2 —'));
  assert.ok(block.indexOf('c2 —') < block.indexOf('Overall note:'));
  assert.ok(block.endsWith('Mostly fine.'));
  assert.doesNotMatch(block, /too long/);
});

test('a long review is cut to the budget and says so', () => {
  const comments = Array.from({ length: 12 }, (_, i) => ({
    comment: { path: `f${i}.ts`, line: 1, side: 'new' as const, body: 'x'.repeat(5000) },
    hunk: '@@ -1 +1 @@\n+' + 'y'.repeat(150),
  }));
  const block = reviewPromptBlock({ note: 'n', comments });
  assert.ok(block.length < REVIEW_PROMPT_BUDGET + 1500, `${block.length} chars`);
  assert.match(block, /too long for the prompt/);
  assert.match(block, /the diff of \d+ comments/);
  assert.match(block, /cut short/);
  for (let i = 1; i <= 12; i++) assert.match(block, new RegExp(`^c${i} — f${i - 1}\\.ts:1$`, 'm'));
});

test('buildPrompt puts the review first and the system prompt asks for ANSWER lines', () => {
  const task = { prompt: 'do it', attempts: 2 } as Task;
  const prompt = buildPrompt(task, [{ kind: 'work', outcome: 'done', tests_passed: 1, result_text: 'ok' } as never], 'flat note', null, {
    note: 'n',
    comments: [{ comment: { path: 'a.ts', line: 1, side: 'new', body: 'b' }, hunk: null }],
  });
  assert.ok(prompt.startsWith('Changes requested in review.'));
  assert.ok(prompt.indexOf('c1 — a.ts:1') < prompt.indexOf('do it'));
  assert.match(workerSystemPrompt(null), /ANSWER c1: /);
});

test("the review replaces the retry note only when it is the review's own retry", () => {
  const task = { prompt: 'do it', attempts: 2 } as Task;
  const runs = [{ kind: 'work', outcome: 'done', tests_passed: 1, result_text: 'ok' } as never];
  const comments = [{ comment: { path: 'a.ts', line: 1, side: 'new' as const, body: 'b' }, hunk: null }];
  const own = buildPrompt(task, runs, 'flat note', null, { note: 'n', comments, ownRetry: true });
  assert.doesNotMatch(own, /flat note/);
  const later = buildPrompt(task, runs, 'CI logs: lint failed', null, { note: 'n', comments, ownRetry: false });
  assert.ok(later.startsWith('Changes requested in review.'));
  assert.equal(later.match(/lint failed/g)?.length, 1);
  assert.ok(later.indexOf('c1 — a.ts:1') < later.indexOf('lint failed'));
  assert.ok(later.indexOf('lint failed') < later.indexOf('do it'));
});

test('isReviewRetry: the latest request was submitted at or after the latest retry', () => {
  const review = (submitted_at: string | null, kind = 'request_changes') => ({ kind, submitted_at, comments: [] }) as never;
  const cases: [string, unknown[], string | null, boolean][] = [
    ['same second', [review('2026-11-08 10:00:00')], '2026-11-08 10:00:00', true],
    ['a later retry', [review('2026-11-08 10:00:00')], '2026-11-08 10:05:00', false],
    ['no retry', [review('2026-11-08 10:00:00')], null, false],
    ['a draft', [review(null)], '2026-11-08 10:00:00', false],
    ['a comment review', [review('2026-11-08 10:00:00', 'comment')], '2026-11-08 10:00:00', false],
  ];
  for (const [name, reviews, retryAt, want] of cases) assert.equal(isReviewRetry(reviews as never, retryAt), want, name);
});

test('parseAnswers reads ANSWER lines and a missing one stays unanswered', () => {
  const text = ['Fixed the lot.', 'ANSWER c1: renamed it', 'answer C3 : kept, it is used by the CLI', 'ANSWER c4:', 'STATUS: DONE'].join(
    '\n',
  );
  assert.deepEqual(
    [...parseAnswers(text)],
    [
      ['c1', 'renamed it'],
      ['c3', 'kept, it is used by the CLI'],
    ],
  );
  const { answered, unanswered } = matchAnswers(['a', 'b', 'c'], text);
  assert.deepEqual(
    answered.map((x) => [x.comment, x.answer]),
    [
      ['a', 'renamed it'],
      ['c', 'kept, it is used by the CLI'],
    ],
  );
  assert.deepEqual(
    unanswered.map((x) => x.comment),
    ['b'],
  );
  const note = unansweredNote([{ comment: { path: 'b.ts', line: 7, side: 'new' }, index: 1 }]);
  assert.equal(note, 'Review comments left open, with no answer: c2 (b.ts:7).');
  assert.equal(withNote(text, note).split('\n').at(-1), 'STATUS: DONE');
  assert.match(withNote(text, note), /no answer: c2[^\n]*\nSTATUS: DONE$/);
});

// --- a run that answers ---

const repoPath = join(home, 'demo');
const db = openDb(join(home, 'test.db'));
const sh = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

test('a run whose final message answers the comments moves them to answered; the rest stay open and are named', async () => {
  execFileSync('mkdir', ['-p', repoPath]);
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'test');
  writeFileSync(join(repoPath, 'README.md'), 'demo\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'init');
  const repo = db.addRepo({ name: 'demo', path: repoPath, base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 'make output', prompt: 'FAKE_ANSWER please' });
  await drain();
  const done = db.getTask(task.id)!;
  assert.equal(done.status, 'done');
  const head = sh('rev-parse', done.checkout!.branch!);

  const review = (comments: { path: string; line: number; body: string }[]) => {
    const draft = actions.startReview(db, task.id);
    for (const c of comments) actions.addReviewComment(db, draft.id, { ...c, side: 'new', head_commit: head });
    return actions.submitReview(db, draft.id, { kind: 'request_changes', body: 'Please fix.' });
  };

  const first = await review([
    { path: 'fake-output.txt', line: 1, body: 'reword this' },
    { path: 'README.md', line: 1, body: 'and this' },
  ]);
  assert.equal(first.head_commit, head, 'a submitted review records the head it read');
  assert.match(first.diff_hash ?? '', /^[0-9a-f]{40}$/, "and the patch-id of the task's changes");
  assert.equal(db.getTask(task.id)!.status, 'queued');
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'done');
  const prompts = readFileSync(join(home, 'fake-claude-calls.log'), 'utf8');
  assert.match(prompts, /^c1 — fake-output\.txt:1$/m);
  assert.match(prompts, /^c2 — README\.md:1$/m);
  assert.match(prompts, /^\+done by fake claude/m, 'the hunk of the commented line is in the prompt');
  assert.match(prompts, /Comment: reword this/);
  const after = actions.taskReviews(db, task.id).find((r) => r.id === first.id)!;
  assert.deepEqual(
    after.comments.map((c) => [c.state, c.answer]),
    [
      ['answered', 'handled c1'],
      ['answered', 'handled c2'],
    ],
  );

  // A second review whose run answers only c1: c2 stays open and the run's summary names it.
  const second = await review([
    { path: 'fake-output.txt', line: 1, body: 'once more FAKE_ANSWER_FIRST' },
    { path: 'README.md', line: 1, body: 'again' },
  ]);
  await drain();
  const comments = actions.taskReviews(db, task.id).find((r) => r.id === second.id)!.comments;
  assert.deepEqual(
    comments.map((c) => [c.state, c.answer]),
    [
      ['answered', 'handled c1'],
      ['open', null],
    ],
  );
  const lastRun = db
    .runsForTask(task.id)
    .filter((r) => r.kind === 'work')
    .at(-1)!;
  assert.match(lastRun.result_text ?? '', /left open, with no answer: c2 \(README\.md:1\)\.\nSTATUS: DONE$/);
  db.close();
});
