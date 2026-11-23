// Pure tests of how a verify run's findings are shown, and small helpers of the run log and sandbox.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  costText,
  dueVerifyComment,
  findingPlace,
  isTestCommand,
  latestVerify,
  normalizeNetwork,
  parseVerifyAnswer,
  settingsPath,
  verifyLine,
  verifyRefusal,
} from '#domain/runs/index.ts';
import { asRunId, asTaskId } from '#domain/shared/id.ts';

test('a verify line counts the claims by verdict, and says when there are none', () => {
  assert.equal(verifyLine([]), 'No claims about the code');
  assert.equal(verifyLine([{ verdict: 'true' }]), '1 claim: 1 true');
  assert.match(verifyLine([{ verdict: 'false' }, { verdict: 'true' }, { verdict: 'false' }]), /^3 claims: .*2 false/);
});

test('a finding is placed at its file and line, at its file alone, or nowhere', () => {
  assert.equal(findingPlace({ path: 'a.ts', line: 4 }), 'a.ts:4');
  assert.equal(findingPlace({ path: 'a.ts', line: null }), 'a.ts');
  assert.equal(findingPlace({ path: null, line: 4 }), null);
});

test('a verify run is refused for a task that is not proposed or queued, or that already has one going', () => {
  const task = (status: string) => ({ id: asTaskId(3), status }) as never;
  assert.equal(verifyRefusal(task('queued'), []), null);
  assert.match(verifyRefusal(task('done'), []) ?? '', /#3 is done: a verify run is for a proposed or queued task/);
  assert.match(verifyRefusal(task('proposed'), [{ kind: 'verify', ended_at: null }]) ?? '', /already has a verify run going/);
  assert.equal(verifyRefusal(task('proposed'), [{ kind: 'verify', ended_at: '2026-01-01 00:00:00' }]), null);
});

test('the latest verify run is going, done with findings, or failed with none, and is none when there was no verify run', () => {
  const run = (over: Record<string, unknown>) =>
    ({ id: asRunId(1), kind: 'verify', outcome: 'done', result_text: null, started_at: 's', ended_at: null, ...over }) as never;
  assert.equal(latestVerify([{ ...(run({}) as object), kind: 'work' } as never], null), null);
  assert.equal(latestVerify([run({})], null)?.state, 'going');
  assert.equal(latestVerify([run({ ended_at: 'e' })], null)?.state, 'failed');
  const done = latestVerify([run({ ended_at: 'e', base_commit: 'abc', result_text: '{"findings":[]}' })], 'abc');
  assert.equal(done?.commit, 'abc');
});

test('cost is a dash for none, under a cent for a trace, and dollars otherwise', () => {
  assert.equal(costText(0), '–');
  assert.equal(costText(Number.NaN), '–');
  assert.equal(costText(0.004), '<$0.01 equiv');
  assert.equal(costText(1.234), '$1.23 equiv');
});

test('a test command is the repo test command or a known test runner', () => {
  assert.ok(isTestCommand('cd x && pnpm  test', 'pnpm test'));
  assert.ok(isTestCommand('node --test', null));
  assert.ok(isTestCommand('cargo test', null));
  assert.ok(!isTestCommand('ls -la', null));
  assert.ok(!isTestCommand('ls', ''));
});

test('the settings file sits beside the log, and network hosts are split and deduplicated', () => {
  assert.equal(settingsPath('/logs/task-1-attempt-1.jsonl'), '/logs/task-1-attempt-1.settings.json');
  assert.equal(settingsPath('/logs/x'), '/logs/x.settings.json');
  assert.deepEqual(normalizeNetwork('a.com, b.com a.com'), ['a.com', 'b.com']);
});

test("a verify run's findings go on the issue once, and a run with none or that failed puts nothing there", () => {
  const findings = [
    { claim: 'greet() takes a name', verdict: 'true', path: 'src/greet.ts', line: 2, evidence: 'It does.' },
    {
      claim: 'push() returns nothing',
      verdict: 'false',
      path: 'src/queue.ts',
      line: 5,
      evidence: 'It returns the length.',
      fix: 'Say it returns the length.',
    },
  ];
  const run = (id: number, over: Record<string, unknown> = {}) =>
    ({
      id: asRunId(id),
      kind: 'verify',
      outcome: 'done',
      result_text: JSON.stringify({ findings }),
      ended_at: 'e',
      base_commit: 'abc1234def',
      ...over,
    }) as never;
  const task = { id: asTaskId(3) };
  const due = dueVerifyComment(task, [run(1)], null);
  assert.equal(due?.run_id, 1);
  assert.match(due?.comment ?? '', /^A verify run on task #3 read `abc1234` and found 2 claims: 1 true, 1 false\./);
  assert.match(
    due?.comment ?? '',
    /- \*\*false\*\* `src\/queue.ts:5`: push\(\) returns nothing\n  It returns the length\.\n  Suggested fix: Say it returns the length\./,
  );
  assert.equal(dueVerifyComment(task, [run(1)], asRunId(1)), null, 'once');
  assert.equal(dueVerifyComment(task, [run(1), run(2, { ended_at: null })], asRunId(1)), null, 'a run still going waits');
  assert.equal(dueVerifyComment(task, [run(2, { outcome: 'failed', result_text: 'x' })], null), null);
  assert.equal(dueVerifyComment(task, [run(2, { result_text: JSON.stringify({ findings: [] }) })], null), null);
  assert.equal(dueVerifyComment(task, [{ ...(run(4) as object), kind: 'work' } as never], null), null);
});

test('a finding may cover a range of lines; an end at or before its line is dropped', () => {
  const end = (line: unknown, end_line: unknown) =>
    parseVerifyAnswer({ findings: [{ claim: 'c', verdict: 'true', path: 'a.ts', line, end_line, evidence: 'e' }] })?.findings[0].end_line;
  assert.equal(end(82, 89), 89);
  assert.equal(end('82', '89'), 89);
  for (const bad of [82, 10, 0, 'x', null, undefined]) assert.equal(end(82, bad), null);
  assert.equal(end(null, 89), null);
  assert.equal(findingPlace({ path: 'a.ts', line: 82, end_line: 89 }), 'a.ts:82-89');
});
