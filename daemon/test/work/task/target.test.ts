// A task with a target starts its worktree from that branch, syncs with it and opens its PR into it; targets are checked at add and edit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-target-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('#db/index.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { addTask, editTask, linkTasks, syncNow, updateRepo } = await import('#application/actions.ts');
const { testApp, waitFor } = await import('#test/fixtures/fixtures.ts');
const { fakeCodeHost } = await import('#test/fixtures/fakes.ts');

const host = fakeCodeHost();
const db = testApp(openDb(join(home, 'agentdeck.db')), { codeHost: host });
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), '# demo\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
sh(dir, 'checkout', '-q', '-b', 'release');
writeFileSync(join(dir, 'release.txt'), 'only on release\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'release only');
sh(dir, 'checkout', '-q', 'main');
db.addRepo({ name: 'demo', path: dir, base_branch: 'main' });
updateRepo(db, 'demo', { pr_mode: 'ready' });

test('a task targeting release starts from release, syncs with it and opens its PR into it', async () => {
  const task = await addTask(db, { repo: 'demo', prompt: 'FAKE_DONE change something', target: 'release' });
  assert.equal(task.target, 'release');
  await drain();
  const done = db.getTask(task.id);
  assert.equal(done?.status, 'done');
  const wt = done?.checkout?.worktree ?? '';
  assert.ok(existsSync(join(wt, 'release.txt')), 'the worktree started from release');

  const opened = await waitFor(() => host.created.find((pr) => pr.head === done?.checkout?.branch), { what: 'the PR' });
  assert.equal(opened.base, 'release');

  sh(dir, 'checkout', '-q', 'release');
  writeFileSync(join(dir, 'later.txt'), 'later on release\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'later on release');
  sh(dir, 'checkout', '-q', 'main');
  writeFileSync(join(dir, 'main-only.txt'), 'only on main\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'main only');

  const synced = await syncNow(db, task.id);
  assert.equal(synced.outcome, 'clean');
  assert.ok(existsSync(join(wt, 'later.txt')), 'the sync merged release');
  assert.ok(!existsSync(join(wt, 'main-only.txt')), 'and not the base');
  assert.match(db.eventsForTask(task.id).find((e) => e.type === 'sync')?.reason ?? '', /release/);

  await assert.rejects(editTask(db, task.id, { target: 'main' }), /#\d+ is done|has a branch already/);
});

test('a target must exist, and is fixed once the task has a branch', async () => {
  await assert.rejects(
    addTask(db, { repo: 'demo', prompt: 'nowhere', target: 'nope', propose: true }),
    /no branch nope locally or as origin\/nope/,
  );

  const base = await addTask(db, { repo: 'demo', prompt: 'on the base', target: 'main', propose: true });
  assert.equal(base.target, null, 'naming the base stores no target');

  const edited = await editTask(db, base.id, { target: 'release' });
  assert.equal(edited.target, 'release');
  assert.equal((await editTask(db, base.id, { target: '' })).target, null);

  db.setCheckout(base.id, { branch: 'agentdeck/task-x' });
  await assert.rejects(
    editTask(db, base.id, { target: 'release' }),
    /has a branch already \(agentdeck\/task-x\), so its target can't change/,
  );
});

test('a builds-on link across targets is refused at add and at link; an after link is allowed', async () => {
  const onRelease = await addTask(db, { repo: 'demo', prompt: 'on release', target: 'release', propose: true });
  await assert.rejects(
    addTask(db, { repo: 'demo', prompt: 'on main', builds_on: [onRelease.id], propose: true }),
    new RegExp(`the new task targets main and #${onRelease.id} targets release`),
  );
  const onMain = await addTask(db, { repo: 'demo', prompt: 'on main', after: [onRelease.id], propose: true });
  assert.throws(() => linkTasks(db, onMain.id, { on: onRelease.id, kind: 'builds_on' }), /targets main and #\d+ targets release/);

  const alsoRelease = await addTask(db, {
    repo: 'demo',
    prompt: 'also release',
    target: 'release',
    builds_on: [onRelease.id],
    propose: true,
  });
  await assert.rejects(editTask(db, alsoRelease.id, { target: '' }), /targets main and #\d+ targets release/);
});
