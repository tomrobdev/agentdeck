import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { TaskId } from '../../../src/domain/shared/id.ts';
import type { Run } from '../../../src/domain/runs/run.ts';
import { asRepoId, asRunId, asTaskId, waitFor } from '../../fixtures/fixtures.ts';
import { type Task, stopReasonOf } from '../../../src/domain/work/task/task.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-resume-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
process.env.AGENTDECK_PORT = '0';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../../fixtures/open-db.ts');
const { DB_PATH, LOG_DIR } = await import('../../../src/config.ts');
const { Scheduler } = await import('../../../src/application/scheduler/scheduler.ts');
const { MAX_RESTARTS } = await import('../../../src/domain/work/lifecycle/lifecycle.ts');
const { INTERRUPTED, editsSinceCutOff, pickRun, resumableSession, resumeMaxTurns } = await import('../../../src/domain/runs/run.ts');
const { resultFields, resumeFailed } = await import('../../../src/domain/runs/run-result.ts');
const { buildPrompt, buildResumePrompt, claudeArgs } = await import('../../../src/domain/runs/prompt.ts');

let ids = 0;
const run = (o: Partial<Run>): Run => ({
  id: asRunId(++ids),
  task_id: asTaskId(1),
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
  pid_at: null,
  model: 'sonnet',
  model_id: null,
  diff_hash: null,
  base_commit: null,
  run_end: null,
  last_test_failed: null,
  ...o,
});

test('resumableSession: the session of the attempt’s interrupted run, and only that', () => {
  const on = { attempts: 1 };
  assert.equal(resumableSession(on, []), null, 'no run yet');
  assert.equal(resumableSession(on, [run({ session_id: 's1' })]), 's1');
  assert.equal(resumableSession(on, [run({ session_id: 's1', outcome: 'failed' })]), null, 'a real failure starts afresh');
  assert.equal(resumableSession(on, [run({ session_id: null })]), null, 'claude never named a session');
  assert.equal(resumableSession({ attempts: 2 }, [run({ session_id: 's1' })]), null);
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ session_id: null })]), 's1');
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ session_id: 's2' })]), 's2', 'the newest one');
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ kind: 'resolve', session_id: 'r' })]), 's1');
  assert.equal(resumableSession(on, [run({ session_id: 's1', outcome: 'done' }), run({ session_id: null })]), null);
});

test('resumableSession looks past a rate-limited run of the attempt, back to the interrupted one', () => {
  const on = { attempts: 1 };
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ outcome: 'rate_limited', session_id: null })]), 's1');
  assert.equal(resumableSession(on, [run({ session_id: 's1' }), run({ outcome: 'rate_limited', session_id: 's1' })]), 's1');
  assert.equal(
    resumableSession(on, [run({ session_id: 's1' }), run({ outcome: 'rate_limited' }), run({ session_id: null })]),
    's1',
    'a restart after the rate limit',
  );
  assert.equal(resumableSession(on, [run({ outcome: 'rate_limited', session_id: 's1' })]), null, 'a rate limit alone starts afresh');
  assert.equal(resumableSession({ attempts: 2 }, [run({ session_id: 's1' }), run({ outcome: 'rate_limited', attempt: 2 })]), null);
});

test('editsSinceCutOff: a prompt or plan edited after the cut-off run ended, and nothing else', () => {
  const on = { attempts: 1 };
  const runs = [run({ session_id: 's1', ended_at: '2026-11-01 10:05:00' })];
  const edit = (reason: string, at = '2026-11-01 10:06:00') => ({ type: 'edit', reason, at });
  assert.deepEqual(editsSinceCutOff(on, runs, { own: [] }), []);
  assert.deepEqual(editsSinceCutOff(on, runs, { own: [edit('prompt')] }), ['prompt']);
  assert.deepEqual(editsSinceCutOff(on, runs, { own: [edit('title, prompt'), edit('plan_task, plan_steps, plan')] }), [
    'prompt',
    'plan_task',
    'plan_steps',
    'plan',
  ]);
  assert.deepEqual(editsSinceCutOff(on, runs, { own: [edit('title'), edit('priority, max_turns')] }), [], 'the session needs no new text');
  assert.deepEqual(editsSinceCutOff(on, runs, { own: [edit('prompt', '2026-11-01 10:04:00')] }), [], 'the session saw it');
  assert.deepEqual(editsSinceCutOff(on, runs, { own: [{ type: 'retry', reason: 'prompt', at: '2026-11-01 10:06:00' }] }), []);
  assert.deepEqual(editsSinceCutOff(on, runs, { own: [], planOwner: [edit('prompt'), edit('plan_task, plan')] }), ['plan']);
  assert.deepEqual(editsSinceCutOff(on, [run({ session_id: null })], { own: [edit('prompt')] }), [], 'no session to resume');
});

