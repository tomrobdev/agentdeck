// A second test for each landing use case a single test file named before: fixChecks, requestAllMerges, closeTaskPr,
// requestMerges, cancelMergeRequest and markDone. Real SQLite and git, the fake code host (fakes.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import { READY_PR, fakeAgent, fakeCodeHost } from './fakes.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-landing-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { asTaskId, blockedTask, doneTask, failedTask, queuedTask, testApp } = await import('./fixtures.ts');
const { refreshPrStates } = await import('../src/application/landing/refresh.ts');
const actions = await import('../src/application/actions.ts');
const { ActionError, cancelMergeRequest, closeTaskPr, fixChecks, linkTasks, markDone, requestAllMerges, requestMerges, taskDetail } =
  actions;
const { latestReviewNote } = await import('../src/domain/work/history.ts');
const { parseJobSteps } = await import('../src/domain/landing/index.ts');
const { fmtChecks } = await import('../src/cli/format.ts');
/** #246's failed CI, as `gh` gave it (2026-11-08). */
const ghFixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gh', name), 'utf8');

const host = fakeCodeHost();
const db = testApp(openDb(join(home, 'test.db')), {
  agent: fakeAgent(),
  codeHost: host,
  notifier: { desktop: async () => {}, ntfy: async () => {} },
});
after(() => db.close());

function gitRepo(name: string) {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 'test@example.com');
  sh('config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), 'demo\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'init');
  return db.addRepo({ name, path: dir, base_branch: 'main', test_cmd: 'true' });
}
const repo = gitRepo('demo');
// Its tasks open PRs, and a builds-on link into a repo with pr_mode off is refused.
db.updateRepo(repo.id, { pr_mode: 'ready' });

beforeEach(() => {
  db.setPaused(false);
  for (const t of db.openPrTasks()) db.recordPr(t.id, { type: 'closed' });
  host.details = {};
  host.merged.length = 0;
  host.closed.length = 0;
});

let n = 0;
/** A done task with an open PR whose last run passed the tests: one a person may merge. */
function tested(r: { id: typeof repo.id } = repo) {
  const url = `https://github.com/acme/demo/pull/${++n}`;
  const t = doneTask(db, r, { pr: 'open', url, branch: `agentdeck/landing-${n}` });
  db.finishRun(db.startRun(t.id, 1, join(home, `run-${t.id}.log`)), { tests_passed: true });
  return { id: t.id, url };
}

