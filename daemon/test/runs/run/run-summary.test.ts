import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-run-summary-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { isTestCommand, runSummary } = await import('../../../src/domain/runs/translate/summary.ts');
const { openDb } = await import('../../fixtures/open-db.ts');
const { taskDetail } = await import('../../../src/application/actions.ts');

const FIXTURES = join(import.meta.dirname, '../../fixtures/claude');
const recorded = (name: string): unknown[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const ctx = { testCmd: 'pnpm check:task', maxTurns: 60 };

test('runSummary on max-turns.jsonl: out of turns mid-work, with the limit from claude’s error', () => {
  const s = runSummary(recorded('max-turns.jsonl'), ctx);
  assert.equal(s.end, 'max_turns');
  assert.equal(s.turns, 1, 'one assistant message split over two events is one turn');
  assert.equal(s.max_turns, 1, 'the limit claude names wins over the task’s');
  assert.deepEqual(s.tools, [{ name: 'Read', count: 1 }]);
  assert.deepEqual([s.test_runs, s.test_turns, s.last_test, s.refused], [0, 0, null, 0]);
  assert.equal(s.minutes, 0.1, 'claude’s duration_ms, 3565 ms');
  assert.equal(s.test_minutes, 0);
  assert.equal(s.excerpt, null);
  assert.equal(s.final_message, null, 'it wrote no text');
  assert.equal(s.verdict, 'used 1 of 1 turns mid-work: no test runs');
});

test('runSummary on denied-tool.jsonl: ended on its own, the refused call counted and its error the excerpt', () => {
  const s = runSummary(recorded('denied-tool.jsonl'), ctx);
  assert.equal(s.end, 'ended');
  assert.equal(s.turns, 2);
  assert.equal(s.max_turns, 60, 'no max-turns error: the task’s limit');
  assert.deepEqual(s.tools, [{ name: 'Bash', count: 1 }]);
  assert.equal(s.test_runs, 0, 'touch out.txt is no test run');
  assert.equal(s.refused, 1);
  assert.match(s.excerpt!, /^Permission to use Bash has been denied/);
  assert.match(s.final_message!, /^I couldn't create `out.txt`/);
  assert.equal(s.verdict, 'ended after 2 turns: no test runs, 1 tool call refused');
});

let n = 0;
const at = (sec: number) => new Date(Date.UTC(2026, 10, 8, 12, 0, 0) + sec * 1000).toISOString();
function turn(sec: number, command: string, output: string, failed: boolean, took = 30): unknown[] {
  const id = `toolu_${++n}`;
  return [
    {
      type: 'assistant',
      timestamp: at(sec),
      message: { id: `msg_${n}`, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
    },
    {
      type: 'user',
      timestamp: at(sec + took),
      message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: failed, content: [{ type: 'text', text: output }] }] },
    },
  ];
}
const edit = (sec: number): unknown[] => [
  {
    type: 'assistant',
    timestamp: at(sec),
    message: { id: `msg_${++n}`, content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'Edit', input: { file_path: 'a.ts' } }] },
  },
];
const maxTurns = (turns: number) => ({
  type: 'result',
  subtype: 'error_max_turns',
  num_turns: turns + 1,
  duration_ms: 20 * 60_000,
  errors: [`Reached maximum number of turns (${turns})`],
  permission_denials: [],
});
const FAILING = 'Exit code 1\n\x1b[31m✖ adds the numbers\x1b[0m\n  expected 3, got 4\nnot ok 1 - adds';

test('runSummary on a stream of failing test runs: they kept failing, the excerpt is the last failure’s tail', () => {
  const events = [
    { type: 'system', subtype: 'init' },
    ...turn(0, 'pnpm check:task', `${FAILING} (first)`, true),
    ...edit(60),
    ...turn(120, 'cd daemon && node --experimental-strip-types --test test/a.test.ts', `${FAILING} (second)`, true),
    ...edit(180),
    ...turn(240, 'pnpm   check:task 2>&1 | tail -40', `${FAILING} (third)`, true, 90),
    ...turn(400, 'git status', 'nothing to commit', false),
    { type: 'agentdeck_tests', passed: false, output: 'not counted' },
    maxTurns(6),
  ];
  const s = runSummary(events, ctx);
  assert.equal(s.end, 'max_turns');
  assert.deepEqual([s.turns, s.max_turns], [6, 6]);
  assert.deepEqual(s.tools, [
    { name: 'Bash', count: 4 },
    { name: 'Edit', count: 2 },
  ]);
  assert.deepEqual([s.test_runs, s.test_turns, s.last_test], [3, 3, 'failed']);
  assert.equal(s.test_minutes, 2.5, '30 s + 30 s + 90 s in tests');
  assert.equal(s.minutes, 20);
  assert.equal(s.excerpt, 'Exit code 1\n✖ adds the numbers\n  expected 3, got 4\nnot ok 1 - adds (third)', 'colours stripped');
  assert.equal(s.verdict, 'used 6 of 6 turns, 3 of them running tests that kept failing');
});

