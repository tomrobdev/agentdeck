// Pull requests and task dependencies: real git worktrees and SQLite, fake claude binary, fake github adapter.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-pr-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { blockedTask, doneTask, failedTask, openPr, rerun, settlePr } = await import('./fixtures.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { github } = await import('../src/adapters/github.ts');
const { refreshPrStates } = await import('../src/application/pull-request/pull-requests.ts');
const { addTask, ActionError, closeTaskPr, retryTask, updateRepo } = await import('../src/application/actions.ts');
const { buildPrompt } = await import('../src/domain/run/prompt.ts');
const { latestReviewNote } = await import('../src/domain/task/history.ts');
const { linkTasks, mergeAll, mergePreview, mergeTask } = await import('../src/application/actions.ts');
const { mergeCheck, parsePrDetails } = await import('../src/domain/pull-request/merge.ts');
type PrDetails = import('../src/domain/pull-request/merge.ts').PrDetails;
const { waitingFor } = await import('../src/application/task/dependencies.ts');
const { cancelTask } = await import('../src/application/actions.ts');

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'test -f fake-output.txt' });

interface Calls {
  push: { repoPath: string; branch: string }[];
  create: Parameters<typeof github.createPr>[0][];
}
let calls: Calls;
let pushError: string | null;
let states: Record<string, 'open' | 'merged' | 'closed'>;

// The real adapter would push to a remote and call GitHub.
github.push = async (repoPath, branch) => {
  calls.push.push({ repoPath, branch });
  if (pushError) throw new Error(pushError);
};
github.createPr = async (pr) => {
  calls.create.push(pr);
  return `https://github.com/acme/demo/pull/${calls.create.length}`;
};
let closed: string[];
let closeError: string | null;
github.closePr = async (url) => {
  if (closeError) throw new Error(closeError);
  closed.push(url);
};

// Merging: what GitHub says about each PR, and what the daemon asked it to do.
const cleanDetails: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 3,
  files: 2,
  additions: 10,
  deletions: 4,
  checks: { total: 2, failing: 0, pending: 0 },
  paths: ['src/a.ts', 'src/b.ts'],
  labels: [],
};
let details: Record<string, PrDetails>;
let merging: { ready: string[]; merged: { url: string; method: string; subject?: string; body?: string }[]; deleted: string[] };
let mergeError: string | null;
github.prDetails = async (url) => ({ ...(details[url] ?? cleanDetails), state: states[url] ?? 'open' });
github.markReady = async (url) => void merging.ready.push(url);
github.merge = async (pr) => {
  if (mergeError) throw new Error(mergeError);
  merging.merged.push({ url: pr.url, method: pr.method, subject: pr.message?.subject, body: pr.message?.body });
};
github.deleteRemoteBranch = async (_repoPath, branch) => void merging.deleted.push(branch);

beforeEach(() => {
  calls = { push: [], create: [] };
  pushError = null;
  states = {};
  closed = [];
  closeError = null;
  details = {};
  merging = { ready: [], merged: [], deleted: [] };
  mergeError = null;
  updateRepo(db, 'demo', { pr_mode: 'off' });
});

test('pr_mode defaults to off and rejects unknown values', () => {
  assert.equal(repo.pr_mode, 'off');
  assert.throws(() => updateRepo(db, 'demo', { pr_mode: 'maybe' as never }), ActionError);
  assert.equal(updateRepo(db, 'demo', { pr_mode: 'draft' }).pr_mode, 'draft');
});

test('a done task in a draft repo is pushed and opened as a draft PR', async () => {
  updateRepo(db, 'demo', { pr_mode: 'draft' });
  const task = db.addTask({ repo_id: repo.id, title: 'Add the output file', prompt: 'FAKE_DONE one' });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  assert.deepEqual(calls.push, [{ repoPath: dir, branch: `agentdeck/task-${t.id}` }]);
  assert.equal(calls.create.length, 1);
  const pr = calls.create[0];
  assert.equal(pr.title, 'Add the output file');
  assert.equal(pr.base, 'main');
  assert.equal(pr.head, `agentdeck/task-${t.id}`);
  assert.equal(pr.draft, true);
  assert.equal(pr.cwd, t.worktree);
  assert.ok(pr.body.startsWith('Wrote fake-output.txt and committed.'), pr.body);
  assert.ok(!pr.body.includes('STATUS:'), 'the status line is not part of the description');
  assert.match(pr.body, /\| Attempt \| Outcome \| Turns \| Cost \| Tests \|/);
  assert.match(pr.body, /\| 1 \| done \| 3 \| \$0\.01 \| pass \|/);
  assert.ok(pr.body.endsWith(`Made by AgentDeck task #${t.id}.`), pr.body);
  assert.equal(t.pr_url, 'https://github.com/acme/demo/pull/1');
  assert.equal(t.pr_state, 'open');
});

