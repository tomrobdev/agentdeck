// A daemon restart mid-run: claude's session is stored as soon as claude names it, recovery ends the run
// `interrupted`, and the task's next run resumes that session without using an attempt. The decisions are tested
// pure first, then with real daemon processes (`run-once`) stopped by SIGTERM, real git and SQLite, and fake claude.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Run } from '../src/domain/run/run.ts';
import type { Task } from '../src/domain/task/task.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-resume-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { DB_PATH, LOG_DIR } = await import('../src/config.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { MAX_RESTARTS } = await import('../src/domain/task/lifecycle.ts');
const { INTERRUPTED, resultFields, resumableSession, resumeFailed } = await import('../src/domain/run/run.ts');
const { buildPrompt, buildResumePrompt, claudeArgs } = await import('../src/domain/run/prompt.ts');

// --- The decisions, pure ---

let ids = 0;
const run = (o: Partial<Run>): Run => ({
  id: ++ids,
  task_id: 1,
  kind: 'work',
  attempt: 1,
  started_at: '2026-11-01 10:00:00',
  ended_at: '2026-11-01 10:05:00',
  outcome: INTERRUPTED,
  exit_code: null,
  session_id: null,
  num_turns: null,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  tests_passed: null,
  result_text: 'daemon restarted',
  log_path: '/tmp/log',
  pid: null,
  denials: 0,
  live_turns: 0,
  live_tool: null,
  ...o,
});

test('resumableSession: the session of the attempt’s interrupted run, and only that', () => {
  const on = { attempts: 1 };
  assert.equal(resumableSession(on, []), null, 'no run yet');
  assert.equal(resumableSession(on, [run({ session_id: 's1' })]), 's1');
  assert.equal(resumableSession(on, [run({ session_id: 's1', outcome: 'failed' })]), null, 'a real failure starts afresh');
  assert.equal(resumableSession(on, [run({ session_id: null })]), null, 'claude never named a session');
  // A person's retry after the task failed or was cancelled is a new attempt, and a new session.
  assert.equal(resumableSession({ attempts: 2 }, [run({ session_id: 's1' })]), null);
  // A second restart before claude started (say, during setup) does not lose the session.
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ session_id: null })]), 's1');
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ session_id: 's2' })]), 's2', 'the newest one');
  // A resolve run is not the task's work, and an earlier finished run ends the search.
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ kind: 'resolve', session_id: 'r' })]), 's1');
  assert.equal(resumableSession(on, [run({ session_id: 's1', outcome: 'done' }), run({ session_id: null })]), null);
});

test('resumeFailed: a resume that stopped before its session started, and nothing else', () => {
  const gone = { result: undefined, exitCode: 1, rateLimitedUntil: undefined, cancelled: false, stderr: '' };
  assert.equal(resumeFailed(gone), true, 'no init line, no result');
  assert.equal(resumeFailed({ ...gone, sessionId: 's1', stderr: 'No conversation found with session ID: s1\n' }), true);
  assert.equal(resumeFailed({ ...gone, sessionId: 's1' }), false, 'it started: a failure of the run, not of the resume');
  const missing = { is_error: true, result: 'No conversation found with session ID: s1' };
  assert.equal(resumeFailed({ ...gone, sessionId: 's1', result: missing }), true, 'said in an error result');
  assert.equal(resumeFailed({ ...gone, sessionId: 's1', result: { is_error: true, result: 'boom' } }), false);
  assert.equal(resumeFailed({ ...gone, result: { result: 'No conversation found, done anyway' } }), false, 'a finished run');
  assert.equal(resumeFailed({ ...gone, cancelled: true }), false);
  assert.equal(resumeFailed({ ...gone, rateLimitedUntil: 2_000_000_000 }), false);
});

test('resultFields keeps the session claude named when the run ends without a result', () => {
  assert.equal(resultFields(undefined, 1, 's1').session_id, 's1');
  assert.equal(resultFields({ session_id: 's2' }, 0, 's1').session_id, 's2');
  assert.equal(resultFields(undefined, 1).session_id, null);
});