test('resumeMaxTurns: the task’s limit less the turns the attempt’s cut-off runs used', () => {
  const task50 = { attempts: 1, max_turns: 50 };
  assert.equal(resumeMaxTurns(task50, [run({ session_id: 's1', live_turns: 45 })]), 5);
  assert.equal(resumeMaxTurns(task50, [run({ session_id: 's1', live_turns: 20 }), run({ session_id: 's1', live_turns: 25 })]), 5);
  assert.equal(resumeMaxTurns(task50, [run({ session_id: 's1', live_turns: 30 }), run({ outcome: 'rate_limited', num_turns: 15 })]), 5);
  assert.equal(resumeMaxTurns(task50, [run({ session_id: 's1', live_turns: 60 })]), 1, 'at least one');
  assert.equal(resumeMaxTurns(task50, [run({ outcome: 'failed', num_turns: 50 }), run({ attempt: 2, live_turns: 10 })]), 50);
  const fifty = { id: 7, title: 't', prompt: 'p', attempts: 1, model: 'sonnet', max_turns: 50 } as Task;
  const args = claudeArgs(fifty, ['Read'], 'p', null, '/s.json', 's1', resumeMaxTurns(fifty, [run({ session_id: 's1', live_turns: 45 })]));
  assert.deepEqual(args.slice(args.indexOf('--max-turns'), args.indexOf('--max-turns') + 2), ['--max-turns', '5']);
});

test('pickRun by attempt picks the attempt’s latest work run: the resume, not the run a restart cut off', () => {
  const cut = run({ session_id: 's1' });
  const resumed = run({ session_id: 's1', outcome: 'done' });
  const resolve = run({ kind: 'resolve', outcome: 'done' });
  assert.equal(pickRun([cut, resumed, resolve], { attempt: 1 }), resumed);
  assert.equal(pickRun([cut, resumed, resolve], { run: cut.id }), cut);
  assert.equal(pickRun([cut, resumed, resolve]), resolve);
});