test('runSummary: a last passing test run is mid-work, and the other ends say how they ended', () => {
  const passing = [...turn(0, 'pnpm test', 'Exit code 1\nfail', true), ...turn(60, 'pnpm test', 'ok', false)];
  assert.equal(runSummary([...passing, maxTurns(2)], ctx).verdict, 'used 2 of 2 turns mid-work: 2 test runs, the last passing');
  assert.equal(
    runSummary([...passing, { ...maxTurns(2), errors: [] }], { testCmd: null, maxTurns: null }).verdict,
    'used 2 turns mid-work: 2 test runs, the last passing',
    'no limit known',
  );

  const one = turn(0, 'cargo test', 'Exit code 101\npanicked', true);
  const cut = runSummary(one, ctx);
  assert.equal(cut.end, 'cut_off');
  assert.equal(cut.verdict, 'cut off after 1 turn: 1 test run, failing');
  assert.equal(cut.minutes, 0.5, 'no result: the span of the timestamps');
  assert.equal(cut.max_turns, 60);

  const errored = runSummary([...one, { type: 'result', subtype: 'error_during_execution', result: '  ' }], ctx);
  assert.equal(errored.verdict, 'stopped by error_during_execution after 1 turn: 1 test run, failing');
  assert.equal(runSummary([{ type: 'result' }], ctx).verdict, 'stopped by an error after 0 turns: no test runs');

  const ended = runSummary([...turn(0, 'pytest -x', 'ok', false), { type: 'result', subtype: 'success', result: ' Done. ' }], ctx);
  assert.deepEqual([ended.verdict, ended.final_message], ['ended after 1 turn: 1 test run, passing', 'Done.']);
});

test('runSummary skips subagents, junk and the daemon’s own events, and counts denials without a result', () => {
  const s = runSummary(
    [
      null,
      'text',
      { type: 'assistant', timestamp: 'not a time', message: { content: [{ type: 'text', text: ' Looking. ' }, { type: 'thinking' }] } },
      { type: 'assistant', parent_tool_use_id: 'toolu_x', message: { id: 'sub', content: [{ type: 'tool_use', name: 'Grep' }] } },
      { type: 'user', message: { content: 'a prompt' } },
      {
        type: 'user',
        message: { content: [{ type: 'text' }, { type: 'tool_result', tool_use_id: 'gone', is_error: true, content: 'boom' }] },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'gone', is_error: true, content: 7 }] } },
      { type: 'system', subtype: 'permission_denied' },
      { type: 'agentdeck_tests', passed: false, output: 'x' },
    ],
    ctx,
  );
  assert.deepEqual([s.turns, s.tools, s.refused, s.excerpt, s.final_message, s.minutes], [1, [], 1, 'boom', 'Looking.', 0]);
  assert.equal(s.verdict, 'cut off after 1 turn: no test runs, 1 tool call refused');

  const long = runSummary(turn(0, 'pnpm test', 'x'.repeat(5000), true), ctx).excerpt!;
  assert.equal(long.length, 1201);
  assert.ok(long.startsWith('…'));
  const untimed = runSummary(
    [
      { type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pnpm test' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
    ],
    ctx,
  );
  assert.deepEqual([untimed.test_runs, untimed.test_minutes, untimed.last_test], [1, 0, 'passed']);
});

test('isTestCommand: the repo’s test command anywhere in the command, or a common test runner', () => {
  const yes = [
    'pnpm check:task',
    'cd daemon && pnpm  check:task',
    'npm run test',
    'yarn test --watch=false',
    'go test ./...',
    'npx vitest run',
  ];
  for (const c of yes) assert.ok(isTestCommand(c, 'pnpm check:task'), c);
  const no = ['pnpm check', 'ls daemon/test', 'git commit -m "fix test"', 'pnpm typecheck'];
  for (const c of no) assert.ok(!isTestCommand(c, 'pnpm check:task'), c);
  assert.ok(!isTestCommand('make check', null));
  assert.ok(isTestCommand('make check', 'make check'));
});

const db = openDb(join(home, 'agentdeck.db'));
after(() => db.close());
const repo = db.addRepo({ name: 'demo', path: home, base_branch: 'main', test_cmd: 'pnpm check:task' });

test('taskDetail sums up a failed or blocked run from its log, and no other; agentdeck show prints its verdict', async () => {
  const task = db.addTask({ repo_id: repo.id, title: 'out of turns', prompt: 'p' });
  const failedLog = join(home, 'failed.jsonl');
  copyFileSync(join(FIXTURES, 'max-turns.jsonl'), failedLog);
  const blockedLog = join(home, 'blocked.jsonl');
  writeFileSync(
    blockedLog,
    `not json\n\n${[...turn(0, 'pnpm check:task', FAILING, true), maxTurns(9)].map((e) => JSON.stringify(e)).join('\n')}\n`,
  );
  db.finishRun(db.startRun(task.id, 1, failedLog), { outcome: 'failed' });
  db.finishRun(db.startRun(task.id, 2, blockedLog), { outcome: 'blocked' });
  db.finishRun(db.startRun(task.id, 3, failedLog), { outcome: 'done' });
  db.finishRun(db.startRun(task.id, 4, join(home, 'gone.jsonl')), { outcome: 'failed' });
  db.raw.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(task.id);

  const { runs } = await taskDetail(db, task.id);
  assert.deepEqual(
    runs.map((r) => r.summary?.verdict ?? null),
    ['used 1 of 1 turns mid-work: no test runs', 'used 1 of 9 turns mid-work: 1 test run, failing', null, null],
    'a done run has no summary, nor a failed one whose log is gone',
  );

  const CLI = join(import.meta.dirname, '../../../src/cli.ts');
  const shown = spawnSync(process.execPath, [CLI, 'show', String(task.id)], {
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_HOME: home, AGENTDECK_TASK_ID: '', AGENTDECK_PLANNER: '' },
  });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /^run 1: failed .*\n {2}used 1 of 1 turns mid-work: no test runs\n {2}0\.1 min · Read 1$/m);
  assert.match(
    shown.stdout,
    /^ {2}used 1 of 9 turns mid-work: 1 test run, failing\n {2}20 min, 0\.5 in tests · Bash 1\n {2}last failure:\n/m,
  );
  assert.match(shown.stdout, /^ {4}│ not ok 1 - adds$/m);
});