test('a ready repo opens a PR that is not a draft', async () => {
  updateRepo(db, 'demo', { pr_mode: 'ready' });
  db.addTask({ repo_id: repo.id, title: 'Ready one', prompt: 'FAKE_DONE two' });
  await drain();
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].draft, false);
});

test('a repo with pr_mode off pushes nothing', async () => {
  const task = db.addTask({ repo_id: repo.id, title: 'Quiet', prompt: 'FAKE_DONE three' });
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'done');
  assert.equal(db.getTask(task.id)!.pr_url, null);
  assert.deepEqual(calls, { push: [], create: [] });
});

test('blocked tasks do not open a PR', async () => {
  updateRepo(db, 'demo', { pr_mode: 'draft' });
  db.addTask({ repo_id: repo.id, title: 'Stuck', prompt: 'FAKE_BLOCKED' });
  await drain();
  assert.deepEqual(calls, { push: [], create: [] });
});

test('a push failure keeps the task done, logs agentdeck_pr, and notifies with the error', async () => {
  updateRepo(db, 'demo', { pr_mode: 'draft' });
  pushError = 'remote: Permission denied (publickey)';
  const task = db.addTask({ repo_id: repo.id, title: 'Cannot push', prompt: 'FAKE_DONE four' });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  assert.equal(t.pr_url, null);
  assert.equal(t.pr_state, 'failed', 'dependents see that the PR will not appear on its own');
  assert.equal(calls.create.length, 0, 'no PR without a pushed branch');

  const log = readFileSync(db.runsForTask(t.id).at(-1)!.log_path, 'utf8');
  assert.match(log, /"type":"agentdeck_pr","error":"remote: Permission denied \(publickey\)"/);

  const n = db.recentNotifications().find((x) => x.task_id === t.id)!;
  assert.equal(n.kind, 'done');
  assert.match(n.body, /Permission denied \(publickey\)/);
});

test('a gh failure after a good push also keeps the task done', async () => {
  updateRepo(db, 'demo', { pr_mode: 'ready' });
  github.createPr = async () => {
    throw new Error('gh: not logged in');
  };
  try {
    const task = db.addTask({ repo_id: repo.id, title: 'No gh', prompt: 'FAKE_DONE five' });
    await drain();
    const t = db.getTask(task.id)!;
    assert.equal(t.status, 'done');
    assert.equal(t.pr_url, null);
    assert.match(db.recentNotifications().find((x) => x.task_id === t.id)!.body, /not logged in/);
  } finally {
    github.createPr = async (pr) => {
      calls.create.push(pr);
      return `https://github.com/acme/demo/pull/${calls.create.length}`;
    };
  }
});

test('a retried task keeps its open PR, but gets a new one once the old PR is merged', async () => {
  updateRepo(db, 'demo', { pr_mode: 'ready' });
  const task = db.addTask({ repo_id: repo.id, title: 'Retry me', prompt: 'FAKE_DONE retry' });
  await drain();
  const first = db.getTask(task.id)!.pr_url;
  assert.ok(first);

  retryTask(db, task.id);
  await drain();
  assert.equal(db.getTask(task.id)!.pr_url, first, 'an open PR is updated by the push');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.push.length, 2);

  settlePr(db, task.id, 'merged');
  retryTask(db, task.id);
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(calls.create.length, 2, 'a merged PR cannot take new commits');
  assert.notEqual(t.pr_url, first);
  assert.equal(t.pr_state, 'open');
});

test('request changes: the note is on the timeline and first in the next prompt, and only the latest retry counts', async () => {
  updateRepo(db, 'demo', { pr_mode: 'ready' });
  const task = db.addTask({ repo_id: repo.id, title: 'Review me', prompt: 'FAKE_DONE review' });
  await drain();
  retryTask(db, task.id, '  Rename the helper.  ');
  const events = db.eventsForTask(task.id);
  assert.equal(events.at(-1)!.type, 'retry');
  assert.equal(events.at(-1)!.reason, 'Rename the helper.');
  assert.equal(latestReviewNote(events), 'Rename the helper.');

  const prompt = buildPrompt(db.getTask(task.id)!, db.runsForTask(task.id), latestReviewNote(events));
  assert.match(prompt, /^Changes requested in review:\nRename the helper\.\n/);
  assert.ok(prompt.includes('FAKE_DONE review'));
  assert.ok(!buildPrompt(db.getTask(task.id)!, db.runsForTask(task.id)).includes('Changes requested'));

  await drain();
  retryTask(db, task.id);
  assert.equal(latestReviewNote(db.eventsForTask(task.id)), null);
});