test('resumeFailed: a resume whose session claude no longer has, and nothing else', () => {
  const gone = { result: undefined, exitCode: 1, rateLimitedUntil: undefined, cancelled: false, stderr: '' };
  assert.equal(resumeFailed(gone), false, 'no init line and no word of the session: the run failed');
  assert.equal(resumeFailed({ ...gone, stderr: 'Error: Invalid settings file /s.json: Unexpected token\n' }), false, 'bad settings');
  assert.equal(resumeFailed({ ...gone, stderr: 'No conversation found with session ID: s1\n' }), true);
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

test('a fresh run after a restart still names the earlier attempt’s failed tests and final message', () => {
  const failed = run({
    attempt: 1,
    outcome: 'failed',
    tests_passed: false,
    result_text: 'Added the cache.\nSTATUS: DONE',
    session_id: 's1',
  });
  const prompt = buildPrompt({ ...task, attempts: 2 }, [failed, run({ attempt: 2, session_id: null })]);
  assert.match(prompt, /--- This is attempt 2\. A daemon restart stopped an earlier run of it before it finished\. ---/);
  assert.match(prompt, /Before that, the previous attempt ended as "failed"\./);
  assert.match(prompt, /The test command failed after the previous attempt\./);
  assert.match(prompt, /Previous final message:\nAdded the cache\./);
  assert.doesNotMatch(prompt, /daemon restarted/, 'nothing from the interrupted run');
  const retry = buildPrompt({ ...task, attempts: 2 }, [failed]);
  assert.match(retry, /--- This is attempt 2\. The previous attempt ended as "failed"\. ---\nThe test command failed/);
  assert.doesNotMatch(retry, /daemon restart/);
});

const CLI = join(import.meta.dirname, '../../../src/cli.ts');
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
const calls = (): string[][] =>
  readFileSync(join(home, 'fake-claude-args.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const promptOf = (args: string[]) => args[args.indexOf('-p') + 1];
const resumeOf = (args: string[]) => (args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null);

async function restartMidRun(taskId: TaskId, afterRun = 0): Promise<Run> {
  const daemon = spawn(process.execPath, [CLI, 'run-once'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  daemon.stdout.on('data', (b) => (output += b));
  daemon.stderr.on('data', (b) => (output += b));
  const exited = new Promise((r) => daemon.on('exit', r));
  let live: Run;
  try {
    live = await waitFor(
      () => {
        if (daemon.exitCode !== null) throw new Error(`the daemon exited with ${daemon.exitCode}`);
        return db.runsForTask(taskId).find((r) => r.id > afterRun && r.session_id && r.ended_at === null);
      },
      { timeoutMs: 30_000, what: `task ${taskId} to have a live run with a session` },
    );
  } catch (e) {
    daemon.kill('SIGKILL');
    assert.fail(`task ${taskId} never had a live run with a session (${(e as Error).message}). Daemon output:\n${output}`);
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
  assert.equal(t.status, 'done', stopReasonOf(t) ?? '');
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
  const rest = (args: string[]) =>
    args.filter((_, i) => i !== args.indexOf('-p') + 1).filter((a) => a !== '--resume' && a !== cut.session_id);
  assert.deepEqual(rest(resumed), rest(fresh));
  assert.match(readFileSync(second.log_path, 'utf8'), /"type":"agentdeck_resume","session_id":"fake-session-\d+"/);
  assert.ok(existsSync(join(t.checkout!.worktree!, 'fake-output.txt')));
});

test('a resume whose session is gone falls back to a fresh run, in the same run', async () => {
  const added = db.addTask({ repo_id: repoId, title: 'lost session', prompt: 'FAKE_DONE after a lost session' });
  const claimed = db.claimNextTask()!;
  assert.equal(claimed.id, added.id);
  const cut = db.startRun(added.id, claimed.attempts, join(LOG_DIR, `task-${added.id}-attempt-1.jsonl`));
  db.setRunSession(cut, 'gone-session');
  assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [] });

  await drain();
  const t = db.getTask(added.id)!;
  assert.equal(t.status, 'done', stopReasonOf(t) ?? '');
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
  assert.equal(git(repoPath, 'rev-list', '--count', `main..${t.checkout?.branch}`), '1', 'the work is on the task’s branch');
});

test('a task whose prompt was edited while it waited starts afresh instead of resuming the old session', async () => {
  const added = db.addTask({ repo_id: repoId, title: 'edited while queued', prompt: 'FAKE_BLOCKED the old prompt' });
  const claimed = db.claimNextTask()!;
  assert.equal(claimed.id, added.id);
  const cut = db.startRun(added.id, claimed.attempts, join(LOG_DIR, `task-${added.id}-attempt-1.jsonl`));
  mkdirSync(join(home, 'fake-sessions'), { recursive: true });
  writeFileSync(join(home, 'fake-sessions', 'kept-session'), 'FAKE_BLOCKED the old prompt');
  db.setRunSession(cut, 'kept-session');
  assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [] });
  assert.ok(db.editTask(added.id, { prompt: 'FAKE_DONE the new prompt' }));

  await drain();
  const t = db.getTask(added.id)!;
  assert.equal(t.status, 'done', stopReasonOf(t) ?? '');
  assert.equal(t.attempts, 1);
  const last = calls().at(-1)!;
  assert.equal(resumeOf(last), null, 'no resume of the session that holds the old prompt');
  assert.ok(!calls().some((c) => resumeOf(c) === 'kept-session'));
  assert.match(promptOf(last), /^FAKE_DONE the new prompt/);
  assert.match(promptOf(last), /A daemon restart stopped an earlier run of it/);
  assert.match(readFileSync(db.runsForTask(t.id)[1].log_path, 'utf8'), /"type":"agentdeck_resume_skipped".*edited since: prompt/);
});

test('a task whose resumed runs keep being interrupted fails at MAX_RESTARTS', async () => {
  const added = db.addTask({ repo_id: repoId, title: 'never finishes', prompt: 'FAKE_SLOW forever' });
  const cut: Run[] = [];
  for (let i = 0; i < MAX_RESTARTS; i++) cut.push(await restartMidRun(added.id, cut.at(-1)?.id ?? 0));
  assert.deepEqual(db.recoverOrphans(), { requeued: 0, failed: [added.id] });
  const t = db.getTask(added.id)!;
  assert.equal(t.status, 'failed');
  assert.equal(t.restarts, MAX_RESTARTS);
  assert.equal(t.attempts, 1, 'no restart used an attempt');
  assert.match(t.stop_reason!, new RegExp(`restarted ${MAX_RESTARTS} times`));
  const runs = db.runsForTask(t.id);
  assert.deepEqual(
    runs.map((r) => [r.attempt, r.outcome]),
    runs.map((r, i) => [1, i === runs.length - 1 ? 'failed' : INTERRUPTED]),
  );
  assert.equal(new Set(runs.map((r) => r.session_id)).size, 1, 'every run continued the first session');
  assert.deepEqual(calls().slice(-MAX_RESTARTS).map(resumeOf), [null, ...Array(MAX_RESTARTS - 1).fill(cut[0].session_id)]);
});
