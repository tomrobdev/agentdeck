import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { asRepoId } from '#test/fixtures/fixtures.ts';
import { stopReasonOf } from '#domain/work/task/task.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-run-limit-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
process.env.AGENTDECK_PORT = '0';
process.env.AGENTDECK_RUN_STALL_MS = '1500';
process.env.AGENTDECK_RUN_MAX_MS = '4000';
const fake = join(import.meta.dirname, '../../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('#test/fixtures/open-db.ts');
const { DB_PATH } = await import('#src/config.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { runClaude, runLimits } = await import('#adapters/claude/claude.ts');

const db = openDb(DB_PATH);
const repoPath = join(home, 'demo');
let repoId = asRepoId(0);
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

before(() => {
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@example.com');
  git(repoPath, 'config', 'user.name', 'test');
  writeFileSync(join(repoPath, 'README.md'), 'demo\n');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-q', '-m', 'init');
  repoId = db.addRepo({ name: 'demo', path: repoPath, base_branch: 'main', test_cmd: 'test -f fake-output.txt' }).id;
});

after(() => db.close());

const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('the limits are read from the environment, and checked a few times within the stall limit', () => {
  const { stallMs, maxMs, checkMs } = runLimits();
  assert.deepEqual([stallMs, maxMs], [1_500, 4_000]);
  assert.ok(checkMs <= stallMs / 4, `checked every ${checkMs} ms`);
});

test('a claude that stops printing is stopped at the stall limit: the run fails naming it, and the task retries', async () => {
  const t = db.addTask({ repo_id: repoId, title: 'hangs', prompt: 'FAKE_HANG after its init line', max_attempts: 2 });
  const started = Date.now();
  await drain();
  const took = Date.now() - started;
  const task = db.getTask(t.id);
  assert.ok(task);
  assert.equal(task.status, 'failed');
  assert.match(stopReasonOf(task) ?? '', /^stall limit: claude printed nothing for 1500 ms/);
  const runs = db.runsForTask(t.id).filter((r) => r.kind === 'work');
  assert.deepEqual(
    runs.map((r) => [r.attempt, r.outcome, r.result_text]),
    [1, 2].map((a) => [a, 'failed', 'stall limit: claude printed nothing for 1500 ms']),
    'the first attempt failed on the limit, so the task ran again',
  );
  for (const r of runs) {
    assert.ok(r.pid);
    assert.equal(groupAlive(r.pid), false, `process group ${r.pid} is gone`);
    assert.match(readFileSync(r.log_path, 'utf8'), /"type":"agentdeck_error","text":"stall limit/);
  }
  assert.equal(db.countRunning(), 0, 'the slot is free');
  assert.ok(took < 20_000, `took ${took} ms`);
});

test('a claude that keeps printing is stopped at the total limit', async () => {
  const t = db.addTask({ repo_id: repoId, title: 'chatters', prompt: 'FAKE_CHATTER for ever', max_attempts: 1 });
  await drain();
  const task = db.getTask(t.id);
  assert.ok(task);
  assert.equal(task.status, 'failed');
  assert.match(stopReasonOf(task) ?? '', /^total limit: claude ran for 4 s/);
  const [run] = db.runsForTask(t.id);
  assert.equal(run.outcome, 'failed');
  assert.ok(run.pid);
  assert.equal(groupAlive(run.pid), false);
  assert.equal(db.countRunning(), 0);
});

test('a jump of hours between two checks (the Mac slept) ends no run', async () => {
  const limits = { stallMs: 2_000, maxMs: 3_000, checkMs: 50 };
  const asleep = { hours: 0 };
  const now = () => Date.now() + asleep.hours * 3_600_000;
  let cancel = false;
  const ran = runClaude({
    args: ['-p', 'FAKE_HANG while the Mac sleeps', '--output-format', 'stream-json'],
    cwd: home,
    log: createWriteStream(join(home, 'sleep.log')),
    limits,
    now,
    shouldCancel: () => cancel,
    cancelGraceMs: 500,
  });
  await sleep(300);
  asleep.hours = 8;
  await sleep(300);
  asleep.hours = 20;
  await sleep(300);
  cancel = true;
  const r = await ran;
  assert.equal(r.timedOut, undefined);
  assert.equal(r.cancelled, true);
});
