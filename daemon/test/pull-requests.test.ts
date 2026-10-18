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
const { Scheduler } = await import('../src/application/scheduler.ts');
const { github } = await import('../src/adapters/github.ts');
const { refreshPrStates } = await import('../src/application/pull-requests.ts');
const { addTask, ActionError, retryTask, updateRepo } = await import('../src/application/actions.ts');
const { isWaiting } = await import('../src/domain/task/dependency.ts');

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
github.prState = async (url) => states[url] ?? 'open';

beforeEach(() => {
  calls = { push: [], create: [] };
  pushError = null;
  states = {};
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
  assert.equal(t.pr_state, null);
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

  db.updateTask(task.id, { pr_state: 'merged' });
  retryTask(db, task.id);
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(calls.create.length, 2, 'a merged PR cannot take new commits');
  assert.notEqual(t.pr_url, first);
  assert.equal(t.pr_state, 'open');
});

test('refreshPrStates updates open PRs of done tasks and leaves a failed lookup alone', async () => {
  const mk = (url: string | null, state: 'open' | 'merged' | 'closed' | null) => {
    const t = db.addTask({ repo_id: repo.id, title: `pr ${url}`, prompt: 'x' });
    db.raw.prepare("UPDATE tasks SET status = 'done', pr_url = ?, pr_state = ? WHERE id = ?").run(url, state, t.id);
    return t.id;
  };
  const merged = mk('https://x/pull/10', 'open');
  const stillOpen = mk('https://x/pull/11', 'open');
  const broken = mk('https://x/pull/12', 'open');
  const alreadyClosed = mk('https://x/pull/13', 'closed');
  const noPr = mk(null, null);
  states = { 'https://x/pull/10': 'merged', 'https://x/pull/13': 'merged' };
  const lookups: string[] = [];
  const real = github.prState;
  github.prState = async (url, cwd) => {
    lookups.push(url);
    if (url.endsWith('/12')) throw new Error('network down');
    return real(url, cwd);
  };
  try {
    await refreshPrStates(db);
  } finally {
    github.prState = real;
  }
  assert.equal(db.getTask(merged)!.pr_state, 'merged');
  assert.equal(db.getTask(stillOpen)!.pr_state, 'open');
  assert.equal(db.getTask(broken)!.pr_state, 'open');
  assert.equal(db.getTask(alreadyClosed)!.pr_state, 'closed', 'only open PRs are looked up');
  assert.equal(db.getTask(noPr)!.pr_state, null);
  assert.ok(!lookups.includes('https://x/pull/13'));
});

test('the scheduler refreshes PR states on its own, not only when work runs', async () => {
  const t = db.addTask({ repo_id: repo.id, title: 'merge me', prompt: 'x' });
  db.raw.prepare("UPDATE tasks SET status = 'done', pr_url = 'https://x/pull/20', pr_state = 'open' WHERE id = ?").run(t.id);
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

test('--after holds a task until its dependency is done', () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'first', prompt: 'x', priority: -5 });
  const later = addTask(db, { repo: 'demo', prompt: 'second', after_task: dep.id, priority: 10 });
  assert.equal(later.after_task, dep.id);
  assert.equal(db.hasQueued(), true);

  // Higher priority, but waiting: the dependency is claimed first.
  assert.equal(db.claimNextTask()!.id, dep.id);
  assert.equal(db.claimNextTask(), undefined, 'dependency is running, so the dependent still waits');
  db.applyEvent(dep.id, { type: 'finish', outcome: 'done' });

  assert.equal(db.claimNextTask()!.id, later.id, 'done with no PR releases the dependent');
});

test('--after waits for the dependency PR to be merged', () => {
  const dep = db.addTask({ repo_id: repo.id, title: 'with pr', prompt: 'x' });
  const later = addTask(db, { repo: 'demo', prompt: 'after the pr', after_task: dep.id });
  assert.equal(finishNext(), dep.id);
  db.updateTask(dep.id, { pr_url: 'https://x/pull/30', pr_state: 'open' });

  assert.equal(db.claimNextTask(), undefined, 'PR still open');
  assert.equal(db.hasQueued(), false, 'a waiting task is not claimable work');
  db.updateTask(dep.id, { pr_state: 'closed' });
  assert.equal(db.claimNextTask(), undefined, 'closed without merging does not release it');

  db.updateTask(dep.id, { pr_state: 'merged' });
  assert.equal(db.claimNextTask()!.id, later.id);
});

test('--after rejects a task that does not exist, and a failed dependency never releases', () => {
  assert.throws(() => addTask(db, { repo: 'demo', prompt: 'x', after_task: 99999 }), /no task #99999/);
  const dep = db.addTask({ repo_id: repo.id, title: 'will fail', prompt: 'x' });
  addTask(db, { repo: 'demo', prompt: 'never', after_task: dep.id });
  const claimed = db.claimNextTask()!;
  assert.equal(claimed.id, dep.id);
  db.applyEvent(dep.id, { type: 'finish', outcome: 'blocked' }, { reason: 'stuck' });
  assert.equal(db.claimNextTask(), undefined);
});

test('isWaiting mirrors the claim rule', () => {
  const done = { status: 'done', pr_url: null, pr_state: null };
  assert.equal(isWaiting({ after_task: null }, undefined), false);
  assert.equal(isWaiting({ after_task: 1 }, undefined), true);
  assert.equal(isWaiting({ after_task: 1 }, { ...done, status: 'running' }), true);
  assert.equal(isWaiting({ after_task: 1 }, done), false);
  assert.equal(isWaiting({ after_task: 1 }, { ...done, pr_url: 'u', pr_state: 'open' }), true);
  assert.equal(isWaiting({ after_task: 1 }, { ...done, pr_url: 'u', pr_state: 'merged' }), false);
});
