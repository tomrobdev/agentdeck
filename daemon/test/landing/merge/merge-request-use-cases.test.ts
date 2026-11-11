// Merge requests (docs/plans/merge-requests.html): recording one, and the daemon carrying it out on its PR refresh with a fake github adapter.
import assert from 'node:assert/strict';
import { asTaskId } from '#domain/shared/id.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-mergereq-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { doneTask, queuedTask, testApp } = await import('#test/fixtures/fixtures.ts');
const { github } = await import('#adapters/github/github.ts');
const { refreshPrStates } = await import('#application/landing/pull-request/refresh.ts');
const { autoMerge } = await import('#application/landing/merge/auto-merge.ts');
const {
  ActionError,
  cancelMergeRequest,
  fixChecks,
  linkTasks,
  mergePreview,
  requestMerge,
  requestMerges,
  retryTask,
  startReview,
  submitReview,
  taskDetail,
  updateRepo,
} = await import('#application/actions.ts');
type PrDetails = import('#domain/landing/merge/merge.ts').PrDetails;
type TaskId = import('#domain/shared/id.ts').TaskId;

const db = testApp(openDb(join(home, 'test.db')));
after(() => db.close());

const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
sh('init', '-q', '-b', 'main');
sh('config', 'user.email', 'test@example.com');
sh('config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
sh('add', '-A');
sh('commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'true' });

const ready: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 1,
  files: 1,
  additions: 10,
  deletions: 2,
  checks: { total: 2, failing: 0, pending: 0 },
  head: 'head-1',
  paths: ['src/a.ts'],
  labels: [],
};

let details: Record<string, PrDetails>;
let merged: { url: string; method: string }[];
let closedUrl: string | null = null;
github.prDetails = async (url) => ({ ...(details[url] ?? ready), state: url === closedUrl ? 'closed' : 'open' });
github.markReady = async () => {};
github.merge = async (pr) => void merged.push({ url: pr.url, method: pr.method });
github.deleteRemoteBranch = async () => {};

beforeEach(() => {
  details = {};
  merged = [];
  db.setPaused(false);
  updateRepo(db, 'demo', { auto_merge: false, pr_mode: 'ready' });
  for (const t of db.openPrTasks()) db.recordPr(t.id, { type: 'closed' });
});

let n = 0;
function tested() {
  const url = `https://x/pull/${++n}`;
  const t = doneTask(db, repo, { pr: 'open', url, branch: `agentdeck/req-${n}` });
  db.finishRun(db.startRun(t.id, 1, join(home, `run-${t.id}.log`)), { tests_passed: true });
  return { id: t.id, url };
}

const notified = (id: number) => db.recentNotifications(20).filter((x) => x.task_id === id);

test('requestMerge records the request with the task method, then the repo method; the preview says what it would do', async () => {
  const a = tested();
  assert.deepEqual(requestMerge(db, a.id), { method: 'squash' });
  const row = db.getTask(a.id)!;
  assert.ok(row.pr!.merge_request?.requested_at);
  assert.equal(row.pr!.merge_request?.method, 'squash');
  assert.equal(row.pr!.merge_request?.check, null);
  assert.ok(db.prCheckRequested() > 0, 'asks for a PR re-read');
  assert.equal((await taskDetail(db, a.id)).merge_request!.state, 'waiting');

  assert.deepEqual(requestMerge(db, a.id, { method: 'rebase' }), { method: 'rebase' });
  assert.equal(db.getTask(a.id)!.pr!.merge_request?.method, 'rebase');
  assert.throws(() => requestMerge(db, a.id, { method: 'fast-forward' }), ActionError);

  details[a.url] = { ...ready, checks: { total: 2, failing: 0, pending: 1 } };
  assert.deepEqual((await mergePreview(db, a.id)).request, { verdict: 'wait', reasons: ['1 check still running on GitHub'] });
});

test('requestMerge refuses a task that is not done or has no open PR', () => {
  const queued = queuedTask(db, repo);
  assert.throws(() => requestMerge(db, queued.id), /only a done task can be merged/);
  const noPr = doneTask(db, repo);
  assert.throws(() => requestMerge(db, noPr.id), /has no pull request/);
  const closed = doneTask(db, repo, { pr: 'closed' });
  assert.throws(() => requestMerge(db, closed.id), /PR is closed/);
  const merged = doneTask(db, repo, { pr: 'merged' });
  assert.throws(() => requestMerge(db, merged.id), /PR is merged/);
  assert.throws(() => requestMerge(db, asTaskId(99999)), ActionError);
  for (const t of [queued, noPr, closed, merged]) assert.equal(db.getTask(t.id)!.pr?.merge_request ?? null, null);
});

test('requestMerges returns the tasks it could not request, and why', () => {
  const a = tested();
  const noPr = doneTask(db, repo);
  const result = requestMerges(db, { ids: [a.id, noPr.id, a.id] });
  assert.deepEqual(result.requested, [a.id]);
  assert.deepEqual(result.failed, [{ id: noPr.id, reason: `#${noPr.id} has no pull request` }]);
});

test('cancelMergeRequest clears the request, and does nothing for a task without one', async () => {
  const a = tested();
  requestMerge(db, a.id);
  assert.deepEqual(cancelMergeRequest(db, a.id), { cancelled: true });
  const row = db.getTask(a.id)!;
  assert.equal(row.pr!.merge_request, null);
  assert.equal((await taskDetail(db, a.id)).merge_request, null);
  assert.deepEqual(cancelMergeRequest(db, a.id), { cancelled: false });
  assert.throws(() => cancelMergeRequest(db, asTaskId(99999)), ActionError);
});

test('a request with checks running waits, then merges once they pass, with its method', async () => {
  const a = tested();
  requestMerge(db, a.id, { method: 'rebase' });
  details[a.url] = { ...ready, checks: { total: 2, failing: 0, pending: 1 } };

  const first = await refreshPrStates(db);
  assert.deepEqual(first.mergeable, []);
  assert.equal(first.polling, 1, 'worth reading again soon');
  assert.deepEqual(db.getTask(a.id)!.pr!.merge_request?.check, {
    verdict: 'wait',
    reasons: [{ kind: 'checks_pending', text: '1 check still running on GitHub' }],
  });
  assert.deepEqual((await taskDetail(db, a.id)).merge_request, {
    state: 'waiting',
    method: 'rebase',
    reasons: ['1 check still running on GitHub'],
    since: db.getTask(a.id)!.pr!.merge_request!.requested_at,
  });

  details[a.url] = ready;
  const second = await refreshPrStates(db);
  assert.equal(second.polling, 0);
  assert.deepEqual(second.mergeable, [{ id: a.id, pr: ready, requested: true }]);
  assert.equal(await autoMerge(db, second.mergeable), a.id);
  assert.deepEqual(merged, [{ url: a.url, method: 'rebase' }]);
  const row = db.getTask(a.id)!;
  assert.equal(row.pr?.state, 'merged');
  assert.equal(row.pr?.merge_request, null, 'recordMerge clears the request');
  assert.equal(db.eventsForTask(a.id).at(-1)!.reason, 'requested (rebase)');
});

test('a request whose check fails is cleared with a notification', async () => {
  const a = tested();
  requestMerge(db, a.id);
  details[a.url] = { ...ready, checks: { total: 3, failing: 1, pending: 0 } };
  const found = await refreshPrStates(db);
  assert.deepEqual(found.mergeable, []);
  assert.equal(db.getTask(a.id)!.pr?.merge_request ?? null, null);
  const sent = notified(a.id);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, `Could not merge #${a.id}`);
  assert.equal(sent[0].body, '1 check failing on GitHub');
});

