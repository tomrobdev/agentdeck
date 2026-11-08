// The review run in the daemon: when one may start (reviewable), what follows its answer (reviewOutcome), and the whole
// of it with fake claude: a clean answer stores a review with nothing blocking, a blocking one retries the task with the
// review as its note but only once, a garbage one leaves no review and no second run, and a sync that only brings in
// the base starts no second one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { RunKind, RunOutcome } from '../src/domain/runs/run.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-review-run-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { nextReviewable, runReview } = await import('../src/application/runs/review.ts');
const { syncNow, updateRepo } = await import('../src/application/actions.ts');
const { restartWait } = await import('../src/domain/operations/restart.ts');
const { REVIEW_NOTE, reviewOutcome, reviewable } = await import('../src/domain/runs/review.ts');
const { buildPrompt } = await import('../src/domain/runs/prompt.ts');
const { runLabel } = await import('../src/domain/runs/run.ts');
const { REVIEW_PROMPT_INTRO } = await import('../src/domain/landing/address.ts');
const { doneTask, testApp, waitFor } = await import('./fixtures.ts');
const { fakeCodeHost } = await import('./fakes.ts');

// ---- reviewable and reviewOutcome, pure

const ON = { auto_review: true };
const DONE = { status: 'done' as const, pr: { state: 'open' as const } } as never;
const run = (diff_hash: string | null, outcome: RunOutcome | null = 'done', kind: RunKind = 'review') => ({ kind, diff_hash, outcome });

test('reviewable: a done task with an open PR, in a repo with auto_review on, once per diff', () => {
  assert.equal(reviewable(DONE, [], ON, 'h1'), true);
  assert.equal(reviewable(DONE, [], { auto_review: false }, 'h1'), false, 'auto_review off');
  assert.equal(reviewable({ status: 'queued', pr: null } as never, [], ON, 'h1'), false, 'not done');
  assert.equal(reviewable({ status: 'done', pr: null } as never, [], ON, 'h1'), false, 'no PR');
  assert.equal(reviewable({ status: 'done', pr: { state: 'merged' } } as never, [], ON, 'h1'), false, 'the PR merged');
  assert.equal(reviewable(DONE, [], ON, null), false, 'no changes to read');
  assert.equal(reviewable(DONE, [run('h1')], ON, 'h1'), false, 'these changes had one');
  assert.equal(reviewable(DONE, [run('h1', null)], ON, 'h1'), false, 'one is still going');
  assert.equal(reviewable(DONE, [run('h1', 'failed')], ON, 'h1'), false, 'a failed or garbage one counts');
  assert.equal(reviewable(DONE, [run('h1', 'rate_limited')], ON, 'h1'), true, 'a rate limit stopped it before it answered');
  assert.equal(reviewable(DONE, [run('h1', 'interrupted')], ON, 'h1'), true, 'a restart stopped it before it answered');
  assert.equal(reviewable(DONE, [run('h1')], ON, 'h2'), true, 'new changes get their own');
  assert.equal(reviewable(DONE, [run('h1', 'done', 'work')], ON, 'h1'), true, 'a work run is not one');
});

test('reviewOutcome: a clean answer retries nothing; a blocking one retries once per task', () => {
  const clean = reviewOutcome({ summary: 'Fine.', findings: [{ path: 'a.ts', line: 1, side: 'new', body: 'nit', blocking: false }] }, []);
  assert.equal(clean.record.kind, 'comment');
  assert.equal(clean.retry, null);

  const answer = { summary: 'Broken.', findings: [{ path: 'a.ts', line: 3, side: 'new' as const, body: 'off by one', blocking: true }] };
  const first = reviewOutcome(answer, [{ type: 'created' }, { type: 'claim' }, { type: 'finish' }]);
  assert.equal(first.record.kind, 'request_changes');
  assert.equal(first.retry, `${REVIEW_NOTE}Broken.\n\n- a.ts:3: Blocking: off by one`);
  const again = reviewOutcome(answer, [{ type: 'review_retry' }]);
  assert.equal(again.record.kind, 'request_changes', 'it is still stored as Request changes');
  assert.equal(again.retry, null, 'a review run retried it before: it waits for a person');
  assert.equal(reviewOutcome(answer, [{ type: 'retry' }]).retry !== null, true, "a person's retry is not a review run's");
});

test("buildPrompt: a review run's note names itself, as an unblock run's does", () => {
  const task = { id: 1, prompt: 'Do it.', attempts: 2 } as never;
  const prev = [{ kind: 'work', outcome: 'done', attempt: 1, result_text: 'Did it.', tests_passed: true }] as never;
  const prompt = buildPrompt(task, prev, `${REVIEW_NOTE}Broken.`);
  assert.ok(prompt.startsWith(`${REVIEW_NOTE}Broken.`));
  assert.ok(!prompt.includes('Changes requested in review:'));
});

test('restartWait counts review runs', () => {
  assert.equal(restartWait({ tasks: 0, planner: 0, resolves: 0, reviews: 2 }), '2 review runs');
});

// ---- with fake claude

