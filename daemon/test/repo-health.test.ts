// Repo doctor, paused repos and task editing: real git worktrees and SQLite, fake claude binary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { type TaskId, asTaskId } from '../src/domain/shared/id.ts';
import type { TaskEvent } from '../src/domain/work/lifecycle.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-health-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('./open-db.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { doctorRepo, editTask, resumeRepo, ActionError } = await import('../src/application/actions.ts');
const { runDoctor } = await import('../src/application/repos/doctor.ts');

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

function gitRepo(name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A registered repo that passes doctor unless `over` breaks something. */
function repo(name: string, over: Partial<Parameters<typeof db.addRepo>[0]> = {}) {
  return db.addRepo({
    name,
    path: gitRepo(name),
    base_branch: 'main',
    test_cmd: 'test -f README.md',
    toolchain: 'npm',
    allowed_tools: ['Read', 'Bash(test *)'],
    ...over,
  });
}

const byName = (checks: { name: string; ok: boolean; reason: string }[]) => Object.fromEntries(checks.map((c) => [c.name, c]));
const worktrees = (path: string) => sh(path, 'worktree', 'list').split('\n');
const doctorDirs = () => {
  const root = join(home, 'worktrees');
  return existsSync(root) ? readdirSync(root).flatMap((r) => readdirSync(join(root, r)).filter((d) => d.startsWith('scratch-'))) : [];
};

test('doctor passes on a healthy repo, clears a pause, and leaves no worktree behind', async () => {
  const r = repo('healthy', { setup_cmd: 'echo setting up > setup-ran.txt' });
  db.setRepoPaused(r.id, 'doctor: tests');

  const report = await doctorRepo(db, 'healthy');
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.deepEqual(
    report.checks.map((c) => c.name),
    ['git repo', 'base branch', 'toolchain', 'claude binary', 'setup', 'tests', 'tool rules'],
  );
  assert.ok(
    report.checks.every((c) => c.reason),
    'every check says why',
  );
  assert.equal(report.paused_reason, null);
  assert.equal(db.getRepo(r.id)!.paused_reason, null);
  assert.equal(worktrees(r.path).length, 1, 'temporary worktree removed');
  assert.deepEqual(doctorDirs(), []);
});

test('a repo without a toolchain is not a doctor failure', async () => {
  repo('no-toolchain', { toolchain: null });
  const report = await doctorRepo(db, 'no-toolchain');
  const check = report.checks.find((k) => k.name === 'toolchain')!;
  assert.equal(check.ok, true);
});

test('doctor fails and pauses the repo with the first failed check', async () => {
  const cases: {
    name: string;
    over: Partial<Parameters<typeof db.addRepo>[0]>;
    failed: string[];
    reason: RegExp;
  }[] = [
    { name: 'no-tests', over: { test_cmd: null }, failed: ['tests'], reason: /no test command/ },
    { name: 'bad-base', over: { base_branch: 'm3-governor' }, failed: ['base branch', 'tests'], reason: /no branch m3-governor/ },
    { name: 'failing-tests', over: { test_cmd: 'false', allowed_tools: ['Bash(false)'] }, failed: ['tests'], reason: /false failed/ },
    {
      name: 'failing-setup',
      over: { setup_cmd: 'echo "ERR no network" >&2; exit 3' },
      failed: ['setup', 'tests'],
      reason: /ERR no network/,
    },
    // incident 4: the test command is pnpm but the rules only know npm
    {
      name: 'wrong-rules',
      over: { test_cmd: 'pnpm check && pnpm test', allowed_tools: ['Bash(npm test*)'], setup_cmd: null },
      failed: ['tests', 'tool rules'],
      reason: /don't allow: pnpm check, pnpm test/,
    },
  ];
  for (const c of cases) {
    const r = repo(c.name, c.over);
    const report = await doctorRepo(db, c.name);
    assert.equal(report.ok, false, c.name);
    const checks = byName(report.checks);
    assert.deepEqual(
      report.checks.filter((k) => !k.ok).map((k) => k.name),
      c.failed,
      c.name,
    );
    const why = report.checks.find((k) => !k.ok && c.reason.test(k.reason))?.reason ?? '';
    assert.match(why, c.reason, `${c.name}: ${JSON.stringify(checks)}`);
    assert.equal(db.getRepo(r.id)!.paused_reason, `doctor: ${c.failed[0]}`, c.name);
    assert.equal(worktrees(r.path).length, 1, `${c.name}: temporary worktree removed even on failure`);
  }
  assert.deepEqual(doctorDirs(), []);
  const pauses = db.recentNotifications(50).filter((n) => n.kind === 'paused');
  assert.ok(pauses.length >= cases.length, 'each pause notifies');
  assert.equal(db.recentNotifications(50).filter((n) => n.kind === 'hold').length, 0, 'a pause is not a governor hold');
});

test('doctor reports a missing repo, a missing claude binary, and PR mode without gh or origin', async () => {
  const gone = db.addRepo({ name: 'gone', path: join(home, 'does-not-exist'), base_branch: 'main' });
  const report = await doctorRepo(db, 'gone');
  assert.deepEqual(
    report.checks.map((c) => [c.name, c.ok]),
    [['git repo', false]],
  );
  assert.equal(db.getRepo(gone.id)!.paused_reason, 'doctor: git repo');

  const r = repo('no-claude');
  process.env.AGENTDECK_CLAUDE_BIN = join(home, 'no-such-claude');
  try {
    const checks = byName(await runDoctor(db, r));
    assert.equal(checks['claude binary'].ok, false);
    assert.match(checks['claude binary'].reason, /not found/);
  } finally {
    process.env.AGENTDECK_CLAUDE_BIN = fake;
  }

  // Without a pr_mode (it doesn't exist yet) there are no PR checks; with one, origin is required.
  assert.equal(byName(await runDoctor(db, r))['origin remote'], undefined);
  const pr = byName(await runDoctor(db, { ...r, pr_mode: 'draft' } as typeof r));
  assert.equal(pr['origin remote'].ok, false);
  assert.ok(pr['gh auth'], 'gh auth is checked too');
  assert.equal(byName(await runDoctor(db, { ...r, pr_mode: 'off' } as typeof r))['gh auth'], undefined);
});

test("a paused repo's tasks are not claimed; resuming releases them", async () => {
  const paused = repo('paused-repo');
  const active = repo('active-repo');
  const stuck = db.addTask({ repo_id: paused.id, title: 'stuck', prompt: 'FAKE_DONE one', priority: 9 });
  const other = db.addTask({ repo_id: active.id, title: 'other', prompt: 'FAKE_DONE two' });
  db.setRepoPaused(paused.id, 'doctor: tests');

  assert.equal(db.claimNextTask()?.id, other.id, 'skips the higher-priority task of the paused repo');
  assert.equal(db.claimNextTask(), undefined);
  assert.equal(db.hasQueued(), false, 'paused work does not count as claimable work');
  db.applyEvent(other.id, { type: 'cancel' });

  await drain(); // once mode returns because nothing can be claimed
  assert.equal(db.getTask(stuck.id)!.status, 'queued');
  assert.equal(db.getTask(stuck.id)!.attempts, 0);

  assert.equal(resumeRepo(db, 'paused-repo').paused_reason, null);
  await drain();
  assert.equal(db.getTask(stuck.id)!.status, 'done');
});

test('a repo that is already paused keeps its first reason', () => {
  const r = repo('first-reason');
  assert.equal(db.pauseRepo(r.id, 'setup failed on task #1'), true);
  assert.equal(db.pauseRepo(r.id, 'permission refused on task #2: x'), false);
  assert.equal(db.getRepo(r.id)!.paused_reason, 'setup failed on task #1');
});

test('a failing setup pauses the repo and notifies', async () => {
  const r = repo('setup-fails', { setup_cmd: 'exit 3' });
  const first = db.addTask({ repo_id: r.id, title: 'first', prompt: 'FAKE_DONE first', priority: 2 });
  const second = db.addTask({ repo_id: r.id, title: 'second', prompt: 'FAKE_DONE second' });
  const pauses = () => db.recentNotifications(100).filter((n) => n.kind === 'paused' && n.title.includes('setup-fails'));

  await drain();
  assert.equal(db.getTask(first.id)!.status, 'blocked');
  assert.equal(db.getTask(second.id)!.status, 'queued', 'the next task waits instead of failing the same way');
  assert.equal(db.getRepo(r.id)!.paused_reason, `setup failed on task #${first.id}`);
  assert.equal(pauses().length, 1);
  assert.match(pauses()[0].body, /agentdeck repo resume setup-fails/);
});

test('a refused tool use that ends a run pauses the repo and counts denials on the run', async () => {
  const r = repo('denied', { allowed_tools: ['Read'] });
  const blocked = db.addTask({ repo_id: r.id, title: 'blocked', prompt: 'FAKE_DENIED prettier', priority: 2 });
  const next = db.addTask({ repo_id: r.id, title: 'next', prompt: 'FAKE_DONE next' });

  await drain();
  const t = db.getTask(blocked.id)!;
  assert.equal(t.status, 'blocked');
  assert.equal(db.runsForTask(t.id)[0].denials, 2);
  assert.equal(db.getRepo(r.id)!.paused_reason, `permission refused on task #${t.id}: npx prettier --write .`);
  assert.equal(db.getTask(next.id)!.status, 'queued');
  assert.equal(db.recentNotifications(100).filter((n) => n.kind === 'paused' && n.title.includes('denied')).length, 1);

  // A run that got through despite refusals records them but doesn't pause the repo.
  resumeRepo(db, 'denied');
  db.applyEvent(blocked.id, { type: 'cancel' });
  db.applyEvent(next.id, { type: 'cancel' });
  const done = db.addTask({ repo_id: r.id, title: 'worked around', prompt: 'FAKE_DENIED_DONE go' });
  await drain();
  assert.equal(db.getTask(done.id)!.status, 'done');
  assert.equal(db.runsForTask(done.id)[0].denials, 2);
  assert.equal(db.getRepo(r.id)!.paused_reason, null);
});

test('a refused tool use the worker reported as a need blocks the task without pausing the repo', async () => {
  const r = repo('denied-needs');
  const t = db.addTask({ repo_id: r.id, title: 'settings', prompt: 'FAKE_DENIED_NEEDS settings', priority: 2 });
  const next = db.addTask({ repo_id: r.id, title: 'next', prompt: 'FAKE_DONE next' });
  await drain();
  assert.equal(db.getTask(t.id)!.status, 'blocked');
  assert.equal(db.runsForTask(t.id)[0].denials, 2);
  assert.equal(db.getRepo(r.id)!.paused_reason, null);
  assert.equal(db.getTask(next.id)!.status, 'done');
});

test('a run that finishes despite refusals but fails its tests does not pause the repo', async () => {
  const r = repo('denied-tests', { test_cmd: 'false' });
  const t = db.addTask({ repo_id: r.id, title: 'formatting', prompt: 'FAKE_DENIED_DONE go', max_attempts: 1 });
  await drain();
  assert.equal(db.getTask(t.id)!.status, 'failed');
  assert.equal(db.runsForTask(t.id)[0].denials, 2);
  assert.equal(db.getRepo(r.id)!.paused_reason, null);
});

test('edit changes the fields of a proposed, queued, blocked or failed task', async () => {
  const r = repo('edits');
  const task = db.addTask({ repo_id: r.id, title: 'old', prompt: 'old prompt', status: 'proposed' });

  const patch = { title: ' New title ', prompt: 'new prompt', priority: 3, model: 'opus', max_turns: 12, max_attempts: 4 };
  const t = await editTask(db, task.id, patch);
  assert.deepEqual(
    [t.title, t.prompt, t.priority, t.model, t.max_turns, t.max_attempts, t.status],
    ['New title', 'new prompt', 3, 'opus', 12, 4, 'proposed'],
  );
  assert.equal((await editTask(db, task.id, { priority: 0 })).title, 'New title', 'other fields are left alone');

  // Queued comes last: claiming below takes the oldest queued task.
  const finishes: Record<string, TaskEvent | undefined> = {
    blocked: { type: 'finish', outcome: 'blocked' },
    failed: { type: 'finish', outcome: 'failed', retry: false },
    queued: undefined,
  };
  for (const [status, event] of Object.entries(finishes)) {
    const s = db.addTask({ repo_id: r.id, title: status, prompt: 'p' });
    if (event) {
      assert.equal(db.claimNextTask()?.id, s.id);
      db.applyEvent(s.id, event);
    }
    assert.equal(db.getTask(s.id)!.status, status);
    assert.equal((await editTask(db, s.id, { max_turns: 5 })).max_turns, 5, status);
    if (!event) db.applyEvent(s.id, { type: 'cancel' });
  }
});

test('edit refuses other statuses, unknown tasks, empty edits and invalid values', async () => {
  const r = repo('edit-refusals');
  const task = db.addTask({ repo_id: r.id, title: 't', prompt: 'p' });
  const refuses = (id: TaskId, patch: Parameters<typeof editTask>[2], message: RegExp) =>
    assert.rejects(
      () => editTask(db, id, patch),
      (err) => err instanceof ActionError && message.test(err.message),
      JSON.stringify(patch),
    );

  await refuses(asTaskId(9999), { title: 'x' }, /no such task/);
  await refuses(task.id, {}, /nothing to change/);
  await refuses(task.id, { title: '  ' }, /title cannot be empty/);
  await refuses(task.id, { prompt: '' }, /prompt cannot be empty/);
  await refuses(task.id, { model: ' ' }, /model cannot be empty/);
  await refuses(task.id, { priority: 1.5 }, /priority must be a whole number/);
  await refuses(task.id, { priority: NaN }, /priority must be a whole number/);
  await refuses(task.id, { max_turns: 0 }, /max_turns must be a whole number from 1/);
  await refuses(task.id, { max_attempts: 0 }, /max_attempts must be a whole number from 1/);
  await refuses(task.id, { max_turns: '9' as never }, /max_turns/);
  assert.equal(db.getTask(task.id)!.title, 't', 'a refused edit changes nothing');
  assert.equal(db.getTask(task.id)!.max_turns, 40);

  db.claimNextTask(); // running
  assert.equal(db.getTask(task.id)!.status, 'running');
  await refuses(task.id, { title: 'x' }, /is running; only proposed, queued, blocked, failed tasks can be edited/);
  db.applyEvent(task.id, { type: 'finish', outcome: 'done' });
  await refuses(task.id, { title: 'x' }, /is done/);
  db.applyEvent(task.id, { type: 'retry' });
  db.applyEvent(task.id, { type: 'cancel' });
  await refuses(task.id, { title: 'x' }, /is cancelled/);
});