test('a request withdrawn while the refresh reads its failing PR is not told "Could not merge"', async () => {
  const a = tested();
  requestMerge(db, a.id);
  const read = github.prDetails;
  github.prDetails = async (url, cwd, opts) => {
    cancelMergeRequest(db, a.id);
    return { ...(await read(url, cwd, opts)), checks: { total: 3, failing: 1, pending: 0 } };
  };
  try {
    assert.deepEqual((await refreshPrStates(db)).mergeable, []);
  } finally {
    github.prDetails = read;
  }
  assert.equal(notified(a.id).length, 0);
});

test("a request over auto-merge's line limit, without its label, merges", async () => {
  updateRepo(db, 'demo', { auto_merge: true, auto_approve: false });
  const a = tested();
  const big = { ...ready, additions: 5000, deletions: 100 };
  details[a.url] = big;
  const auto = tested();
  details[auto.url] = big;

  assert.deepEqual((await refreshPrStates(db)).mergeable, []);
  requestMerge(db, a.id);
  const found = await refreshPrStates(db);
  assert.deepEqual(found.mergeable, [{ id: a.id, pr: big, requested: true }]);
  assert.equal(await autoMerge(db, found.mergeable), a.id);
  assert.deepEqual(merged, [{ url: a.url, method: 'squash' }]);
});