test('close PR closes it with gh, marks it closed and only works on an open PR', async () => {
  updateRepo(db, 'demo', { pr_mode: 'ready' });
  const dep = db.addTask({ repo_id: repo.id, title: 'Close me', prompt: 'FAKE_DONE close' });
  await drain();
  const url = db.getTask(dep.id)!.pr_url!;

  closeError = 'gh: not authenticated';
  await assert.rejects(closeTaskPr(db, dep.id), /could not close the PR: gh: not authenticated/);
  assert.equal(db.getTask(dep.id)!.pr_state, 'open');

  closeError = null;
  await closeTaskPr(db, dep.id);
  assert.deepEqual(closed, [url]);
  assert.equal(db.getTask(dep.id)!.pr_state, 'closed');
  await assert.rejects(closeTaskPr(db, dep.id), /no open pull request/);
});

test('refreshPrStates updates open PRs of done tasks and leaves a failed lookup alone', async () => {
  const mk = (url: string | null, state: 'open' | 'merged' | 'closed' | null) =>
    doneTask(db, repo, { title: `pr ${url}`, pr: state, url: url ?? undefined }).id;
  const merged = mk('https://x/pull/10', 'open');
  const stillOpen = mk('https://x/pull/11', 'open');
  const broken = mk('https://x/pull/12', 'open');
  const alreadyClosed = mk('https://x/pull/13', 'closed');
  const noPr = mk(null, null);
  states = { 'https://x/pull/10': 'merged', 'https://x/pull/13': 'merged' };
  const lookups: string[] = [];
  const real = github.prDetails;
  github.prDetails = async (url, cwd, opts) => {
    lookups.push(url);
    if (url.endsWith('/12')) throw new Error('network down');
    return real(url, cwd, opts);
  };
  try {
    await refreshPrStates(db);
  } finally {
    github.prDetails = real;
  }
  assert.deepEqual(
    lookups.filter((u) => u.startsWith('https://x/')).toSorted(),
    ['https://x/pull/10', 'https://x/pull/11', 'https://x/pull/12'],
    'one gh read per open PR',
  );
  assert.equal(db.getTask(merged)!.pr_state, 'merged');
  assert.equal(db.getTask(stillOpen)!.pr_state, 'open');
  assert.equal(db.getTask(broken)!.pr_state, 'open');
  assert.equal(db.getTask(alreadyClosed)!.pr_state, 'closed', 'only open PRs are looked up');
  assert.equal(db.getTask(noPr)!.pr_state, null);
  assert.ok(!lookups.includes('https://x/pull/13'));
});

test('refreshPrStates: a merged PR moves a blocked or failed task to done, a closed one leaves it, each PR is read once', async () => {
  const mk = (make: typeof blockedTask, url: string) => make(db, repo, { title: `pr ${url}`, pr: 'open', url }).id;
  const blockedMerged = mk(blockedTask, 'https://x/pull/30');
  const failedMerged = mk(failedTask, 'https://x/pull/31');
  const blockedClosed = mk(blockedTask, 'https://x/pull/32');
  const blockedOpen = mk(blockedTask, 'https://x/pull/33');
  states = { 'https://x/pull/30': 'merged', 'https://x/pull/31': 'merged', 'https://x/pull/32': 'closed' };
  const details: string[] = [];
  const real = github.prDetails;
  github.prDetails = async (url, cwd) => {
    details.push(url);
    return real(url, cwd);
  };
  try {
    const found = await refreshPrStates(db);
    assert.deepEqual(found.conflicting, []);
  } finally {
    github.prDetails = real;
  }
  for (const id of [blockedMerged, failedMerged]) {
    const t = db.getTask(id)!;
    assert.equal(t.status, 'done');
    assert.equal(t.pr_state, 'merged');
    assert.equal(t.stop_reason, null);
    assert.ok(db.eventsForTask(id).some((e) => e.type === 'pr_merged'));
  }
  assert.equal(db.getTask(blockedClosed)!.status, 'blocked');
  assert.equal(db.getTask(blockedClosed)!.pr_state, 'closed');
  assert.equal(db.getTask(blockedOpen)!.status, 'blocked');
  assert.deepEqual(
    details.filter((u) => /pull\/3[0-3]$/.test(u)).toSorted(),
    ['https://x/pull/30', 'https://x/pull/31', 'https://x/pull/32', 'https://x/pull/33'],
    'one gh read per open PR, none for its mergeability',
  );
});

