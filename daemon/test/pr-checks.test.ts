// A PR's checks one by one: parsing statusCheckRollup, keeping them on the task, telling a person when they fail,
// and sending the failures back to the worker. Real SQLite and git, fake github adapter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-checks-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { doneTask, queuedTask } = await import('./fixtures.ts');
const { github } = await import('../src/adapters/github.ts');
const { refreshPrStates } = await import('../src/application/pull-request/refresh.ts');
const { ActionError, fixChecks, taskDetail, taskViews } = await import('../src/application/actions.ts');
const { latestReviewNote } = await import('../src/domain/task/history.ts');
const { parsePrDetails } = await import('../src/domain/pull-request/merge.ts');
const { actionsRun, countChecks, logTail, nextChecks, parseChecks } = await import('../src/domain/pull-request/checks.ts');
const { fmtChecks } = await import('../src/cli/format.ts');
type PrDetails = import('../src/domain/pull-request/merge.ts').PrDetails;
type PrCheck = import('../src/domain/pull-request/checks.ts').PrCheck;

const db = openDb(join(home, 'test.db'));
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

const ROLLUP = [
  {
    __typename: 'CheckRun',
    name: 'lint',
    workflowName: 'CI',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://github.com/acme/demo/actions/runs/100/job/1',
    startedAt: '2026-11-01T10:00:00Z',
    completedAt: '2026-11-01T10:01:00Z',
  },
  {
    __typename: 'CheckRun',
    name: 'test',
    workflowName: 'CI',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: 'https://github.com/acme/demo/actions/runs/100/job/2',
    startedAt: '2026-11-01T10:00:00Z',
    completedAt: '2026-11-01T10:03:00Z',
  },
  {
    __typename: 'CheckRun',
    name: 'build',
    workflowName: 'CI',
    status: 'IN_PROGRESS',
    conclusion: '',
    detailsUrl: 'https://github.com/acme/demo/actions/runs/100/job/3',
    startedAt: '2026-11-01T10:00:00Z',
    completedAt: '0001-01-01T00:00:00Z',
  },
  {
    __typename: 'CheckRun',
    name: 'deploy',
    workflowName: 'CI',
    status: 'COMPLETED',
    conclusion: 'SKIPPED',
    detailsUrl: 'https://github.com/acme/demo/actions/runs/100/job/4',
    startedAt: null,
    completedAt: null,
  },
  { __typename: 'StatusContext', context: 'ci/circleci', state: 'ERROR', targetUrl: 'https://circleci.com/gh/acme/demo/7' },
];

test('parseChecks reads check runs and commit statuses, and countChecks counts the same parse', () => {
  const checks = parseChecks(ROLLUP);
  assert.deepEqual(
    checks.map((c) => [c.name, c.state, c.url]),
    [
      ['lint', 'pass', 'https://github.com/acme/demo/actions/runs/100/job/1'],
      ['test', 'fail', 'https://github.com/acme/demo/actions/runs/100/job/2'],
      ['build', 'pending', 'https://github.com/acme/demo/actions/runs/100/job/3'],
      ['deploy', 'skipped', 'https://github.com/acme/demo/actions/runs/100/job/4'],
      ['ci/circleci', 'fail', 'https://circleci.com/gh/acme/demo/7'],
    ],
  );
  assert.equal(checks[1].started_at, '2026-11-01T10:00:00Z');
  assert.equal(checks[1].completed_at, '2026-11-01T10:03:00Z');
  assert.equal(checks[2].completed_at, null, "GitHub's zero time for a running check is no time");
  assert.equal(checks[3].started_at, null);
  assert.equal(checks[4].started_at, null, 'a commit status has no timing');
  assert.deepEqual(countChecks(ROLLUP), { total: 5, failing: 2, pending: 1 });
  assert.deepEqual(parseChecks(null), []);
  assert.deepEqual(parseChecks([{ conclusion: 'NEUTRAL' }]), [
    { name: 'check', state: 'skipped', url: null, started_at: null, completed_at: null },
  ]);
});