const task = { id: 7, title: 'Cache reads', prompt: 'Goal: cache reads.', attempts: 1, model: 'sonnet', max_turns: 40 } as Task;

test('claudeArgs adds --resume and changes nothing else', () => {
  const fresh = claudeArgs(task, ['Read'], 'the prompt', 'pnpm test', '/s.json');
  const resumed = claudeArgs(task, ['Read'], 'the prompt', 'pnpm test', '/s.json', 's1');
  assert.ok(!fresh.includes('--resume'));
  assert.deepEqual(resumed.slice(resumed.indexOf('--resume'), resumed.indexOf('--resume') + 2), ['--resume', 's1']);
  assert.deepEqual(
    resumed.filter((a) => a !== '--resume' && a !== 's1'),
    fresh,
  );
});

test('the resume prompt says what happened and where to look; a fresh run after a restart does not say it failed', () => {
  const resume = buildResumePrompt(task);
  assert.match(resume, /restarted while you were working/);
  assert.match(resume, /git status/);
  assert.match(resume, /"agentdeck: uncommitted work from task 7"/);
  assert.match(resume, /STATUS line/);
  const fresh = buildPrompt(task, [run({ session_id: null })]);
  assert.match(fresh, /^Goal: cache reads\./);
  assert.match(fresh, /A daemon restart stopped an earlier run of it before it finished/);
  assert.doesNotMatch(fresh, /ended as|daemon restarted/);
});

// --- Real restarts ---

