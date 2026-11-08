// A PR's checks one by one: parsing statusCheckRollup, keeping them on the task, telling a person when they fail,
// and sending the failures back to the worker. Real SQLite and git, fake github adapter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-checks-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('./open-db.ts');
const { doneTask, queuedTask } = await import('./fixtures.ts');
const { github } = await import('../src/adapters/github.ts');
const { refreshPrStates } = await import('../src/application/landing/refresh.ts');
const { ActionError, fixChecks, taskDetail, taskViews } = await import('../src/application/actions.ts');
const { latestReviewNote } = await import('../src/domain/work/history.ts');
const { parsePrDetails } = await import('../src/domain/landing/merge.ts');
const { actionsRun, carryFailures, countChecks, failedStep, failureExcerpt, failureHeadline, failureLine, headBytes, logLines, logTail } =
  await import('../src/domain/landing/checks.ts');
const { fixChecksNote, nextChecks, parseChecks, stepUrl } = await import('../src/domain/landing/checks.ts');
const { parseJobSteps } = await import('../src/domain/landing/merge.ts');
const { checksFailedNotification } = await import('../src/domain/operations/notification.ts');
const { fmtChecks } = await import('../src/cli/format.ts');
type PrDetails = import('../src/domain/landing/merge.ts').PrDetails;
type PrCheck = import('../src/domain/landing/checks.ts').PrCheck;

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