test('the scheduler refreshes PR states on its own, not only when work runs', async () => {
  const t = doneTask(db, repo, { title: 'merge me', pr: 'open', url: 'https://x/pull/20' });
  states = { 'https://x/pull/20': 'merged' };
  const scheduler = new Scheduler(db, { tickMs: 10, prRefreshMs: 10, log: () => {} });
  const running = scheduler.run(); // paused by default: nothing is claimed
  const deadline = Date.now() + 5000;
  while (db.getTask(t.id)!.pr_state !== 'merged' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  scheduler.stop();
  await running;
  assert.equal(db.getTask(t.id)!.pr_state, 'merged');
});

/** Finish whatever is next in the queue as done, the way a worker would. */
function finishNext(): number {
  const t = db.claimNextTask();
  assert.ok(t, 'a task was claimable');
  db.applyEvent(t.id, { type: 'finish', outcome: 'done' });
  return t.id;
}

test('--after holds a task until its dependency is done', async () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'first', prompt: 'x', priority: -5 });
  const later = await addTask(db, { repo: 'demo', prompt: 'second', builds_on: [dep.id], priority: 10 });
  assert.deepEqual(db.linksOf(later.id), [{ task_id: later.id, on: dep.id, kind: 'builds_on' }]);
  assert.equal(db.hasQueued(), true);

  // Higher priority, but waiting: the dependency is claimed first.
  assert.equal(db.claimNextTask()!.id, dep.id);
  assert.equal(db.claimNextTask(), undefined, 'dependency is running, so the dependent still waits');
  db.applyEvent(dep.id, { type: 'finish', outcome: 'done' });

  assert.equal(db.claimNextTask()!.id, later.id, 'done with no PR releases the dependent');
});

test('--after waits for the dependency PR to be merged', async () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'with pr', prompt: 'x' });
  const later = await addTask(db, { repo: 'demo', prompt: 'after the pr', builds_on: [dep.id] });
  assert.equal(finishNext(), dep.id);
  openPr(db, dep.id, 'https://x/pull/30');

  assert.equal(db.claimNextTask(), undefined, 'PR still open');
  assert.equal(db.hasQueued(), false, 'a waiting task is not claimable work');
  settlePr(db, dep.id, 'closed');
  assert.equal(db.claimNextTask(), undefined, 'closed without merging does not release it');

  // A closed PR is never merged: the dependency runs again, opens a new PR and that one is merged.
  rerun(db, dep.id);
  openPr(db, dep.id, 'https://x/pull/31');
  settlePr(db, dep.id, 'merged');
  assert.equal(db.claimNextTask()!.id, later.id);
});