const CLI = join(import.meta.dirname, '../src/cli.ts');
const db = openDb(DB_PATH);
const repoPath = join(home, 'demo');
let repoId = 0;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The next daemon, in this process: it recovers what the last one left running, then works the queue. */
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
/** Every fake claude's arguments, oldest first. */
const calls = (): string[][] =>
  readFileSync(join(home, 'fake-claude-args.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const promptOf = (args: string[]) => args[args.indexOf('-p') + 1];
const resumeOf = (args: string[]) => (args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null);

/**
 * Start a daemon (`run-once`) in its own process and wait until the task has a run newer than `afterRun` that claude
 * has named a session for and that has not ended; then stop the daemon as launchd does, with SIGTERM. Returns the run.
 */
async function restartMidRun(taskId: number, afterRun = 0): Promise<Run> {
  const daemon = spawn(process.execPath, [CLI, 'run-once'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  daemon.stdout.on('data', (b) => (output += b));
  daemon.stderr.on('data', (b) => (output += b));
  const exited = new Promise((r) => daemon.on('exit', r));
  const deadline = Date.now() + 30_000;
  let live: Run | undefined;
  while (!(live = db.runsForTask(taskId).find((r) => r.id > afterRun && r.session_id && r.ended_at === null))) {
    if (Date.now() > deadline || daemon.exitCode !== null) {
      daemon.kill('SIGKILL');
      assert.fail(`task ${taskId} never had a live run with a session. Daemon output:\n${output}`);
    }
    await sleep(25);
  }
  assert.equal(db.getTask(taskId)!.status, 'running', 'the session is stored while the run is still going');
  daemon.kill('SIGTERM');
  await exited;
  return live;
}

test('a restart mid-run: the next run resumes the session and uses no attempt', async () => {
  const added = db.addTask({ repo_id: repoId, title: 'stalls until resumed', prompt: 'FAKE_STALL write the output' });
  const cut = await restartMidRun(added.id);
  assert.equal(db.getTask(added.id)!.attempts, 1);
  assert.equal(db.runsForTask(added.id)[0].ended_at, null, 'a SIGTERM leaves the run for the next daemon to recover');

  await drain();
  const t = db.getTask(added.id)!;
  assert.equal(t.status, 'done', t.stop_reason ?? '');
  assert.equal(t.attempts, 1, 'the restart used no attempt');
  assert.equal(t.restarts, 1);
  const runs = db.runsForTask(t.id);
  assert.equal(runs.length, 2);
  const [first, second] = runs;
  assert.deepEqual([first.outcome, first.result_text, first.session_id], [INTERRUPTED, 'daemon restarted', cut.session_id]);
  assert.deepEqual([second.attempt, second.outcome, second.session_id], [first.attempt, 'done', cut.session_id]);

  const [fresh, resumed] = calls().slice(-2);
  assert.equal(resumeOf(fresh), null);
  assert.equal(resumeOf(resumed), cut.session_id);
  assert.match(promptOf(resumed), /AgentDeck restarted while you were working/);
  // Everything else is the fresh run's: settings, tool rules, system prompt, model and turn limit.
  const rest = (args: string[]) =>
    args.filter((_, i) => i !== args.indexOf('-p') + 1).filter((a) => a !== '--resume' && a !== cut.session_id);
  assert.deepEqual(rest(resumed), rest(fresh));
  assert.match(readFileSync(second.log_path, 'utf8'), /"type":"agentdeck_resume","session_id":"fake-session-\d+"/);
  assert.ok(existsSync(join(t.worktree!, 'fake-output.txt')));
});

test('a resume whose session is gone falls back to a fresh run, in the same run', async () => {
  const added = db.addTask({ repo_id: repoId, title: 'lost session', prompt: 'FAKE_DONE after a lost session' });
  // A run a restart cut off, whose session claude no longer has.
  const claimed = db.claimNextTask()!;
  assert.equal(claimed.id, added.id);
  const cut = db.startRun(added.id, claimed.attempts, join(LOG_DIR, `task-${added.id}-attempt-1.jsonl`));
  db.setRunSession(cut, 'gone-session');
  assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [] });

  await drain();
  const t = db.getTask(added.id)!;
  assert.equal(t.status, 'done', t.stop_reason ?? '');
  assert.equal(t.attempts, 1);
  const runs = db.runsForTask(t.id);
  assert.equal(runs.length, 2, 'the fresh claude runs in the run that tried to resume');
  const [gone, fresh] = calls().slice(-2);
  assert.equal(resumeOf(gone), 'gone-session');
  assert.equal(resumeOf(fresh), null);
  assert.match(promptOf(fresh), /^FAKE_DONE after a lost session/);
  assert.match(runs[1].session_id!, /^fake-session-\d+$/, 'the run keeps the fresh session');
  assert.equal(runs[1].outcome, 'done');
  assert.match(readFileSync(runs[1].log_path, 'utf8'), /"type":"agentdeck_resume_failed".*No conversation found/);
  assert.equal(git(repoPath, 'rev-list', '--count', `main..${t.branch}`), '1', 'the work is on the task’s branch');
});

test('a task whose resumed runs keep being interrupted fails at MAX_RESTARTS', async () => {
  const added = db.addTask({ repo_id: repoId, title: 'never finishes', prompt: 'FAKE_SLOW forever' });
  const cut: Run[] = [];
  for (let i = 0; i < MAX_RESTARTS; i++) cut.push(await restartMidRun(added.id, cut.at(-1)?.id ?? 0));
  // The daemon after the last restart: too many restarts, so the task fails instead of resuming again.
  assert.deepEqual(db.recoverOrphans(), { requeued: 0, failed: [added.id] });
  const t = db.getTask(added.id)!;
  assert.equal(t.status, 'failed');
  assert.equal(t.restarts, MAX_RESTARTS);
  assert.equal(t.attempts, 1, 'no restart used an attempt');
  assert.match(t.stop_reason!, new RegExp(`restarted ${MAX_RESTARTS} times`));
  const runs = db.runsForTask(t.id);
  assert.deepEqual(
    runs.map((r) => [r.attempt, r.outcome]),
    runs.map(() => [1, INTERRUPTED]),
  );
  assert.equal(new Set(runs.map((r) => r.session_id)).size, 1, 'every run continued the first session');
  assert.deepEqual(calls().slice(-MAX_RESTARTS).map(resumeOf), [null, ...Array(MAX_RESTARTS - 1).fill(cut[0].session_id)]);
});
