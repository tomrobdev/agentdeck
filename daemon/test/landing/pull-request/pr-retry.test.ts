import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeCodeHost } from '../../fixtures/fakes.ts';
import { doneTask, testApp } from '../../fixtures/fixtures.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-pr-retry-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../../src/db/index.ts');
const { followUpPending } = await import('../../../src/application/landing/settle.ts');
const { retryFailedPrs } = await import('../../../src/application/landing/pull-request/open-pr.ts');
const { ActionError, openTaskPr, taskDetail } = await import('../../../src/application/actions.ts');
const { PR_OPEN_RETRIES, prRetry } = await import('../../../src/domain/landing/index.ts');
const { prOpenFailures } = await import('../../../src/domain/work/lifecycle/history.ts');
const { canOpenPr, stageOf, statusGroup } = await import('../../../src/domain/work/task/stage.ts');

const MIN = 60_000;

function setup(failures: number) {
  const codeHost = fakeCodeHost();
  let tries = 0;
  const create = codeHost.createPr;
  codeHost.createPr = async (pr) => {
    if (++tries <= failures) throw new Error(`gh: HTTP 502 (try ${tries})`);
    return create(pr);
  };
  const db = testApp(openDb(':memory:'), { codeHost });
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  const finishedDone = async () => {
    const task = db.addTask({ repo_id: repo.id, title: 'work', prompt: 'p' });
    assert.equal(db.claimNextTask()?.id, task.id);
    db.setCheckout(task.id, { branch: `agentdeck/task-${task.id}` });
    assert.ok(db.applyEvent(task.id, { type: 'finish', outcome: 'done' }));
    assert.equal(await followUpPending(db), 1);
    return task.id;
  };
  return { db, repo, codeHost, tries: () => tries, finishedDone };
}

test('a PR whose pr create fails twice is open on the third tick of the PR refresh, each retry after its wait', async () => {
  const { db, codeHost, tries, finishedDone } = setup(2);
  const id = await finishedDone();
  assert.equal(db.getTask(id)!.pr?.state, 'failed', 'the open when it finished failed');
  const start = Date.now();
  const logs: string[] = [];
  const tick = (after: number) => retryFailedPrs(db, (m) => logs.push(m), start + after);

  assert.equal(await tick(1 * MIN), 0, 'tick 1: the first wait (3 minutes) is not over');
  assert.equal(tries(), 1);
  assert.equal((await taskDetail(db, id)).pr_retry?.state, 'wait');

  assert.equal(await tick(4 * MIN), 0, 'tick 2: due, and pr create fails again');
  assert.equal(tries(), 2);
  assert.equal(db.getTask(id)!.pr?.state, 'failed');
  assert.match(logs.at(-1)!, /could not open the PR again: gh: HTTP 502 \(try 2\)/);
  assert.equal(await tick(5 * MIN), 0, 'the second wait is twice the first');
  assert.equal(tries(), 2);

  assert.equal(await tick(11 * MIN), 1, 'tick 3: opened');
  assert.equal(tries(), 3);
  const t = db.getTask(id)!;
  assert.equal(t.status, 'done');
  assert.deepEqual([t.pr?.state, t.pr?.url], ['open', 'https://example.test/pull/1']);
  assert.equal(codeHost.created.length, 1);
  assert.match(logs.at(-1)!, /PR opened after 2 failed tries/);
  assert.equal((await taskDetail(db, id)).pr_retry, null);

  assert.equal(await tick(60 * MIN), 0, 'an open PR is not opened again');
  assert.equal(tries(), 3);
  db.close();
});

