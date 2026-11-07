// End-to-end: real git worktrees and SQLite, fake claude binary.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Repo } from '../src/domain/repo/repo.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-test-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { parseStatus } = await import('../src/domain/run/run.ts');

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
  assert.equal(t.stop_reason, 'which database?');
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
  assert.ok((db.rateLimitedUntil() ?? 0) * 1000 > Date.now());
  db.applyEvent(t.id, { type: 'cancel' });
  db.setSetting('rate_limited_until', '0');
});

test('cancel stops a running task', async () => {
  const task = db.addTask({ repo_id: 1, title: 'slow', prompt: 'FAKE_SLOW' });
  const done = drain();
  while (db.getTask(task.id)!.status !== 'running') await new Promise((r) => setTimeout(r, 20));
  assert.equal(db.applyEvent(task.id, { type: 'cancel' })?.status, 'cancel_requested');
  await done;
  assert.equal(db.getTask(task.id)!.status, 'cancelled');
});

test('a cancel requested while the run is finishing wins over done', async () => {
  // The run succeeds, then the repo's test command runs; cancel lands while it does.
  const marker = join(home, 'tests-started');
  db.updateRepo(1, { test_cmd: `touch ${marker} && sleep 1 && test -f fake-output.txt` });
  try {
    const task = db.addTask({ repo_id: 1, title: 'finishing', prompt: 'FAKE_DONE almost there' });
    const done = drain();
    while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 20));
    assert.equal(db.getTask(task.id)!.status, 'running');
    assert.equal(db.applyEvent(task.id, { type: 'cancel' })?.status, 'cancel_requested');
    await done;

    const t = db.getTask(task.id)!;
    assert.equal(t.status, 'cancelled', 'cancel is not overwritten by done');
    assert.equal(t.stop_reason, null);
    assert.equal(db.runsForTask(t.id)[0].outcome, 'done', 'the run keeps its real outcome');
    assert.equal(db.recentNotifications(1)[0]?.task_id === task.id, false, 'no "ready to review" for a cancelled task');
  } finally {
    db.updateRepo(1, { test_cmd: 'test -f fake-output.txt' });
  }
});

test('orphaned running tasks are requeued on start', () => {
  const task = db.addTask({ repo_id: 1, title: 'orphan', prompt: 'x' });
  db.claimNextTask();
  assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [] });
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'queued');
  assert.equal(t.attempts, 0);
  assert.equal(t.restarts, 1);
  db.applyEvent(t.id, { type: 'cancel' });
});

test('a task interrupted by repeated restarts fails instead of looping', async () => {
  const { MAX_RESTARTS } = await import('../src/domain/task/lifecycle.ts');
  const task = db.addTask({ repo_id: 1, title: 'poison', prompt: 'x' });
  for (let i = 1; i < MAX_RESTARTS; i++) {
    db.claimNextTask();
    assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [] });
  }
  db.claimNextTask();
  assert.deepEqual(db.recoverOrphans(), { requeued: 0, failed: [task.id] });
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'failed');
  assert.match(t.stop_reason!, /restarted 3 times/);
});