test('check runs that share a name are told apart by their workflow', () => {
  const checks = parseChecks([
    { name: 'test', workflowName: 'CI', conclusion: 'SUCCESS' },
    { name: 'test', workflowName: 'Nightly', conclusion: 'FAILURE' },
    { name: 'lint', workflowName: 'CI', conclusion: 'SUCCESS' },
  ]);
  assert.deepEqual(
    checks.map((c) => c.name),
    ['CI / test', 'Nightly / test', 'lint'],
  );
});

test('parsePrDetails keeps each check and the head commit', () => {
  const d = parsePrDetails(JSON.stringify({ state: 'OPEN', headRefOid: 'abc123', statusCheckRollup: ROLLUP }));
  assert.equal(d.head, 'abc123');
  assert.deepEqual(d.checks, { total: 5, failing: 2, pending: 1 });
  assert.equal(d.check_list?.length, 5);
});

test('nextChecks notifies when checks start failing, and again only after they pass or a new commit', () => {
  const at = '2026-11-01T10:00:00Z';
  const fail: PrCheck[] = [{ name: 'test', state: 'fail', url: null, started_at: null, completed_at: null }];
  const pass: PrCheck[] = [{ name: 'test', state: 'pass', url: null, started_at: null, completed_at: null }];
  const pending: PrCheck[] = [{ name: 'test', state: 'pending', url: null, started_at: null, completed_at: null }];

  const first = nextChecks(null, { head: 'a', checks: fail, read_at: at });
  assert.equal(first.notify, true);
  const again = nextChecks(first.stored, { head: 'a', checks: fail, read_at: at });
  assert.equal(again.notify, false, 'the same failure is told once');
  const rerunning = nextChecks(again.stored, { head: 'a', checks: pending, read_at: at });
  assert.equal(rerunning.notify, false);
  assert.equal(nextChecks(rerunning.stored, { head: 'a', checks: fail, read_at: at }).notify, false, 'a re-run still failing says nothing');

  const passed = nextChecks(again.stored, { head: 'a', checks: pass, read_at: at });
  assert.equal(passed.notify, false);
  assert.equal(nextChecks(passed.stored, { head: 'a', checks: fail, read_at: at }).notify, true, 'failing after passing is told');
  assert.equal(nextChecks(again.stored, { head: 'b', checks: fail, read_at: at }).notify, true, 'a new commit failing is told');
});

test('actionsRun finds the run and job in an Actions link; logTail keeps the last lines within the bytes', () => {
  assert.deepEqual(actionsRun('https://github.com/acme/demo/actions/runs/100/job/2'), { run: '100', job: '2' });
  assert.deepEqual(actionsRun('https://github.com/acme/demo/actions/runs/100'), { run: '100', job: null });
  assert.equal(actionsRun('https://circleci.com/gh/acme/demo/7'), null);
  assert.equal(actionsRun(null), null);

  const log = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n\n';
  const tail = logTail(log);
  assert.equal(tail.split('\n').length, 60);
  assert.ok(tail.endsWith('line 199'));
  assert.ok(Buffer.byteLength(logTail(log, 60, 100)) <= 100);
  assert.ok(logTail(log, 60, 100).endsWith('line 199'));
});