const db = testApp(openDb(join(home, 'test.db')), { codeHost: fakeCodeHost() });
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let repos = 0;
/** A git repo of its own for each test, opening draft PRs, with auto_review as given. */
function makeRepo(autoReview: boolean) {
  const name = `demo-${++repos}`;
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), 'A demo.\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  const repo = db.addRepo({ name, path: dir, base_branch: 'main' });
  updateRepo(db, name, { pr_mode: 'draft', auto_review: autoReview });
  return { ...repo, path: dir };
}
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
const fakeArgs = (): string[][] =>
  readFileSync(join(home, 'fake-claude-args.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
/** The values after `flag` in a claude argv, up to the next flag. */
const flagValues = (args: string[], flag: string): string[] => {
  const from = args.indexOf(flag) + 1;
  const end = args.findIndex((a, i) => i >= from && a.startsWith('--'));
  return args.slice(from, end === -1 ? undefined : end);
};

test('a clean answer stores a submitted review by the review run with no blocking comment, and the task stays done', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'clean', prompt: '## Goal\nFAKE_DONE write the output' });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  assert.equal(t.pr?.state, 'open');
  const runs = db.runsForTask(task.id);
  assert.deepEqual(
    runs.map((r) => [r.kind, r.outcome]),
    [
      ['work', 'done'],
      ['review', 'done'],
    ],
  );
  const review = runs[1];
  assert.equal(runLabel(review), 'Review', 'the run list names it Review');
  assert.equal(review.attempt, 1, 'it ran beside attempt 1 and used none');
  assert.equal(t.attempts, 1);
  assert.equal(review.model, 'opus', 'the review model');
  assert.ok(review.pid, 'its pid is recorded');
  assert.ok(review.diff_hash, 'the diff it read is on its row');
  assert.equal(db.slotsUsed(), 0);

  const [stored] = db.reviewsForTask(task.id);
  assert.equal(stored.by, 'review_run');
  assert.equal(stored.kind, 'comment');
  assert.equal(stored.body, 'It does what the task asks.');
  assert.ok(stored.submitted_at, 'submitted, never a draft');
  assert.equal(stored.diff_hash, review.diff_hash);
  assert.equal(stored.head_commit, sh(repo.path, 'rev-parse', t.checkout!.branch!));
  assert.deepEqual(stored.comments, []);
  assert.equal(db.draftReviewFor(task.id), undefined, "a person's draft is neither taken nor made");

  // Its own prompt, turns, schema and read-only tools; Edit, Write and NotebookEdit denied outright.
  const args = fakeArgs().find((a) => a[a.indexOf('-p') + 1].startsWith(`AgentDeck review run for task #${task.id}`))!;
  assert.equal(args[args.indexOf('--max-turns') + 1], '30');
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /AgentDeck review run/);
  assert.ok(args.includes('--json-schema'));
  assert.deepEqual(flagValues(args, '--allowedTools'), ['Read', 'Grep', 'Glob', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)']);
  const denied = flagValues(args, '--disallowedTools');
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash(git push*)']) assert.ok(denied.includes(tool), tool);

  // Nothing changed since: the next tick starts no second one.
  assert.equal(await nextReviewable(db), undefined);
  await drain();
  assert.equal(db.runsForTask(task.id).length, 2);
});

test('a sync that only brings in the base starts no second review run', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'synced', prompt: 'FAKE_DONE write the output' });
  await drain();
  const before = db.getTask(task.id)!;
  assert.equal(db.runsForTask(task.id).filter((r) => r.kind === 'review').length, 1);
  const headBefore = sh(repo.path, 'rev-parse', before.checkout!.branch!);

  writeFileSync(join(repo.path, 'other.txt'), 'from main\n');
  sh(repo.path, 'add', '-A');
  sh(repo.path, 'commit', '-q', '-m', 'main moves on');
  const synced = await syncNow(db, task.id);
  assert.equal(synced.outcome, 'clean');
  assert.notEqual(sh(repo.path, 'rev-parse', before.checkout!.branch!), headBefore, 'the branch moved');

  assert.equal(await nextReviewable(db), undefined, 'the same changes, the same patch-id');
  await drain();
  assert.equal(db.runsForTask(task.id).filter((r) => r.kind === 'review').length, 1);
});

