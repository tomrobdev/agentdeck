// How a run ends on each way claude's stream can go, through the real adapter and the scheduler on the fake claude:
// tool calls, the turn limit, a result line cut off halfway, and a process that stops mid-stream. The fake's events have
// the shape of the recorded ones (contracts.test.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { asRepoId, testApp } from './fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-stream-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { parseLogLine } = await import('../src/domain/runs/index.ts');
const { retryTask } = await import('../src/application/actions.ts');

const REPO = asRepoId(1);
const repoPath = join(home, 'demo');
const db = testApp(openDb(join(home, 'test.db')));
const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();

before(() => {
  execFileSync('mkdir', ['-p', repoPath]);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  writeFileSync(join(repoPath, 'README.md'), 'demo\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  db.addRepo({ name: 'demo', path: repoPath, base_branch: 'main', test_cmd: null });
});

after(() => db.close());

const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

/** Run one task with `prompt` to its end; its task, its one run and the run log's entries. */
async function runOnce(prompt: string) {
  const task = db.addTask({ repo_id: REPO, title: prompt, prompt, max_attempts: 1 });
  await drain();
  const runs = db.runsForTask(task.id);
  assert.equal(runs.length, 1);
  const lines = readFileSync(runs[0].log_path, 'utf8').split('\n');
  return { task: db.getTask(task.id)!, run: runs[0], lines, entries: lines.flatMap(parseLogLine) };
}

test('tool calls reach the run log and the live line', async () => {
  const { task, run, entries } = await runOnce('FAKE_DONE FAKE_TOOLS');
  assert.equal(task.status, 'done');
  assert.deepEqual(
    entries
      .filter((e) => e.kind === 'tool' || e.kind === 'tool_result')
      .map((e) => (e.kind === 'tool' ? `${e.name} ${e.file?.split('/').pop()}` : `ok ${e.ok}`)),
    ['Read README.md', 'ok true', 'Write fake-output.txt', 'ok true'],
  );
  assert.equal(run.live_turns, 3, 'two tool calls and the closing message');
  assert.equal(run.live_tool, 'Write fake-output.txt');
});

test('the turn limit fails the run with error_max_turns', async () => {
  const { task, run } = await runOnce('FAKE_MAX_TURNS');
  assert.equal(task.status, 'failed');
  assert.equal(task.stop_reason, 'error_max_turns');
  assert.equal(run.outcome, 'failed');
  assert.equal(run.num_turns, 2);
  assert.equal(run.live_tool, 'Read README.md');
});

test('a truncated last line fails the run as one that ended without a result', async () => {
  const { task, run, lines, entries } = await runOnce('FAKE_TRUNCATED');
  assert.equal(task.status, 'failed');
  assert.equal(task.stop_reason, 'claude ended without a result');
  assert.equal(run.outcome, 'failed');
  assert.equal(run.exit_code, 0);
  assert.equal(run.result_text, 'claude ended without a result');
  assert.ok(
    lines.some((l) => l.startsWith('{"type":"result"')),
    'the cut line is kept in the log',
  );
  assert.ok(
    entries.some((e) => e.kind === 'error' && e.text.startsWith('{"type":"result"')),
    'and shows there as an error',
  );
});

test('a mid-stream exit fails the run with the exit code, and the log keeps what came before', async () => {
  const { task, run, entries } = await runOnce('FAKE_EXIT_MIDSTREAM');
  assert.equal(task.status, 'failed');
  assert.equal(task.stop_reason, 'claude exited with code 1');
  assert.equal(run.outcome, 'failed');
  assert.equal(run.exit_code, 1);
  assert.equal(run.session_id?.startsWith('fake-session-'), true, 'the session from the init line is kept');
  assert.deepEqual(
    entries.map((e) => e.kind),
    ['prompt', 'tool', 'tool_result'],
  );
});

test('each run logs what it was told before claude starts, and a retry its note', async () => {
  const first = await runOnce('FAKE_BLOCKED');
  assert.equal(first.task.status, 'blocked');
  const told = first.entries.filter((e) => e.kind === 'prompt');
  assert.equal(told.length, 1);
  assert.ok(told[0].kind === 'prompt' && told[0].text.includes('FAKE_BLOCKED') && !told[0].resume && told[0].note === null);

  retryTask(db, first.task.id, { note: 'try the other file' });
  await drain();
  const second = db.runsForTask(first.task.id).at(-1)!;
  assert.notEqual(second.id, first.run.id);
  const entries = readFileSync(second.log_path, 'utf8').split('\n').flatMap(parseLogLine);
  const prompt = entries.find((e) => e.kind === 'prompt');
  assert.ok(prompt?.kind === 'prompt');
  assert.ok(entries.findIndex((e) => e.kind === 'prompt') < entries.findIndex((e) => e.kind === 'result'), 'logged before claude ran');
  assert.equal(prompt.note, 'try the other file');
  assert.equal(prompt.resume, false);
  assert.match(prompt.text, /try the other file/, 'the note is in the prompt too');
  assert.ok(prompt.lines > 1);
});