test('fixChecks: checks of one Actions job share one log read, and a log that cannot be read is named in the note', async () => {
  const t = tested();
  host.details[t.url] = {
    ...READY_PR,
    checks: { total: 3, failing: 3, pending: 0 },
    check_list: [
      { name: 'unit', state: 'fail', url: 'https://github.com/acme/demo/actions/runs/300/job/7', started_at: null, completed_at: null },
      {
        name: 'unit (retry)',
        state: 'fail',
        url: 'https://github.com/acme/demo/actions/runs/300/job/7',
        started_at: null,
        completed_at: null,
      },
      { name: 'e2e', state: 'fail', url: 'https://github.com/acme/demo/actions/runs/301/job/8', started_at: null, completed_at: null },
    ],
  };
  const reads: string[] = [];
  const failedLog = host.failedLog;
  host.failedLog = async (_path, run, job) => {
    reads.push(`${run}/${job}`);
    if (run === '301') throw new Error('gh: log expired');
    return 'step 1\nError: unit failed\n';
  };
  try {
    const { checks } = await fixChecks(db, t.id);
    assert.deepEqual(checks, ['unit', 'unit (retry)', 'e2e']);
  } finally {
    host.failedLog = failedLog;
  }
  assert.deepEqual(reads.sort(), ['300/7', '301/8'], 'one read per job');
  assert.equal(db.getTask(t.id)!.status, 'queued', 'the task runs again');
  const note = latestReviewNote(db.eventsForTask(t.id))!;
  assert.match(note, /### unit \(/);
  assert.match(note, /Error: unit failed/);
  assert.match(note, /### e2e \([^)]*\)\n[^\n]*gh: log expired/);
});

test("a failing check is kept with its step and excerpt, read once per head; show, the merge's reason and Fix checks say it", async () => {
  const t = tested();
  const job = 'https://github.com/acme/demo/actions/runs/400/job/9';
  const failing = (head: string) => ({
    ...READY_PR,
    head,
    checks: { total: 1, failing: 1, pending: 0 },
    check_list: [{ name: 'check', state: 'fail' as const, url: job, started_at: null, completed_at: null }],
  });
  host.details[t.url] = failing('a1');
  const reads: string[] = [];
  const { failedLog, jobSteps } = host;
  host.failedLog = async (_path, run, id) => (reads.push(`log ${run}/${id}`), ghFixture('run-log-failed-coverage.txt'));
  host.jobSteps = async (_path, id) => (reads.push(`steps ${id}`), parseJobSteps(ghFixture('job-steps-coverage-failed.json')));
  await actions.setAutoMerge(db, t.id, { auto_merge: true });
  try {
    await refreshPrStates(db);
    const kept = db.getTask(t.id)!.pr!.checks.latest!.checks[0];
    assert.equal(kept.step, 'Run pnpm coverage');
    assert.equal(kept.step_url, `${job}#step:8:1`);
    assert.match(kept.excerpt!, /cli: branches 53\.6% is below its floor of 54%[^]*domain\/insights: branches 95\.8% is below its floor/);
    assert.deepEqual(reads.sort(), ['log 400/9', 'steps 9']);

    await refreshPrStates(db);
    assert.equal(reads.length, 2, 'a second refresh of the same head reads no log');

    const view = actions.taskViews(db, { limit: 100 }).find((v) => v.id === t.id)!;
    const line = 'check › Run pnpm coverage: cli: branches 53.6% is below its floor of 54%: add tests, never lower the floor';
    assert.equal(fmtChecks(view.checks!, t.id).split('\n')[1], `         - ${line}`, 'agentdeck show prints the step and what failed');
    assert.ok(view.auto_merge_view?.reasons.includes(`1 check failing on GitHub: ${line}`), view.auto_merge_view?.reasons.join('\n'));

    await fixChecks(db, t.id);
    assert.equal(reads.length, 2, 'Fix checks sends the excerpt the refresh kept');
    const note = latestReviewNote(db.eventsForTask(t.id))!;
    assert.match(note, new RegExp(`### check › Run pnpm coverage \\(${job.replace(/[./]/g, '\\$&')}\\)`));
    assert.match(note, /cli: branches 53\.6% is below its floor of 54%/);
    assert.match(note, /domain\/insights: branches 95\.8% is below its floor of 96%/);
  } finally {
    host.failedLog = failedLog;
    host.jobSteps = jobSteps;
  }
});

test('fixChecks: a PR that cannot be read is refused and leaves the task done', async () => {
  const t = tested();
  const prDetails = host.prDetails;
  host.prDetails = async () => {
    throw new Error('gh: HTTP 502');
  };
  try {
    await assert.rejects(
      fixChecks(db, t.id),
      (e: Error) => e instanceof ActionError && e.message === 'could not read the PR: gh: HTTP 502',
    );
  } finally {
    host.prDetails = prDetails;
  }
  assert.equal(db.getTask(t.id)!.status, 'done');
  await assert.rejects(fixChecks(db, asTaskId(99999)), ActionError);
});

test('requestAllMerges: failing checks, a task that is not done and an unknown id are left with why; what lands after another waits', async () => {
  const failing = tested();
  host.details[failing.url] = { ...READY_PR, checks: { total: 2, failing: 1, pending: 0 } };
  const first = tested();
  const after = tested();
  linkTasks(db, after.id, { on: first.id, kind: 'after' });
  const queued = queuedTask(db, repo);
  const res = await requestAllMerges(db, { ids: [after.id, failing.id, first.id, queued.id, asTaskId(99999), first.id] });
  assert.deepEqual(host.merged, [], 'nothing merges here: the daemon carries the requests out');
  assert.deepEqual(res.requested.map((r) => r.id).sort(), [after.id, first.id].sort(), 'an id given twice is asked once');
  const waits = Object.fromEntries(res.requested.map((r) => [r.id, r.waits]));
  assert.deepEqual(waits[first.id], []);
  assert.match(waits[after.id].join('; '), new RegExp(`lands after #${first.id}`));
  const why = Object.fromEntries(res.left.map((s) => [s.id, s.reason]));
  assert.deepEqual(Object.keys(why).map(Number).sort(), [failing.id, queued.id, 99999].sort());
  assert.equal(why[failing.id], '1 check failing on GitHub');
  assert.match(why[queued.id], /only a done task can be merged/);
  assert.match(why[99999], /no such task/);
  assert.equal(db.getTask(failing.id)!.pr?.merge_request ?? null, null);
  for (const t of [first, after]) assert.ok(db.getTask(t.id)!.pr?.merge_request, 'requested, for the daemon');
  for (const t of [first, after]) cancelMergeRequest(db, t.id);
});

test('closeTaskPr: closes the PR on the code host, and a task building on it is stuck', async () => {
  const dep = tested();
  const builds = queuedTask(db, repo, { title: 'builds on it' });
  linkTasks(db, builds.id, { on: dep.id, kind: 'builds_on' });
  assert.equal((await taskDetail(db, builds.id)).waiting?.stuck ?? null, null, 'on its way while the PR is open');

  await closeTaskPr(db, dep.id);
  assert.deepEqual(host.closed, [dep.url]);
  assert.equal(db.getTask(dep.id)!.pr?.state, 'closed');
  assert.ok((await taskDetail(db, builds.id)).waiting?.stuck, 'nothing it builds on will land now');

  await assert.rejects(closeTaskPr(db, dep.id), /no open pull request/);
  await assert.rejects(closeTaskPr(db, doneTask(db, repo, { pr: 'merged' }).id), /no open pull request/);
  await assert.rejects(closeTaskPr(db, asTaskId(99999)), ActionError);
  assert.deepEqual(host.closed, [dep.url], 'a refused close reaches no code host');
});

test("requestMerges: each task gets its own repo's method, an id given twice is asked once, an unknown one fails with why", () => {
  const other = gitRepo('other');
  actions.updateRepo(db, 'other', { merge_method: 'rebase' });
  const a = tested();
  const b = tested(other);
  const before = db.prCheckRequested();

  const result = requestMerges(db, { ids: [b.id, a.id, b.id, asTaskId(99999)] });
  assert.deepEqual(result.requested, [b.id, a.id]);
  assert.deepEqual(
    result.failed.map((f) => f.id),
    [99999],
  );
  assert.match(result.failed[0].reason, /no such task/);
  assert.equal(db.getTask(a.id)!.pr!.merge_request?.method, repo.merge_method);
  assert.equal(db.getTask(b.id)!.pr!.merge_request?.method, 'rebase');
  assert.ok(db.prCheckRequested() >= before && db.prCheckRequested() > 0, 'the PRs are read again');
  assert.deepEqual(requestMerges(db, { ids: [] }), { requested: [], failed: [] });
});

test('cancelMergeRequest: the cancelled request is not carried out, the others are, and it can be asked again', async () => {
  const a = tested();
  const b = tested();
  requestMerges(db, { ids: [a.id, b.id] });
  assert.deepEqual(cancelMergeRequest(db, a.id), { cancelled: true });
  assert.equal(db.getTask(b.id)!.pr!.merge_request?.method, repo.merge_method, 'the other request stays');

  const refresh = await refreshPrStates(db);
  assert.deepEqual(
    refresh.mergeable.map((m) => m.id),
    [b.id],
    'only the request still standing is ready to merge',
  );
  assert.equal((await taskDetail(db, a.id)).merge_request, null);

  requestMerges(db, { ids: [a.id] });
  assert.ok(db.getTask(a.id)!.pr!.merge_request, 'asked again after the cancel');
  assert.deepEqual(cancelMergeRequest(db, a.id), { cancelled: true });
  assert.deepEqual(cancelMergeRequest(db, queuedTask(db, repo).id), { cancelled: false }, 'a task with no PR has nothing to cancel');
});

test('markDone: a failed task is done by a person with no attempt used, a blank note is none, and a note must be text', () => {
  const f = failedTask(db, repo);
  const attempts = db.getTask(f.id)!.attempts;
  markDone(db, f.id, '   ');
  const t = db.getTask(f.id)!;
  assert.equal(t.status, 'done');
  assert.equal(t.attempts, attempts);
  assert.equal(db.eventsForTask(f.id).at(-1)!.reason, null, 'a blank note is no note');
  assert.throws(
    () => markDone(db, f.id),
    (e: Error) => e instanceof ActionError && e.message === `#${f.id} is done; only blocked or failed tasks can be marked done`,
  );

  const b = blockedTask(db, repo);
  assert.throws(() => markDone(db, b.id, 42 as unknown as string), /note must be text/);
  assert.equal(db.getTask(b.id)!.status, 'blocked', 'a refused mark leaves the task as it was');
});

test('markDone: a blocked task with an open PR is done, and what builds on it waits for the merge', async () => {
  const b = blockedTask(db, repo, { pr: 'open' });
  const builds = queuedTask(db, repo, { title: 'builds on it' });
  linkTasks(db, builds.id, { on: b.id, kind: 'builds_on' });
  markDone(db, b.id, 'fixed the conflict by hand');
  assert.equal(db.getTask(b.id)!.status, 'done');
  assert.equal(db.getTask(b.id)!.pr?.state, 'open');
  assert.equal(db.eventsForTask(b.id).at(-1)!.reason, 'fixed the conflict by hand');
  const view = await taskDetail(db, builds.id);
  assert.equal(view.status, 'queued');
  assert.deepEqual(view.waiting, { on: [b.id], stuck: null }, 'it waits for the merge, and is not stuck');
});