test('a blocking answer retries the task with the review as its note; a second blocking one does not retry', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'blocks', prompt: 'FAKE_DONE FAKE_REVIEW_BLOCK write it', max_attempts: 3 });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done', 'the second review leaves it in review for a person');
  assert.deepEqual(
    db.runsForTask(task.id).map((r) => [r.kind, r.attempt]),
    [
      ['work', 1],
      ['review', 1],
      ['work', 2],
      ['review', 2],
    ],
  );
  assert.equal(t.attempts, 2);
  assert.equal(t.max_attempts, 2, 'the retry gave one attempt on top of those used, as a person’s does');

  const retries = db.eventsForTask(task.id).filter((e) => e.type === 'review_retry');
  assert.equal(retries.length, 1, 'only once per task');
  assert.ok(retries[0].reason!.startsWith(`${REVIEW_NOTE}It writes the file, but leaves it unchecked.`));

  const reviews = db.reviewsForTask(task.id);
  assert.deepEqual(
    reviews.map((r) => [r.by, r.kind]),
    [
      ['review_run', 'request_changes'],
      ['review_run', 'request_changes'],
    ],
  );
  assert.ok(reviews[0].submitted_at! >= retries[0].at, 'submitted at or after its retry, so the retry is its own');
  assert.deepEqual(
    reviews[0].comments.map((c) => [c.path, c.line, c.side, c.body]),
    [
      ['fake-output.txt', 1, 'new', 'Blocking: Nothing checks this line'],
      ['fake-output.txt', 1, 'new', 'A clearer name would help'],
    ],
  );
  assert.equal(reviews[0].comments[0].head_commit, reviews[0].head_commit);
  assert.notEqual(reviews[0].diff_hash, reviews[1].diff_hash, 'the second read the new changes');

  // The second work run got the review comment by comment, once: not its note again under it.
  const second = fakeArgs()
    .map((a) => a[a.indexOf('-p') + 1])
    .filter((p) => p.includes('FAKE_REVIEW_BLOCK write it') && !p.startsWith('AgentDeck'))
    .at(-1)!;
  assert.ok(second.startsWith(REVIEW_PROMPT_INTRO));
  assert.ok(second.includes('c1 — fake-output.txt:1'));
  assert.ok(!second.includes(REVIEW_NOTE), 'the note is the review block itself');
});

test('a garbage answer leaves no review, and the same changes get no second review run', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'garbage', prompt: 'FAKE_DONE FAKE_REVIEW_GARBAGE write it' });
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'done');
  assert.deepEqual(
    db.runsForTask(task.id).map((r) => [r.kind, r.outcome]),
    [
      ['work', 'done'],
      ['review', 'failed'],
    ],
  );
  assert.deepEqual(db.reviewsForTask(task.id), []);
  await drain();
  assert.equal(db.runsForTask(task.id).length, 2);
});

test('a review run that fails leaves no review, and the same changes get no second one', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'fails', prompt: 'FAKE_DONE FAKE_REVIEW_FAIL write it' });
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'done');
  assert.deepEqual(
    db.runsForTask(task.id).map((r) => [r.kind, r.outcome]),
    [
      ['work', 'done'],
      ['review', 'failed'],
    ],
  );
  assert.deepEqual(db.reviewsForTask(task.id), []);
  assert.equal(await nextReviewable(db), undefined);
});

test('a review run stops when the task is no longer done, and stores nothing', async () => {
  const repo = makeRepo(false);
  const task = db.addTask({ repo_id: repo.id, title: 'slow', prompt: 'FAKE_DONE FAKE_REVIEW_SLOW write it' });
  await drain();
  updateRepo(db, repo.name, { auto_review: true });
  const target = (await nextReviewable(db))!;
  const running = runReview(db, target);
  await waitFor(() => db.runsForTask(task.id).find((r) => r.kind === 'review')?.pid, { what: 'the review run to start' });
  assert.equal(db.countRunningReviews(), 1);
  assert.ok(db.applyEvent(task.id, { type: 'retry' }), 'a person retries it');
  assert.equal(db.claimNextTask(), undefined, 'the retried task waits for its review run to end');
  assert.deepEqual(await running, { outcome: 'cancelled' });
  assert.equal(db.runsForTask(task.id).find((r) => r.kind === 'review')!.outcome, 'cancelled');
  assert.equal(db.countRunningReviews(), 0);
  assert.deepEqual(db.reviewsForTask(task.id), []);

  assert.deepEqual(await runReview(db, target), { outcome: 'stale' }, 'not done any more: nothing starts');
  assert.ok(db.applyEvent(task.id, { type: 'cancel' }));
});

test('a done task with an open PR but no branch is passed over', async () => {
  const repo = makeRepo(true);
  const task = doneTask(db, repo, { pr: 'open' });
  assert.equal(
    db.reviewCandidates().some((t) => t.id === task.id),
    true,
  );
  assert.equal(await nextReviewable(db), undefined);
});

test('auto_review off starts none; a second start for the same changes, while the first is set up, starts nothing', async () => {
  const repo = makeRepo(false);
  const task = db.addTask({ repo_id: repo.id, title: 'off', prompt: 'FAKE_DONE write it' });
  await drain();
  assert.deepEqual(
    db.runsForTask(task.id).map((r) => r.kind),
    ['work'],
  );
  assert.equal(await nextReviewable(db), undefined);

  updateRepo(db, repo.name, { auto_review: true });
  const target = (await nextReviewable(db))!;
  assert.equal(target.task.id, task.id);
  const [first, second] = await Promise.all([runReview(db, target), runReview(db, target)]);
  assert.equal(first.outcome, 'clean');
  assert.equal(second.outcome, 'stale');
  assert.equal(db.runsForTask(task.id).filter((r) => r.kind === 'review').length, 1);
  assert.equal(db.reviewsForTask(task.id).length, 1);
});
