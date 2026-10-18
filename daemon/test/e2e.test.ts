// End-to-end: real git worktrees and SQLite, fake claude binary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-test-'));
process.env.AGENTDECK_HOME = home;
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db.ts');
const { Scheduler } = await import('../src/scheduler.ts');
const { parseStatus } = await import('../src/worker.ts');

const repoPath = join(home, 'demo');
const db = openDb(join(home, 'test.db'));

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

before(() => {
  execFileSync('mkdir', ['-p', repoPath]);
  sh(repoPath, 'init', '-q', '-b', 'main');
  sh(repoPath, 'config', 'user.email', 'test@example.com');
  sh(repoPath, 'config', 'user.name', 'test');
  writeFileSync(join(repoPath, 'README.md'), 'demo\n');
  sh(repoPath, 'add', '-A');
  sh(repoPath, 'commit', '-q', '-m', 'init');
});

after(() => db.close());

const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

test('parseStatus', () => {
  assert.deepEqual(parseStatus('all good\nSTATUS: DONE'), { blocked: false, reason: undefined, declared: true });
  assert.deepEqual(parseStatus('hmm\nSTATUS: BLOCKED: need creds'), { blocked: true, reason: 'need creds', declared: true });
  assert.equal(parseStatus('no status').declared, false);
});

test('done task: worktree, branch, commit, tests, usage recorded', async () => {
  const repo = db.addRepo({ name: 'demo', path: repoPath, base_branch: 'main', test_cmd: 'test -f fake-output.txt' });
  const task = db.addTask({ repo_id: repo.id, title: 'make output', prompt: 'FAKE_DONE please' });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  assert.equal(t.branch, `agentdeck/task-${t.id}`);
  assert.ok(existsSync(join(t.worktree!, 'fake-output.txt')));
  assert.equal(sh(repoPath, 'rev-list', '--count', `main..${t.branch}`), '1');
  assert.equal(sh(repoPath, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'main checkout untouched');

  const [run] = db.runsForTask(t.id);
  assert.equal(run.outcome, 'done');
  assert.equal(run.tests_passed, 1);
  assert.equal(run.output_tokens, 50);
  assert.match(readFileSync(run.log_path, 'utf8'), /"type":"result"/);

  const five = db.usageWindows().find((w) => w.window === 'five_hour');
  assert.equal(five?.utilization, 0.42);
});

test('blocked task keeps the reason', async () => {
  const task = db.addTask({ repo_id: 1, title: 'ask', prompt: 'FAKE_BLOCKED' });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'blocked');
  assert.equal(t.blocked_reason, 'which database?');
});

test('failing task retries up to max_attempts', async () => {
  const task = db.addTask({ repo_id: 1, title: 'boom', prompt: 'FAKE_ERROR', max_attempts: 2 });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'failed');
  assert.equal(t.attempts, 2);
  assert.equal(db.runsForTask(t.id).length, 2);
});

test('rate limit requeues without spending an attempt and holds the queue', async () => {
  const task = db.addTask({ repo_id: 1, title: 'limited', prompt: 'FAKE_RATELIMIT' });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'queued');
  assert.equal(t.attempts, 0);
  assert.ok(Number(db.getSetting('rate_limited_until', '0')) * 1000 > Date.now());
  db.updateTask(t.id, { status: 'cancelled' });
  db.setSetting('rate_limited_until', '0');
});

test('cancel stops a running task', async () => {
  const task = db.addTask({ repo_id: 1, title: 'slow', prompt: 'FAKE_SLOW' });
  const done = drain();
  while (db.getTask(task.id)!.status !== 'running') await new Promise((r) => setTimeout(r, 20));
  db.transitionTask(task.id, ['running'], 'cancel_requested');
  await done;
  assert.equal(db.getTask(task.id)!.status, 'cancelled');
});

test('orphaned running tasks are requeued on start', () => {
  const task = db.addTask({ repo_id: 1, title: 'orphan', prompt: 'x' });
  db.claimNextTask();
  assert.equal(db.recoverOrphans(), 1);
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'queued');
  assert.equal(t.attempts, 0);
  db.updateTask(t.id, { status: 'cancelled' });
});
