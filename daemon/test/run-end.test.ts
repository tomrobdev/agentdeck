// Every run row ends: a throw after a work or resolve run opens its row ends it failed, once, through endTaskRun.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-run-end-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { syncBranch } = await import('../src/application/sync.ts');
const { endTaskRun, openTaskRun } = await import('../src/application/run/claude-run.ts');
const { updateRepo } = await import('../src/application/actions.ts');
const { LOG_DIR } = await import('../src/config.ts');

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'shared.txt'), 'one\ntwo\nthree\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main' });
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

test('a throw in the work run after its row opens ends the row failed', async () => {
  const task = db.addTask({ repo_id: repo.id, title: 'first', prompt: 'FAKE_DONE' });
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'done');

  // The base branch goes missing: commitsAhead (git rev-list) throws after claude finished.
  updateRepo(db, 'demo', { base_branch: 'gone' });
  db.applyEvent(task.id, { type: 'retry' });
  await drain();
  updateRepo(db, 'demo', { base_branch: 'main' });

  const last = db.runsForTask(task.id).at(-1)!;
  assert.ok(last.ended_at, 'the run row is ended');
  assert.equal(last.outcome, 'failed');
  assert.ok(last.result_text);
  assert.equal(db.slotsUsed(), 0);
});

test('a resolve run that cannot start ends failed and frees its slot', async () => {
  const task = db.addTask({ repo_id: repo.id, title: 'resolver', prompt: 'FAKE_DONE' });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  const worktree = t.checkout!.worktree!;
  writeFileSync(join(worktree, 'shared.txt'), 'one\ntask\nthree\n');
  sh(worktree, 'commit', '-q', '-am', 'task change');
  writeFileSync(join(dir, 'shared.txt'), 'one\nmain\nthree\n');
  sh(dir, 'commit', '-q', '-am', 'main change');

  // Make the run's settings file unwritable: a directory sits where it goes.
  const realNow = Date.now;
  Date.now = () => 424242;
  mkdirSync(join(LOG_DIR, `task-${t.id}-resolve-424242.settings.json`), { recursive: true });
  let result;
  try {
    result = await syncBranch(db, t, repo, worktree, { allowResolve: true, runTests: false });
  } finally {
    Date.now = realNow;
  }
  assert.equal(result.kind, 'failed');
  const resolve = db.runsForTask(t.id).filter((r) => r.kind === 'resolve');
  assert.equal(resolve.length, 1);
  assert.ok(resolve[0].ended_at);
  assert.equal(resolve[0].outcome, 'failed');
  assert.equal(db.slotsUsed(), 0);
  assert.equal(db.hasRunningResolve(t.id), false);
  assert.equal(sh(worktree, 'status', '--porcelain'), '', 'the merge was undone');
});

test('a run row is never finished twice', async () => {
  const task = db.addTask({ repo_id: repo.id, title: 'once', prompt: 'x' });
  const opened = openTaskRun(db, task, 'work');
  await endTaskRun(db, opened, 'done');
  await endTaskRun(db, opened, 'failed', 'later throw');
  const run = db.runsForTask(task.id).find((r) => r.id === opened.runId)!;
  assert.equal(run.outcome, 'done');
  assert.equal(run.result_text, null);
});