test(`after ${PR_OPEN_RETRIES} retries a person is told the last error, and opens the PR with open-pr`, async () => {
  const { db, codeHost, tries, finishedDone } = setup(Infinity);
  const id = await finishedDone();
  const start = Date.now();
  for (let i = 1; i <= PR_OPEN_RETRIES; i++) await retryFailedPrs(db, () => {}, start + i * 24 * 60 * MIN);
  assert.equal(tries(), PR_OPEN_RETRIES + 1);
  await retryFailedPrs(db, () => {}, start + 365 * 24 * 60 * MIN);
  assert.equal(tries(), PR_OPEN_RETRIES + 1, 'no more retries once they are used up');

  const told = db.recentNotifications(50).filter((n) => n.task_id === id && n.title === `Could not open the PR of #${id}`);
  assert.equal(told.length, 1);
  assert.match(told[0].body, /6 tries failed on work: gh: HTTP 502 \(try 6\)\. Open it with agentdeck open-pr \d+\./);

  const detail = await taskDetail(db, id);
  assert.deepEqual([detail.pr_retry?.state, detail.pr_retry?.failures, detail.pr_retry?.error], ['person', 6, 'gh: HTTP 502 (try 6)']);
  assert.equal(statusGroup(stageOf(detail)), 'needs-you');
  assert.ok(canOpenPr(stageOf(detail)), 'the dashboard offers Open PR');

  await assert.rejects(openTaskPr(db, id), /could not open the PR: gh: HTTP 502 \(try 7\)/);
  codeHost.createPr = async () => 'https://example.test/pull/9';
  assert.deepEqual(await openTaskPr(db, id), { url: 'https://example.test/pull/9' });
  const after = await taskDetail(db, id);
  assert.deepEqual([after.pr?.state, after.pr_retry, statusGroup(stageOf(after))], ['open', null, 'review']);
  assert.ok(!canOpenPr(stageOf(after)));
  db.close();
});

test('open-pr is refused for a task that is not done, an open PR, and a repo with its PR mode off', async () => {
  const { db, repo, finishedDone } = setup(0);
  const open = await finishedDone();
  await assert.rejects(openTaskPr(db, open), (e) => e instanceof ActionError && /PR is open already/.test(e.message));
  const queued = db.addTask({ repo_id: repo.id, title: 'later', prompt: 'p' });
  await assert.rejects(openTaskPr(db, queued.id), /is queued; only a done task's PR can be opened/);
  const failed = doneTask(db, repo, { pr: 'failed', branch: 'agentdeck/x' });
  db.updateRepo(repo.id, { pr_mode: 'off' });
  await assert.rejects(openTaskPr(db, failed.id), /PR mode is off/);
  assert.equal((await taskDetail(db, failed.id)).pr_retry, null, 'a repo with its PR mode off retries nothing');
  db.close();
});

test('prRetry: the first retry waits 3 minutes, each after twice the last, and then a person must open it', () => {
  const at = '2026-11-08 12:00:00';
  const t0 = Date.parse('2026-11-08T12:00:00Z');
  const waits = [3, 6, 12, 24, 48];
  waits.forEach((wait, retries) => {
    const failures = { count: retries + 1, error: 'boom', at };
    assert.equal(prRetry(failures, t0 + wait * MIN - 1000).state, 'wait');
    assert.deepEqual(prRetry(failures, t0 + wait * MIN), {
      state: 'due',
      failures: retries + 1,
      error: 'boom',
      next_at: new Date(t0 + wait * MIN).toISOString().slice(0, 19).replace('T', ' '),
    });
  });
  assert.deepEqual(prRetry({ count: PR_OPEN_RETRIES + 1, error: 'boom', at }, t0), {
    state: 'person',
    failures: 6,
    error: 'boom',
    next_at: null,
  });
});

test('prRetry: a failure at a time that cannot be read is due at once', () => {
  assert.deepEqual(prRetry({ count: 1, error: 'boom', at: 'not a time' }, Date.parse('2026-11-08T12:00:00Z')), {
    state: 'due',
    failures: 1,
    error: 'boom',
    next_at: null,
  });
});

test('prOpenFailures counts the failures since the task last finished, and an opened PR starts the count again', () => {
  const row = (type: string, reason: string | null, from = 'done', to = 'done', at = '2026-11-08 12:00:00') => ({
    type: type as 'pr',
    from_status: from as 'done',
    to_status: to as 'done',
    reason,
    at,
  });
  const fail = (e: string, at?: string) => row('pr', `could not open the PR: ${e}`, 'done', 'done', at);
  assert.equal(prOpenFailures([]), null);
  assert.deepEqual(prOpenFailures([row('finish', null, 'running'), fail('a'), fail('b', '2026-11-08 12:03:00')]), {
    count: 2,
    error: 'b',
    at: '2026-11-08 12:03:00',
  });
  assert.equal(prOpenFailures([fail('a'), row('retry', null, 'done', 'queued'), row('finish', null, 'running')]), null);
  assert.equal(prOpenFailures([fail('a'), row('pr', 'opened https://x/1'), row('pr', 'closed without merging')]), null);
  assert.equal(prOpenFailures([fail('a'), row('pr', 'opened https://x/1'), fail('c')])?.count, 1);
});
