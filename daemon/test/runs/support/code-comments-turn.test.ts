import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-code-comments-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('#test/fixtures/open-db.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { parseLogLine, runSummary } = await import('#domain/runs/index.ts');
const { buildCodeCommentsPrompt, workerSystemPrompt } = await import('#domain/runs/prompt.ts');

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
after(() => db.close());

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
git(dir, 'init', '-q', '-b', 'main');
git(dir, 'config', 'user.email', 'test@example.com');
git(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
git(dir, 'add', '-A');
git(dir, 'commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'test ! -f broken.txt' });

const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
const NOTE = 'AgentDeck counted the code comments';

function logEvents(path: string): any[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function lastSystemPrompt(): string {
  const lines = readFileSync(join(home, 'fake-claude-args.log'), 'utf8').split('\n').filter(Boolean);
  const args: string[] = JSON.parse(lines.at(-1)!);
  return args[args.indexOf('--append-system-prompt') + 1];
}

async function run(title: string, prompt: string) {
  const task = db.addTask({ repo_id: repo.id, title, prompt, max_attempts: 1 });
  await drain();
  const [first] = db.runsForTask(task.id).filter((r) => r.kind === 'work');
  const events = logEvents(first.log_path);
  return {
    task: db.getTask(task.id)!,
    run: first,
    events,
    prompts: events.filter((e) => e.type === 'agentdeck_prompt'),
    measured: events.filter((e) => e.type === 'agentdeck_code_comments'),
  };
}

test('a run whose branch adds 10 code comment lines gets one resumed turn with the note, and ends done with the lower count', async () => {
  const { task, run: r, prompts, measured, events } = await run('over', 'FAKE_COMMENTS add constants.');
  assert.equal(task.status, 'done');
  assert.equal(prompts.length, 2, 'the work and one turn');
  assert.equal(prompts[1].resume, true);
  assert.match(
    prompts[1].text,
    new RegExp(`^${NOTE} your branch adds: 10 code comment lines added \\(50%\\), over the limit of 5 lines or 5%`),
  );
  assert.match(prompts[1].text, /- commented\.ts: 10/);
  assert.deepEqual(
    measured.map((m) => [m.lines, m.over]),
    [
      [10, true],
      [0, false],
    ],
  );
  assert.equal(r.code_comment_lines, 0);
  assert.equal(r.code_comment_percent, 0);
  assert.equal(r.outcome, 'done');
  assert.equal(r.num_turns, 6, 'the turn’s turns are added to the run’s');
  assert.match(r.result_text!, /^Wrote fake-output\.txt/, 'the first final message stays the PR body');
  assert.equal(events.filter((e) => e.type === 'agentdeck_tests').length, 2, 'the tests run again after the turn');
  assert.match(lastSystemPrompt(), /Write no code comments beyond what this repo's own rules ask for/);
  const shown = events.flatMap((e) => parseLogLine(JSON.stringify(e)));
  assert.ok(shown.some((e) => e.kind === 'text' && e.text.startsWith('Code comments: 10 code comment lines added (50%), over')));
  assert.ok(shown.some((e) => e.kind === 'prompt' && e.resume && e.text.startsWith(NOTE)));
});

test('a run still over after its one turn ends done, with no second turn', async () => {
  const { task, run: r, prompts, measured } = await run('stays', 'FAKE_COMMENTS FAKE_COMMENTS_STAY add constants.');
  assert.equal(task.status, 'done');
  assert.equal(prompts.length, 2);
  assert.deepEqual(
    measured.map((m) => m.lines),
    [10, 10],
  );
  assert.equal(r.code_comment_lines, 10);
  assert.equal(r.code_comment_percent, 50);
});

test('a test that fails after the turn ends the run failed', async () => {
  const { task, run: r, events } = await run('breaks', 'FAKE_COMMENTS FAKE_COMMENTS_BREAK add constants.');
  assert.equal(task.status, 'failed');
  assert.equal(r.outcome, 'failed');
  assert.equal(r.tests_passed, false);
  assert.equal(r.code_comment_lines, 0);
  assert.match(runSummary(events, { testCmd: repo.test_cmd, maxTurns: 10 }).verdict, /; 0 code comment lines added \(0%\), within/);
});

test('a run under the limit gets no turn, and its count is stored', async () => {
  const { task, run: r, prompts, measured } = await run('under', 'Write the output.');
  assert.equal(task.status, 'done');
  assert.equal(prompts.length, 1);
  assert.deepEqual(
    measured.map((m) => [m.lines, m.over]),
    [[0, false]],
  );
  assert.equal(r.code_comment_lines, 0);
});

test('a repo with both limits at 0 gets no measurement, no turn and no prompt line', async () => {
  db.updateRepo(repo.id, { code_comment_max_lines: 0, code_comment_max_percent: 0 });
  const { task, run: r, prompts, measured } = await run('off', 'FAKE_COMMENTS add constants.');
  assert.equal(task.status, 'done');
  assert.equal(prompts.length, 1);
  assert.deepEqual(measured, []);
  assert.equal(r.code_comment_lines, null);
  assert.equal(r.code_comment_percent, null);
  assert.doesNotMatch(lastSystemPrompt(), /code comments/);
});

test('the note names each file and the limits that are on, and the system prompt line only when a limit is on', () => {
  const count = { files: [{ path: 'a.ts', lines: 7 }], lines: 7, added: 70, percent: 10 };
  const note = buildCodeCommentsPrompt(count, { code_comment_max_lines: 0, code_comment_max_percent: 5 }, null);
  assert.match(note, /7 code comment lines added \(10%\), over the limit of 5%\./);
  assert.match(note, /- a\.ts: 7/);
  assert.match(note, /run the tests if there are any/);
  assert.match(workerSystemPrompt(null, { code_comment_max_lines: 1, code_comment_max_percent: 0 }), /more than 1 line back to you/);
  assert.doesNotMatch(workerSystemPrompt(null), /code comments/);
});