test('a conclusion the daemon does not know counts as pending, never as a pass; only SUCCESS passes', () => {
  const states = parseChecks([
    { name: 'stale', status: 'COMPLETED', conclusion: 'STALE' },
    { name: 'new', status: 'COMPLETED', conclusion: 'SOMETHING_NEW' },
    { name: 'blank', status: 'COMPLETED', conclusion: '' },
    { name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { context: 'ci/status', state: 'SUCCESS' },
  ]).map((c) => [c.name, c.state]);
  assert.deepEqual(states, [
    ['stale', 'pending'],
    ['new', 'pending'],
    ['blank', 'pending'],
    ['ok', 'pass'],
    ['ci/status', 'pass'],
  ]);
  assert.deepEqual(countChecks([{ conclusion: 'STALE' }]), { total: 1, failing: 0, pending: 1 });
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

test('logTail ends on a line that is over budget in bytes but not in characters, cut at a character boundary', () => {
  const wide = logTail('line one\n' + '─'.repeat(1000), 60, 2048);
  assert.ok(Buffer.byteLength(wide) <= 2048);
  assert.ok(wide.length > 0 && /^─+$/.test(wide));

  // 4-byte emoji: a cut inside one drops it whole, never leaving a broken character.
  const emoji = logTail('x\n' + '😀'.repeat(50), 60, 10);
  assert.equal(emoji, '😀😀');
  assert.ok(!emoji.includes('�'));
  assert.equal(logTail('😀', 60, 3), '');
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
  const at = 'test\tRun tests\t2026-11-01T10:02:00.0000000Z';
  return `${Array.from({ length: 100 }, (_, i) => `${at} ok ${i}`).join('\n')}\n${at} AssertionError: expected 2 to equal 3\n`;
};

let stepReads: string[];
github.jobSteps = async (_cwd, job) => {
  stepReads.push(job);
  return [
    { name: 'Set up job', number: 1, conclusion: 'success' },
    { name: 'Run tests', number: 2, conclusion: 'failure' },
  ];
};

beforeEach(() => {
  details = {};
  logs = [];
  stepReads = [];
});

const checkNotices = (id: number) => db.recentNotifications(50).filter((n) => n.task_id === id && n.kind === 'checks_failed');

test('a refresh that finds checks newly failing keeps them and notifies once', async () => {
  const t = doneTask(db, repo, { title: 'Add the thing', pr: 'open', url: 'https://github.com/acme/demo/pull/1' });
  details['https://github.com/acme/demo/pull/1'] = failingDetails;

  await refreshPrStates(db);
  const notices = checkNotices(t.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, `Checks failed on #${t.id}`);
  assert.equal(notices[0].body, '2 checks failing on Add the thing: test › Run tests: AssertionError: expected 2 to equal 3; ci/circleci');

  await refreshPrStates(db);
  assert.equal(checkNotices(t.id).length, 1, 'the same result does not notify again');

  const view = taskViews(db, { limit: 50 }).find((v) => v.id === t.id)!;
  assert.deepEqual(
    { ...view.checks, read_at: undefined },
    {
      total: 5,
      failing: 2,
      pending: 1,
      failing_names: ['test', 'ci/circleci'],
      failing_lines: ['test › Run tests: AssertionError: expected 2 to equal 3', 'ci/circleci'],
      read_at: undefined,
    },
  );
  assert.deepEqual(logs, [{ run: '100', job: '2' }], 'the failing Actions check is read once, on the first refresh');
  assert.deepEqual(stepReads, ['2']);
  assert.ok(!('pr_checks' in view), 'the list leaves the raw checks out');
  const detail = await taskDetail(db, t.id);
  assert.equal(detail.check_list?.checks.length, 5);

  assert.equal(
    fmtChecks(view.checks!, t.id),
    [
      `checks   2 of 5 failing: test, ci/circleci, 1 running  (agentdeck fix-checks ${t.id})`,
      '         - test › Run tests: AssertionError: expected 2 to equal 3',
    ].join('\n'),
  );
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
  assert.match(note, /### test › Run tests \(https:\/\/github\.com\/acme\/demo\/actions\/runs\/100\/job\/2\)/);
  assert.match(note, /What failed in "Run tests", from its log:\n```\n[^]*AssertionError: expected 2 to equal 3\n```/);
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

// The logs and job of #246's failed CI (2026-11-08) and of an earlier one, as `gh` gave them.
const GH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gh');
const ghFixture = (name: string) => readFileSync(join(GH, name), 'utf8');

test('failureExcerpt on the coverage failure: both floors missed, no passing test, the gh prefix gone', () => {
  const step = failedStep(parseJobSteps(ghFixture('job-steps-coverage-failed.json')));
  assert.deepEqual(step, { name: 'Run pnpm coverage', number: 8, conclusion: 'failure' });
  const job = 'https://github.com/acme/demo/actions/runs/1/job/55';
  assert.equal(stepUrl(job, step), `${job}#step:8:1`);
  assert.equal(stepUrl(null, step), null);
  assert.equal(failedStep([{ name: 'ok', number: 1, conclusion: 'success' }]), null);
  assert.equal(failedStep([{ name: 'running', number: 1, conclusion: null }]), null);
  assert.deepEqual(parseJobSteps('{}'), []);
  assert.deepEqual(parseJobSteps(JSON.stringify({ steps: [null, { name: 'x' }, { number: 2 }] })), [
    { name: 'x', number: 0, conclusion: null },
  ]);

  const excerpt = failureExcerpt(ghFixture('run-log-failed-coverage.txt'), step!.name);
  assert.match(excerpt, /^ {2}cli: branches 53\.6% is below its floor of 54%/m);
  assert.match(excerpt, /^ {2}domain\/insights: branches 95\.8% is below its floor of 96%/m);
  assert.match(excerpt, /##\[error\]Process completed with exit code 1\./);
  assert.doesNotMatch(excerpt, /✔/, 'no passing test');
  assert.doesNotMatch(excerpt, /UNKNOWN STEP|\d{4}-\d\d-\d\dT\d\d:/, "gh's job, step and timestamp are stripped");
  assert.doesNotMatch(excerpt, /Post job cleanup|git version/, "the job's cleanup is not the step");
  assert.ok(Buffer.byteLength(excerpt) <= 4096);
  assert.equal(failureHeadline(excerpt), 'cli: branches 53.6% is below its floor of 54%: add tests, never lower the floor');
  assert.equal(
    failureLine({ name: 'check', step: 'tests and coverage', excerpt }),
    'check › tests and coverage: cli: branches 53.6% is below its floor of 54%: add tests, never lower the floor',
  );
  // A named step's header says "Run <command>", not its name: the step is then the one GitHub's ##[error] is in.
  assert.equal(failureExcerpt(ghFixture('run-log-failed-coverage.txt'), 'tests and coverage'), excerpt);
});

test("failureExcerpt on a failing test: node's failing-tests summary with the error, and the test in the headline", () => {
  const excerpt = failureExcerpt(ghFixture('run-log-failed.txt'), 'Run pnpm test');
  assert.match(excerpt, /^✖ failing tests:$/m);
  assert.match(excerpt, /✖ no file in domain\/pull-request imports Task/);
  assert.match(excerpt, /ENOENT: no such file or directory, scandir/);
  assert.doesNotMatch(excerpt, /✔/);
  assert.equal(failureHeadline(excerpt), 'no file in domain/pull-request imports Task');

  // The test's own ✖ above the summary is said again in it, so only the summary is kept.
  const inline = [
    '✖ adds (1ms)',
    '  Error: 1 !== 2',
    'a',
    'b',
    'c',
    'd',
    '✖ failing tests:',
    '',
    '✖ adds (1ms)',
    '  Error: 1 !== 2',
    '[ELIFECYCLE] failed',
  ];
  assert.equal(failureExcerpt(inline.join('\n'), null), '✖ failing tests:\n\n✖ adds (1ms)\n  Error: 1 !== 2\n[ELIFECYCLE] failed');
});

test('fixChecksNote: each failing check with its step and excerpt, the error that kept its log, or why it has none', () => {
  const note = fixChecksNote([
    { name: 'check', url: null, step: 'tests and coverage', excerpt: 'cli: below its floor' },
    { name: 'e2e', url: null, excerpt: 'boom' },
    { name: 'lint', url: 'https://github.com/acme/demo/actions/runs/1/job/2', log_error: 'gh: 404' },
    { name: 'ci/circleci', url: null },
  ]);
  assert.match(note, /### check › tests and coverage\nWhat failed in "tests and coverage", from its log:\n```\ncli: below its floor\n```/);
  assert.match(note, /### e2e\nWhat failed, from its log:/);
  assert.match(note, /### lint \(https:[^)]+\)\nThe log could not be read: gh: 404/);
  assert.match(note, /### ci\/circleci\nNot a GitHub Actions check/);
});

test('failureExcerpt: a log with no marker is its tail; each tool has its marker; the budget keeps the front', () => {
  const plain = Array.from({ length: 100 }, (_, i) => `job\tUNKNOWN STEP\t2026-11-08T18:00:00.0000000Z line ${i}`).join('\n');
  const tail = failureExcerpt(plain, null);
  assert.equal(tail.split('\n').length, 60);
  assert.ok(tail.startsWith('line 40\n') && tail.endsWith('line 99'));
  assert.equal(failureHeadline(tail), 'line 99', 'with no marker the headline is the last line');

  const around = (line: string) => ['setup', 'more setup', 'and more', line, 'after 1', 'after 2', 'after 3', 'after 4'].join('\n');
  const tsc = "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.";
  const invariant = 'a_nonterminal                    1  it3: task 4 running';
  const cases: [string, string, string][] = [
    ['tsc', tsc, tsc],
    ['prettier', '[warn] daemon/src/a.ts', '[warn] daemon/src/a.ts'],
    ['cargo', 'error[E0308]: mismatched types', 'error[E0308]: mismatched types'],
    ['crash test invariant', invariant, invariant],
    ['crash test total', 'crash-test: 5 iterations, 2 violations', 'crash-test: 5 iterations, 2 violations'],
    ['node test', '✖ adds two numbers (1.2ms)', 'adds two numbers'],
    ['GitHub', '##[error]Process completed with exit code 2.', 'Process completed with exit code 2.'],
  ];
  for (const [tool, line, headline] of cases) {
    const excerpt = failureExcerpt(around(line), null);
    assert.equal(excerpt, ['more setup', 'and more', line, 'after 1', 'after 2', 'after 3'].join('\n'), tool);
    assert.equal(failureHeadline(excerpt), headline, tool);
  }
  assert.equal(failureExcerpt(around('a_nonterminal                    0'), null).split('\n').length, 8, 'a zero count is no failure');
  const both = ['✔ ok', 'x', 'y', 'z', 'error TS1: a', 'w', 'v', 'u', 't', '##[error]exit 1'].join('\n');
  assert.equal(failureHeadline(failureExcerpt(both, null)), 'error TS1: a', "a tool's line beats GitHub's ##[error]");
  const near = ['error TS1: a', '1', '2', '3', '4', '5', 'error TS2: g'];
  assert.equal(failureExcerpt(near.join('\n'), null), near.join('\n'), 'parts that touch are one');
  const apart = ['error TS1: a', '1', '2', '3', '4', '5', '6', 'error TS2: g'];
  assert.equal(failureExcerpt(apart.join('\n'), null), 'error TS1: a\n1\n2\n3\n…\n5\n6\nerror TS2: g', 'a gap is an ellipsis');

  const many = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts(1,1): error TS1000: bad`).join('\n');
  const cut = failureExcerpt(many, null, 300);
  assert.ok(Buffer.byteLength(cut) <= 300);
  assert.ok(cut.startsWith('src/f0.ts'), 'the budget keeps the first failures');
  assert.equal(failureHeadline(''), '');
  assert.equal(failureHeadline(`error TS1: ${'x'.repeat(300)}`).length, 160);
});

test('logLines strips the gh prefix, a bare timestamp and colour codes; headBytes keeps whole lines from the front', () => {
  const log = 'job\tRun x\t2026-11-08T18:00:00.1Z hello\n2026-11-08T18:00:00Z \u001b[31mred\u001b[0m\nplain\n';
  assert.deepEqual(logLines(log), ['hello', 'red', 'plain']);
  assert.equal(headBytes('one\ntwo\nthree', 100), 'one\ntwo\nthree');
  assert.equal(headBytes('one\ntwo\nthree', 8), 'one\ntwo');
  assert.equal(headBytes('😀😀😀', 9), '😀😀', 'a first line over the budget is cut at a character');
});

test('carryFailures keeps what was read for the same head and job, and asks to read the rest', () => {
  const fail = (url: string | null, more: Partial<PrCheck> = {}): PrCheck => ({
    name: 'check',
    state: 'fail',
    url,
    started_at: null,
    completed_at: null,
    ...more,
  });
  const job = 'https://github.com/acme/demo/actions/runs/1/job/5';
  const read = fail(job, { step: 'Run pnpm coverage', step_url: `${job}#step:8:1`, excerpt: 'cli: below its floor' });
  const previous = { read_at: 'x', head: 'a', checks: [read], notified: true };

  const same = carryFailures(previous, 'a', [fail(job)]);
  assert.deepEqual(same.checks, [read]);
  assert.deepEqual(same.unread, [], 'the same head and job is not read again');
  assert.deepEqual(carryFailures(previous, 'b', [fail(job)]).unread, [fail(job)], 'a new head is read');
  const rerun = fail('https://github.com/acme/demo/actions/runs/1/job/6');
  assert.deepEqual(carryFailures(previous, 'a', [rerun]).unread, [rerun], 'a re-run is a new job');
  assert.deepEqual(carryFailures(null, 'a', [fail('https://circleci.com/x')]).unread, [], 'only Actions checks have a log to read');
  const errored = { ...previous, checks: [fail(job, { step: null, excerpt_error: 'gh: 404' })] };
  assert.deepEqual(carryFailures(errored, 'a', [fail(job)]).unread, [], 'a log that could not be read is not read on each refresh');
  assert.equal(carryFailures(previous, 'a', [{ ...fail(job), state: 'pass' }]).checks[0].excerpt, undefined, 'a pass carries none');

  assert.equal(failureLine(fail(job)), 'check');
  assert.equal(
    checksFailedNotification({ id: 1 as never, title: 'T' }, [read, fail(null, { name: 'lint' })]).body,
    '2 checks failing on T: check › Run pnpm coverage: cli: below its floor; lint',
  );
});