test('--after rejects a task that does not exist, and a failed dependency never releases', async () => {
  await assert.rejects(() => addTask(db, { repo: 'demo', prompt: 'x', builds_on: [99999] }), /can't build on #99999: no such task/);
  const dep = db.addTask({ repo_id: repo.id, title: 'will fail', prompt: 'x' });
  await addTask(db, { repo: 'demo', prompt: 'never', builds_on: [dep.id] });
  const claimed = db.claimNextTask()!;
  assert.equal(claimed.id, dep.id);
  db.applyEvent(dep.id, { type: 'finish', outcome: 'blocked' }, { reason: 'stuck' });
  assert.equal(db.claimNextTask(), undefined);
});

test('a dependent is not claimed while its dependency pushes and opens its PR', async () => {
  updateRepo(db, 'demo', { pr_mode: 'draft' });
  const dep = db.addTask({ repo_id: repo.id, title: 'slow push', prompt: 'FAKE_DONE slow' });
  const later = await addTask(db, { repo: 'demo', prompt: 'after the slow push', builds_on: [dep.id] });
  db.setSetting('max_concurrent', '2');

  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let pushing!: () => void;
  const pushStarted = new Promise<void>((r) => (pushing = r));
  const realPush = github.push;
  github.push = async (repoPath, branch) => {
    if (branch === dep.branch || branch === `agentdeck/task-${dep.id}`) {
      pushing();
      await gate;
    }
    return realPush(repoPath, branch);
  };
  try {
    const running = new Scheduler(db, { once: true, tickMs: 10, log: () => {} }).run();
    await pushStarted;
    // The task is done, the push is still going: the PR does not exist yet.
    assert.equal(db.getTask(dep.id)!.status, 'done');
    assert.equal(db.getTask(dep.id)!.pr_url, null);
    await new Promise((r) => setTimeout(r, 150)); // several scheduler ticks
    assert.equal(db.getTask(later.id)!.status, 'queued', 'held while the PR is being opened');
    assert.deepEqual(waitingFor(db, db.getTask(later.id)!), { on: [dep.id], stuck: null });

    release();
    const deadline = Date.now() + 5000;
    while (db.getTask(dep.id)!.pr_state !== 'open' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(db.getTask(later.id)!.status, 'queued', 'held while the PR is open');
    await running;
  } finally {
    github.push = realPush;
    db.setSetting('max_concurrent', '1');
  }
  settlePr(db, dep.id, 'merged');
  assert.equal(db.claimNextTask()!.id, later.id);
});

test('a dependent is stuck, not released, when its dependency PR could not be opened', async () => {
  updateRepo(db, 'demo', { pr_mode: 'draft' });
  pushError = 'remote: Permission denied (publickey)';
  const dep = db.addTask({ repo_id: repo.id, title: 'no push', prompt: 'FAKE_DONE nopush' });
  const later = await addTask(db, { repo: 'demo', prompt: 'after the failed push', builds_on: [dep.id] });
  await drain();

  assert.equal(db.getTask(dep.id)!.status, 'done');
  assert.equal(db.getTask(later.id)!.status, 'queued');
  assert.deepEqual(waitingFor(db, db.getTask(later.id)!), { on: [dep.id], stuck: `#${dep.id}'s PR could not be opened` });
  assert.equal(db.claimNextTask(), undefined);
});

/** Notifications about task `id`'s dependents being stuck. */
const stuckNotices = (id: number) => db.recentNotifications(50).filter((n) => n.task_id === id && /can't start/.test(n.title));

test('a blocked dependency notifies once, naming the waiting task, which stays queued until a retry', async () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'gets blocked', prompt: 'FAKE_BLOCKED nope' });
  const later = await addTask(db, { repo: 'demo', prompt: 'needs the first', title: 'Second step', builds_on: [dep.id] });
  await drain();

  assert.equal(db.getTask(dep.id)!.status, 'blocked');
  assert.equal(db.getTask(later.id)!.status, 'queued');
  const notices = stuckNotices(dep.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'blocked');
  assert.match(notices[0].title, /1 task can't start: #\d+ is blocked/);
  assert.match(notices[0].body, new RegExp(`#${later.id} Second step`));
  assert.match(notices[0].body, new RegExp(`Retry #${dep.id}`));
  assert.deepEqual(waitingFor(db, db.getTask(later.id)!), { on: [dep.id], stuck: `#${dep.id} is blocked` });

  // A retry puts the dependency back on its way: no longer stuck, and done releases the dependent.
  retryTask(db, dep.id);
  assert.deepEqual(waitingFor(db, db.getTask(later.id)!), { on: [dep.id], stuck: null });
  assert.equal(finishNext(), dep.id);
  assert.equal(waitingFor(db, db.getTask(later.id)!), null);
  assert.equal(finishNext(), later.id);
});

test('a failure that will be retried does not notify, a final one does', async () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'errors', prompt: 'FAKE_ERROR', max_attempts: 2 });
  await addTask(db, { repo: 'demo', prompt: 'after errors', builds_on: [dep.id] });
  await drain();
  assert.equal(db.getTask(dep.id)!.status, 'failed');
  assert.equal(db.runsForTask(dep.id).length, 2);
  assert.equal(stuckNotices(dep.id).length, 1, 'only the final failure notifies');
});

test('cancelling a dependency notifies; cancelling a task nobody waits on does not', async () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'to cancel', prompt: 'x' });
  await addTask(db, { repo: 'demo', prompt: 'after the cancel', builds_on: [dep.id] });
  const alone = db.addTask({ repo_id: repo.id, title: 'alone', prompt: 'x' });
  cancelTask(db, dep.id);
  cancelTask(db, alone.id);
  assert.match(stuckNotices(dep.id)[0].title, /was cancelled/);
  assert.equal(stuckNotices(alone.id).length, 0);
});