test('claude processes left by a dead daemon are stopped, with their children', async () => {
  const { spawn } = await import('node:child_process');
  const { reapOrphans } = await import('../src/adapters/processes.ts');
  const alive = (pgid: number) => {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // Stands in for claude plus a bash tool it started; ignores SIGTERM like a stuck process.
  const child = spawn('sh', ['-c', "trap '' TERM; sleep 60 & sleep 60"], { detached: true, stdio: 'ignore' });
  child.unref();
  const pid = child.pid!;
  const sqliteNow = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await new Promise((r) => setTimeout(r, 200));

  // A pid whose leader started at another time belongs to someone else: leave it alone.
  assert.equal(reapOrphans([{ pid, pid_at: '2020-01-01 00:00:00' }], 200), 0);
  assert.ok(alive(pid));

  assert.equal(reapOrphans([{ pid, pid_at: sqliteNow }], 300), 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!alive(pid), 'whole process group is gone, SIGKILL after the grace period');
});

test('a claude started long after its run row opened (setup, a sync) is still the run own, and is reaped', async () => {
  const { spawn } = await import('node:child_process');
  const { ownsLiveGroup, reapOrphans } = await import('../src/adapters/processes.ts');
  const { openDb } = await import('../src/db/index.ts');
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  const runId = db.startRun(task.id, 1, '/tmp/log');
  db.raw.prepare("UPDATE runs SET started_at = datetime('now', '-5 minutes') WHERE id = ?").run(runId);
  const child = spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' });
  child.unref();
  db.setRunPid(runId, child.pid!);
  try {
    const [row] = db.unfinishedPids();
    assert.equal(row.pid, child.pid);
    assert.ok(ownsLiveGroup(row), JSON.stringify(row));
    assert.equal(reapOrphans(db.unfinishedPids(), 300), 1);
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {
      // already gone
    }
    db.close();
  }
});

test('defaultTitle cuts at sentence or word boundary', async () => {
  const { defaultTitle } = await import('../src/domain/task/task.ts');
  assert.equal(defaultTitle('Fix the login bug. Then add tests.'), 'Fix the login bug');
  const long = defaultTitle(
    'Add a truncate(s, n) function to src/strings.js that shortens s to at most n characters, ending with an ellipsis',
  );
  assert.ok(long.endsWith('…') && long.length <= 73 && !long.includes(' cha…'), long);
});

test('final outcomes are recorded as notifications; retried failures are not', () => {
  const kinds = db.recentNotifications(50).map((n) => n.kind);
  assert.ok(kinds.includes('done'));
  assert.ok(kinds.includes('blocked'));
  assert.equal(kinds.filter((k) => k === 'failed').length, 1, 'only the final failure notifies');
});

test('governor holds queued work over the 5h cap and notifies once', async () => {
  const now = Math.floor(Date.now() / 1000);
  db.recordUsageWindow('five_hour', 0.9, now + 3600, 'allowed');
  const before = db.recentNotifications(50).filter((n) => n.kind === 'hold').length;
  const task = db.addTask({ repo_id: 1, title: 'held', prompt: 'FAKE_DONE' });
  await drain(); // once mode stops when held
  assert.equal(db.getTask(task.id)!.status, 'queued');
  const holds = db.recentNotifications(50).filter((n) => n.kind === 'hold');
  assert.equal(holds.length, before + 1);
  assert.match(holds[0].body, /5h usage 90%/);

  db.recordUsageWindow('five_hour', 0.1, now + 3600, 'allowed');
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'done');
});