// The real adapter would call GitHub.
const failingDetails: PrDetails = parsePrDetails(
  JSON.stringify({ state: 'OPEN', headRefOid: 'abc123', mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', statusCheckRollup: ROLLUP }),
);
let details: Record<string, PrDetails>;
let logs: { run: string; job: string | null }[];
github.prDetails = async (url) => details[url] ?? { ...failingDetails, checks: { total: 0, failing: 0, pending: 0 }, check_list: [] };
github.failedLog = async (_cwd, run, job) => {
  logs.push({ run, job: job ?? null });
  return `${Array.from({ length: 100 }, (_, i) => `test\tRun tests\tok ${i}`).join('\n')}\ntest\tRun tests\tAssertionError: expected 2 to equal 3\n`;
};

beforeEach(() => {
  details = {};
  logs = [];
});

const checkNotices = (id: number) => db.recentNotifications(50).filter((n) => n.task_id === id && n.kind === 'checks_failed');

test('a refresh that finds checks newly failing keeps them and notifies once', async () => {
  const t = doneTask(db, repo, { title: 'Add the thing', pr: 'open', url: 'https://github.com/acme/demo/pull/1' });
  details['https://github.com/acme/demo/pull/1'] = failingDetails;

  await refreshPrStates(db);
  const notices = checkNotices(t.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, `Checks failed on #${t.id}`);
  assert.match(notices[0].body, /test, ci\/circleci/);

  await refreshPrStates(db);
  assert.equal(checkNotices(t.id).length, 1, 'the same result does not notify again');

  const view = taskViews(db, { limit: 50 }).find((v) => v.id === t.id)!;
  assert.deepEqual(
    { ...view.checks, read_at: undefined },
    { total: 5, failing: 2, pending: 1, failing_names: ['test', 'ci/circleci'], read_at: undefined },
  );
  assert.ok(!('pr_checks' in view), 'the list leaves the raw checks out');
  const detail = await taskDetail(db, t.id);
  assert.equal(detail.check_list?.checks.length, 5);

  assert.equal(fmtChecks(view.checks!, t.id), `checks   2 of 5 failing: test, ci/circleci, 1 running  (agentdeck fix-checks ${t.id})`);
});

test('fixChecks retries the task with a note naming each failing check and holding its log tail', async () => {
  const url = 'https://github.com/acme/demo/pull/2';
  const t = doneTask(db, repo, { title: 'Fix me', pr: 'open', url });
  details[url] = failingDetails;

  const { checks } = await fixChecks(db, t.id);
  assert.deepEqual(checks, ['test', 'ci/circleci']);
  assert.deepEqual(logs, [{ run: '100', job: '2' }], 'only the Actions check fetches a log');
  assert.equal(db.getTask(t.id)!.status, 'queued');

  const note = latestReviewNote(db.eventsForTask(t.id))!;
  assert.match(note, /^CI checks failed on the PR/);
  assert.match(note, /### test \(https:\/\/github\.com\/acme\/demo\/actions\/runs\/100\/job\/2\)/);
  assert.match(note, /AssertionError: expected 2 to equal 3/);
  assert.doesNotMatch(note, /ok 10\n/, 'only the tail of the log is kept');
  assert.match(note, /### ci\/circleci \(https:\/\/circleci\.com\/gh\/acme\/demo\/7\)\nNot a GitHub Actions check/);
});

test('fixChecks does not requeue a task whose PR was merged while the checks were read', async () => {
  const url = 'https://github.com/acme/demo/pull/9';
  const t = doneTask(db, repo, { title: 'Merged meanwhile', pr: 'open', url });
  details[url] = failingDetails;
  const read = github.prDetails;
  github.prDetails = async (u, cwd) => {
    const d = await read(u, cwd);
    assert.ok(db.recordPr(t.id, { type: 'seen', state: 'merged' }));
    return d;
  };
  try {
    await assert.rejects(fixChecks(db, t.id), /no longer open/);
  } finally {
    github.prDetails = read;
  }
  assert.equal(db.getTask(t.id)!.status, 'done');
});

test('fixChecks is refused with no failing check, without an open PR, or when the task is not done', async () => {
  const url = 'https://github.com/acme/demo/pull/3';
  const passing = doneTask(db, repo, { title: 'All green', pr: 'open', url });
  details[url] = {
    ...failingDetails,
    checks: { total: 1, failing: 0, pending: 0 },
    check_list: [{ name: 'test', state: 'pass', url: null, started_at: null, completed_at: null }],
  };
  await assert.rejects(fixChecks(db, passing.id), (err: Error) => err instanceof ActionError && /no check is failing/.test(err.message));
  assert.equal(db.getTask(passing.id)!.status, 'done');

  const noPr = doneTask(db, repo, { title: 'No PR' });
  await assert.rejects(fixChecks(db, noPr.id), /no open pull request/);
  const queued = queuedTask(db, repo, { title: 'Not done' });
  await assert.rejects(fixChecks(db, queued.id), /only a done task/);
  assert.deepEqual(logs, []);
});