test('a dependency PR closed without merging notifies when the refresh sees it', async () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'pr gets closed', prompt: 'x' });
  const later = await addTask(db, { repo: 'demo', prompt: 'after the closed pr', builds_on: [dep.id] });
  assert.equal(finishNext(), dep.id);
  openPr(db, dep.id, 'https://x/pull/40');
  assert.equal(stuckNotices(dep.id).length, 0);

  states = { 'https://x/pull/40': 'closed' };
  await refreshPrStates(db);
  assert.match(stuckNotices(dep.id)[0].title, /PR was closed without merging/);
  assert.equal(waitingFor(db, db.getTask(later.id)!)?.stuck, `#${dep.id}'s PR was closed without merging`);
  db.applyEvent(later.id, { type: 'cancel' });
});

/** A done task with an open PR, as if the daemon had opened it. */
function prTask(n: number, title = `merge ${n}`) {
  const url = `https://github.com/acme/demo/pull/${n}`;
  const t = doneTask(db, repo, { title, pr: 'open', url });
  db.setCheckout(t.id, { branch: `agentdeck/task-${t.id}` });
  return { id: t.id, url };
}

test('mergeCheck: blocking problems and warnings', () => {
  const pr = { ...cleanDetails };
  assert.deepEqual(mergeCheck({ pr_state: 'open', pr, tests_passed: 1 }), { problems: [], warnings: [] });
  assert.deepEqual(mergeCheck({ pr_state: 'merged', pr, tests_passed: 1 }).problems, ['the PR is merged']);
  assert.match(mergeCheck({ pr_state: 'open', pr: { ...pr, mergeable: 'CONFLICTING' }, tests_passed: 1 }).problems[0], /conflicts/);
  assert.match(mergeCheck({ pr_state: 'open', pr: { ...pr, merge_state: 'DIRTY' }, tests_passed: 1 }).problems[0], /conflicts/);

  const warned = mergeCheck({
    pr_state: 'open',
    pr: { ...pr, draft: true, merge_state: 'BEHIND', checks: { total: 4, failing: 1, pending: 2 } },
    tests_passed: 0,
  });
  assert.deepEqual(warned.problems, []);
  assert.equal(warned.warnings.length, 5);
  assert.match(warned.warnings.join('\n'), /draft[^]*moved on[^]*tests failed[^]*1 check failing[^]*2 checks still running/);
  assert.equal(mergeCheck({ pr_state: 'open', pr, tests_passed: null }).warnings.length, 0, 'tests that never ran are not a warning');
});

test('parsePrDetails reads gh output, counting failing and pending checks', () => {
  const d = parsePrDetails(
    JSON.stringify({
      state: 'OPEN',
      isDraft: true,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BEHIND',
      commits: [{}, {}, {}],
      additions: 12,
      deletions: 3,
      changedFiles: 5,
      files: [{ path: 'a.ts', additions: 1 }, { path: 'docs/b.md' }, {}],
      labels: [{ name: 'agentdeck:auto-merge', color: 'ededed' }],
      statusCheckRollup: [
        { status: 'COMPLETED', conclusion: 'SUCCESS' },
        { status: 'COMPLETED', conclusion: 'FAILURE' },
        { status: 'IN_PROGRESS', conclusion: '' },
        { state: 'ERROR' },
        { state: 'PENDING' },
        { status: 'COMPLETED', conclusion: 'SKIPPED' },
      ],
    }),
  );
  const { check_list, head, ...rest } = d;
  assert.deepEqual(rest, {
    state: 'open',
    draft: true,
    mergeable: 'MERGEABLE',
    merge_state: 'BEHIND',
    commits: 3,
    files: 5,
    additions: 12,
    deletions: 3,
    checks: { total: 6, failing: 2, pending: 2 },
    paths: ['a.ts', 'docs/b.md'],
    labels: ['agentdeck:auto-merge'],
  });
  assert.deepEqual(
    check_list?.map((c) => c.state),
    ['pass', 'fail', 'pending', 'fail', 'pending', 'skipped'],
  );
  assert.equal(head, null, 'no headRefOid in the output');
});

test('repo merge_method defaults to squash and rejects unknown values', () => {
  assert.equal(repo.merge_method, 'squash');
  assert.throws(() => updateRepo(db, 'demo', { merge_method: 'fast-forward' as never }), ActionError);
  assert.equal(updateRepo(db, 'demo', { merge_method: 'rebase' }).merge_method, 'rebase');
  assert.equal(updateRepo(db, 'demo', { merge_method: 'squash' }).merge_method, 'squash');
});