test('a request is ahead of auto-merges in the refresh', async () => {
  updateRepo(db, 'demo', { auto_merge: true, auto_approve: false });
  const auto = tested();
  details[auto.url] = { ...ready, labels: ['agentdeck:auto-merge'] };
  const asked = tested();
  requestMerge(db, asked.id);
  const found = await refreshPrStates(db);
  assert.deepEqual(
    found.mergeable.map((m) => m.id),
    [asked.id, auto.id],
  );
});

test('two requests where one lands after the other merge in that order', async () => {
  const first = tested();
  const second = tested();
  linkTasks(db, second.id, { on: first.id, kind: 'after' });
  requestMerge(db, second.id);
  requestMerge(db, first.id);

  const one = await refreshPrStates(db);
  assert.deepEqual(
    one.mergeable.map((m) => m.id),
    [first.id],
    'the second waits for the first',
  );
  assert.match(db.getTask(second.id)!.pr!.merge_request!.check!.reasons[0].text, new RegExp(`lands after #${first.id}`));
  assert.equal(await autoMerge(db, one.mergeable), first.id);

  const two = await refreshPrStates(db);
  assert.deepEqual(
    two.mergeable.map((m) => m.id),
    [second.id],
  );
  assert.equal(await autoMerge(db, two.mergeable), second.id);
  assert.deepEqual(
    merged.map((m) => m.url),
    [first.url, second.url],
  );
});

test('a conflicting request goes to be synced and stays; one whose task or PR moved on is cleared', async () => {
  const conflicting = tested();
  requestMerge(db, conflicting.id);
  details[conflicting.url] = { ...ready, mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  const found = await refreshPrStates(db);
  assert.deepEqual(found.conflicting, [conflicting.id]);
  assert.ok(db.getTask(conflicting.id)!.pr!.merge_request, 'a conflict is waited out, not refused');

  db.applyEvent(conflicting.id, { type: 'conflict' }, { reason: 'conflict' });
  await refreshPrStates(db);
  assert.equal(db.getTask(conflicting.id)!.pr?.merge_request ?? null, null);

  const closedOnGithub = tested();
  requestMerge(db, closedOnGithub.id);
  closedUrl = closedOnGithub.url;
  try {
    await refreshPrStates(db);
  } finally {
    closedUrl = null;
  }
  assert.equal(db.getTask(closedOnGithub.id)!.pr?.merge_request ?? null, null);
});

test('a merge request is dropped when the task is sent back: retry, request changes, fix checks', async () => {
  const sendBack: [string, (id: TaskId) => unknown][] = [
    ['retry', (id) => retryTask(db, id)],
    [
      'request changes',
      (id) => {
        const draft = startReview(db, id);
        return submitReview(db, draft.id, { kind: 'request_changes', body: 'Rename it' });
      },
    ],
    ['fix checks', (id) => fixChecks(db, id)],
  ];
  for (const [name, send] of sendBack) {
    const a = tested();
    requestMerge(db, a.id);
    details[a.url] = {
      ...ready,
      checks: { total: 1, failing: 1, pending: 0 },
      check_list: [{ name: 'test', state: 'fail', url: null, started_at: null, completed_at: null }],
    };
    await send(a.id);
    const row = db.getTask(a.id)!;
    assert.equal(row.status, 'queued', name);
    assert.equal(row.pr?.state, 'open', `${name}: the open PR stays, for the next push to update`);
    assert.equal(row.pr?.merge_request, null, `${name}: the request goes in the same write`);

    assert.ok(db.applyEvent(a.id, { type: 'claim' }));
    assert.ok(db.applyEvent(a.id, { type: 'finish', outcome: 'done' }));
    details[a.url] = ready;
    assert.deepEqual((await refreshPrStates(db)).mergeable, [], name);
  }
});

test('a merge gh refuses drops the request and tells once', async () => {
  const a = tested();
  requestMerge(db, a.id);
  const found = await refreshPrStates(db);
  const real = github.merge;
  github.merge = async () => {
    throw new Error('base branch policy prohibits the merge');
  };
  try {
    assert.equal(await autoMerge(db, found.mergeable), null);
  } finally {
    github.merge = real;
  }
  assert.equal(db.getTask(a.id)!.pr?.merge_request ?? null, null);
  assert.equal(db.getTask(a.id)!.pr?.state, 'open');
  assert.match(notified(a.id)[0].body, /base branch policy/);
});