test('repo add detects the toolchain; repos registered before detection get its rules on the fly', async () => {
  const { addRepo } = await import('../src/application/actions.ts');
  const { rootInfo } = await import('../src/adapters/repo-root.ts');
  const { DEFAULT_ALLOWED_TOOLS, allowedTools } = await import('../src/domain/repo/tools.ts');
  const effectiveTools = (repo: Repo, dir: string) => allowedTools(repo, rootInfo(dir));
  const jsRepo = (name: string) => {
    const dir = join(home, name);
    execFileSync('mkdir', ['-p', dir]);
    sh(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    return dir;
  };
  const js = jsRepo('js-repo');

  const repo = await addRepo(db, { path: js, name: 'js-repo', base: 'main' });
  assert.equal(repo.toolchain, 'pnpm');
  assert.equal(repo.setup_cmd, 'pnpm install --frozen-lockfile --prefer-offline');
  assert.equal(repo.test_cmd, 'pnpm test');
  assert.equal(repo.allowed_tools, null, 'rules are not snapshotted, so they follow the scripts');
  const tools = [...DEFAULT_ALLOWED_TOOLS, 'Bash(pnpm test*)', 'Bash(pnpm lint*)', 'Bash(pnpm run *)'];
  assert.deepEqual(effectiveTools(repo, js), tools);
  // A script added later is allowed without re-registering the repo.
  writeFileSync(join(js, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', typecheck: 'tsc' } }));
  assert.ok(effectiveTools(repo, js).includes('Bash(pnpm typecheck*)'));
  writeFileSync(join(js, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  assert.ok(!DEFAULT_ALLOWED_TOOLS.some((t) => /npm/.test(t)), 'package manager rules come from the toolchain');

  const given = await addRepo(db, {
    path: jsRepo('js-given'),
    name: 'js-given',
    base: 'main',
    test: 'make check',
    setup: 'true',
    tools: ['Read'],
  });
  assert.deepEqual([given.test_cmd, given.setup_cmd, given.allowed_tools], ['make check', 'true', ['Read']]);

  const legacy = { ...repo, allowed_tools: null, toolchain: null };
  assert.deepEqual(effectiveTools(legacy, js), tools);
  assert.deepEqual(effectiveTools({ ...legacy, path: repoPath }, repoPath), DEFAULT_ALLOWED_TOOLS);
});

const claudeCalls = () => {
  const path = join(home, 'fake-claude-calls.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};

test('setup runs in the worktree before claude starts', async () => {
  db.updateRepo(1, { setup_cmd: 'echo installing && echo ready > setup-done.txt' });
  try {
    const task = db.addTask({ repo_id: 1, title: 'needs deps', prompt: 'FAKE_NEEDS_SETUP go' });
    await drain();
    const t = db.getTask(task.id)!;
    assert.equal(t.status, 'done', t.stop_reason ?? '');
    assert.ok(existsSync(join(t.worktree!, 'setup-done.txt')));
    const log = readFileSync(db.runsForTask(t.id)[0].log_path, 'utf8').split('\n');
    const setupAt = log.findIndex((l) => l.includes('"type":"agentdeck_setup"'));
    const claudeAt = log.findIndex((l) => l.includes('"type":"system"'));
    assert.ok(setupAt >= 0 && setupAt < claudeAt, 'setup is logged before claude output');
    assert.match(log[setupAt], /"passed":true/);
    assert.match(log[setupAt], /installing/);
  } finally {
    db.updateRepo(1, { setup_cmd: null });
  }
});

test('a failing setup blocks the task without starting claude', async () => {
  db.updateRepo(1, { setup_cmd: 'echo fetching deps && echo "ERR_PNPM_OFFLINE no network" >&2 && exit 3' });
  try {
    const task = db.addTask({ repo_id: 1, title: 'offline', prompt: 'FAKE_DONE never-runs-marker' });
    await drain();
    const t = db.getTask(task.id)!;
    assert.equal(t.status, 'blocked');
    assert.equal(t.stop_reason, 'setup failed: ERR_PNPM_OFFLINE no network');
    assert.equal(t.attempts, 0, 'blocked by the environment: the attempt is given back');
    const [run] = db.runsForTask(t.id);
    assert.equal(run.outcome, 'blocked');
    assert.equal(run.pid, null, 'claude never spawned');
    assert.doesNotMatch(claudeCalls(), /never-runs-marker/);
    assert.match(readFileSync(run.log_path, 'utf8'), /"type":"agentdeck_setup".*"passed":false/);
  } finally {
    db.updateRepo(1, { setup_cmd: null });
  }
});

const settingsCalls = () => readFileSync(join(home, 'fake-claude-settings.log'), 'utf8').trim().split('\n');

test('each run gets a sandbox settings file outside its worktree', async () => {
  const { updateRepo } = await import('../src/application/actions.ts');
  const { LOG_DIR } = await import('../src/config.ts');
  db.setRepoPaused(1, null); // the failing setup above paused it
  assert.equal(db.getRepo(1)!.sandbox, true, 'sandbox is on by default');
  assert.deepEqual(db.getRepo(1)!.network, [], 'no hosts by default');
  updateRepo(db, 1, { network: 'registry.npmjs.org, github.com' });
  try {
    const task = db.addTask({ repo_id: 1, title: 'sandboxed', prompt: 'FAKE_DONE in the sandbox' });
    await drain();
    const t = db.getTask(task.id)!;
    assert.equal(t.status, 'done', t.stop_reason ?? '');
    const path = settingsCalls().at(-1)!;
    assert.equal(path, join(LOG_DIR, `task-${t.id}-attempt-1.settings.json`));
    assert.ok(!path.startsWith(t.worktree!), 'the agent cannot edit its own settings');
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.sandbox, {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: ['registry.npmjs.org', 'github.com'], strictAllowlist: true, allowLocalBinding: true },
    });
    assert.deepEqual(settings.permissions.allow, [`Edit(/${t.worktree}/**)`]);

    updateRepo(db, 1, { sandbox: false });
    const off = db.addTask({ repo_id: 1, title: 'unsandboxed', prompt: 'FAKE_DONE without the sandbox' });
    await drain();
    assert.equal(db.getTask(off.id)!.status, 'done');
    assert.deepEqual(JSON.parse(readFileSync(settingsCalls().at(-1)!, 'utf8')).sandbox, { enabled: false });
  } finally {
    updateRepo(db, 1, { sandbox: true, network: '' });
  }
});

test('a sandbox that cannot start fails the run with claude’s reason', async () => {
  const task = db.addTask({ repo_id: 1, title: 'no sandbox', prompt: 'FAKE_NO_SANDBOX', max_attempts: 1 });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'failed');
  assert.match(t.stop_reason!, /^claude exited with code 1: Error: sandbox is required .* could not start/);
  assert.match(db.runsForTask(t.id)[0].result_text!, /could not start/);
});

test('repo network rejects things that are not host names', async () => {
  const { ActionError, updateRepo } = await import('../src/application/actions.ts');
  assert.throws(() => updateRepo(db, 1, { network: 'a.com, http://b.com/x' }), ActionError);
  assert.deepEqual(db.getRepo(1)!.network, []);
});

test('a new worktree starts from origin/<base> when origin is ahead of the local base', async () => {
  const seed = join(home, 'seed');
  const origin = join(home, 'origin.git');
  const local = join(home, 'local');
  const other = join(home, 'other');
  execFileSync('mkdir', ['-p', seed]);
  sh(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  sh(seed, 'add', '-A');
  sh(seed, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed');
  sh(home, 'clone', '-q', '--bare', seed, origin);
  sh(home, 'clone', '-q', origin, local);
  sh(local, 'config', 'user.email', 'test@example.com');
  sh(local, 'config', 'user.name', 'test');

  // Someone else pushes to origin; the local main checkout falls behind.
  sh(home, 'clone', '-q', origin, other);
  writeFileSync(join(other, 'upstream.txt'), 'from origin\n');
  sh(other, 'add', '-A');
  sh(other, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'upstream change');
  sh(other, 'push', '-q', 'origin', 'main');
  const upstreamHead = sh(other, 'rev-parse', 'HEAD');
  assert.notEqual(sh(local, 'rev-parse', 'main'), upstreamHead);

  const repo = db.addRepo({ name: 'cloned', path: local, base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 'on fresh base', prompt: 'FAKE_DONE fresh' });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done', t.stop_reason ?? '');
  assert.ok(existsSync(join(t.worktree!, 'upstream.txt')), 'worktree has origin’s commit');
  sh(local, 'merge-base', '--is-ancestor', upstreamHead, t.branch!);
  assert.equal(sh(local, 'rev-list', '--count', `origin/main..${t.branch}`), '1', 'only the agent’s commit on top');
  assert.notEqual(sh(local, 'rev-parse', 'main'), upstreamHead, 'local main is left alone');
});