test('mergePreview shows the PR, the repo default method and the tasks the merge unblocks', async () => {
  const t = prTask(100, 'Preview me');
  const later = await addTask(db, { repo: 'demo', prompt: 'follow-up', builds_on: [t.id], title: 'Follow-up' });
  details[t.url] = { ...cleanDetails, checks: { total: 3, failing: 1, pending: 0 } };

  const p = await mergePreview(db, t.id);
  assert.equal(p.title, 'Preview me');
  assert.equal(p.method, 'squash');
  assert.equal(p.base, 'main');
  assert.equal(p.branch, `agentdeck/task-${t.id}`);
  assert.equal(p.commits, 3);
  assert.deepEqual([p.files, p.additions, p.deletions], [2, 10, 4]);
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.warnings, ['1 check failing on GitHub']);
  assert.deepEqual(p.unblocks, [{ id: later.id, title: 'Follow-up' }]);
  assert.equal(merging.merged.length, 0, 'a preview merges nothing');
  db.applyEvent(later.id, { type: 'cancel' });
});

test('mergeTask squashes by default, records it, and releases the tasks waiting on the PR', async () => {
  const t = prTask(101, 'Ship it');
  const later = await addTask(db, { repo: 'demo', prompt: 'after the merge', builds_on: [t.id] });
  assert.ok(waitingFor(db, db.getTask(later.id)!), 'waits while the PR is open');

  const res = await mergeTask(db, t.id);
  assert.deepEqual(res, { method: 'squash', unblocked: [later.id] });
  assert.equal(merging.merged.length, 1);
  assert.equal(merging.merged[0].url, t.url);
  assert.equal(merging.merged[0].method, 'squash');
  assert.equal(merging.merged[0].subject, 'Ship it');
  assert.ok(merging.merged[0].body!.endsWith(`Made by AgentDeck task #${t.id}.`));
  assert.deepEqual(merging.ready, [], 'not a draft, so nothing to mark ready');
  assert.deepEqual(merging.deleted, [], 'the branch stays unless asked');

  const after = db.getTask(t.id)!;
  assert.equal(after.status, 'done');
  assert.equal(after.pr_state, 'merged');
  assert.equal(after.merge_method, 'squash');
  const event = db.eventsForTask(t.id).at(-1)!;
  assert.deepEqual([event.type, event.from_status, event.to_status, event.reason], ['merge', 'done', 'done', 'squash merge']);
  assert.equal(waitingFor(db, db.getTask(later.id)!), null, 'merged releases the dependent at once');
  db.applyEvent(later.id, { type: 'cancel' });

  await assert.rejects(mergeTask(db, t.id), /PR is merged/, 'a second merge is refused');
});

test('mergeTask uses the method asked for, then the repo default; a draft is marked ready first', async () => {
  const a = prTask(102);
  details[a.url] = { ...cleanDetails, draft: true };
  await mergeTask(db, a.id, { method: 'rebase' });
  assert.deepEqual(merging.ready, [a.url]);
  assert.equal(merging.merged[0].method, 'rebase');
  assert.equal(db.getTask(a.id)!.merge_method, 'rebase');

  updateRepo(db, 'demo', { merge_method: 'merge' });
  const b = prTask(103);
  assert.equal((await mergePreview(db, b.id)).method, 'merge');
  await mergeTask(db, b.id);
  assert.equal(merging.merged[1].method, 'merge');
  updateRepo(db, 'demo', { merge_method: 'squash' });
});

test('a task merged with rebase, retried and given a new PR, previews and merges with the repo method', async () => {
  const t = prTask(150);
  await mergeTask(db, t.id, { method: 'rebase' });
  assert.equal(db.getTask(t.id)!.merge_method, 'rebase');

  const again = `https://github.com/acme/demo/pull/151`;
  assert.ok(db.recordPr(t.id, { type: 'opened', url: again }));
  assert.equal((await mergePreview(db, t.id)).method, 'squash', 'the old method is not the default');
  const before = merging.merged.length;
  assert.equal((await mergeTask(db, t.id)).method, 'squash');
  assert.equal(merging.merged[before].method, 'squash');
});

test('mergeTask refuses what cannot be merged and leaves the task as it was', async () => {
  const conflicted = prTask(104);
  details[conflicted.url] = { ...cleanDetails, mergeable: 'CONFLICTING' };
  await assert.rejects(mergeTask(db, conflicted.id), /conflicts/);

  const t = prTask(105);
  await assert.rejects(mergeTask(db, t.id, { method: 'fast-forward' }), /method must be one of/);
  mergeError = 'Pull request is not mergeable: branch protection';
  await assert.rejects(mergeTask(db, t.id), /merge failed: Pull request is not mergeable/);
  mergeError = null;

  const queued = db.addTask({ repo_id: repo.id, title: 'not done', prompt: 'x' });
  await assert.rejects(mergeTask(db, queued.id), /only a done task can be merged/);
  db.applyEvent(queued.id, { type: 'cancel' });
  const noPr = doneTask(db, repo, { title: 'no pr' });
  await assert.rejects(mergeTask(db, noPr.id), /has no pull request/);
  await assert.rejects(mergeTask(db, 999999), /no such task/);

  assert.equal(merging.merged.length, 0);
  for (const id of [conflicted.id, t.id]) {
    assert.equal(db.getTask(id)!.pr_state, 'open');
    assert.equal(db.getTask(id)!.merge_method, null);
    assert.ok(!db.eventsForTask(id).some((e) => e.type === 'merge'));
  }
});

test('mergeAll merges each PR, one that lands after another once that one has, and says why the rest stay open', async () => {
  const [first, later, conflicted, held] = [prTask(110), prTask(111), prTask(112), prTask(113)];
  linkTasks(db, later.id, { on: first.id, kind: 'after' });
  details[conflicted.url] = { ...cleanDetails, mergeable: 'CONFLICTING' };
  const outside = db.addTask({ repo_id: repo.id, title: 'not landed', prompt: 'x' });
  linkTasks(db, held.id, { on: outside.id, kind: 'after' });

  // `later` comes first and waits for the round in which `first` merged; a repeated id merges once.
  const res = await mergeAll(db, { ids: [later.id, conflicted.id, first.id, held.id, first.id] });
  assert.deepEqual(
    res.merged.map((m) => [m.id, m.method]),
    [
      [first.id, 'squash'],
      [later.id, 'squash'],
    ],
  );
  assert.deepEqual(
    merging.merged.map((m) => m.url),
    [first.url, later.url],
  );
  assert.deepEqual(
    merging.deleted,
    [`agentdeck/task-${first.id}`, `agentdeck/task-${later.id}`],
    'the branches go, as after an auto-merge',
  );
  assert.deepEqual(
    res.skipped.map((s) => s.id),
    [conflicted.id, held.id],
  );
  assert.equal(
    res.skipped[0].reason,
    'the branch has conflicts with the base branch',
    'the entry has the id; the reason does not repeat it',
  );
  assert.match(res.skipped[1].reason, new RegExp(`^lands after #${outside.id}`));
  assert.deepEqual(
    res.skipped.map((s) => s.conflicting),
    [true, false],
    'only the conflict with the base branch can be settled by a sync',
  );
  for (const id of [conflicted.id, held.id]) assert.equal(db.getTask(id)!.pr_state, 'open');
  db.applyEvent(outside.id, { type: 'cancel' });

  assert.deepEqual(await mergeAll(db, { ids: [] }), { merged: [], skipped: [] });
});

test('mergeTask can delete the remote branch and remove the worktree, and reports a cleanup that fails', async () => {
  updateRepo(db, 'demo', { pr_mode: 'ready' });
  const task = db.addTask({ repo_id: repo.id, title: 'Clean up after', prompt: 'FAKE_DONE cleanup' });
  await drain();
  const t = db.getTask(task.id)!;
  assert.ok(t.worktree && t.pr_url);

  const res = await mergeTask(db, t.id, { delete_branch: true });
  assert.equal(res.cleanup_error, undefined);
  assert.deepEqual(merging.deleted, [t.branch]);
  const after = db.getTask(t.id)!;
  assert.equal(after.worktree, null);
  assert.equal(after.branch, t.branch, 'the local branch stays, so the diff can still be read');
  assert.equal(sh(dir, 'branch', '--list', t.branch!), t.branch);

  const other = prTask(106);
  github.deleteRemoteBranch = async () => {
    throw new Error('remote ref does not exist');
  };
  const failed = await mergeTask(db, other.id, { delete_branch: true });
  assert.match(failed.cleanup_error!, /remote branch: remote ref does not exist/);
  assert.equal(db.getTask(other.id)!.pr_state, 'merged', 'the merge stands');
});
