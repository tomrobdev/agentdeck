// Pure tests of how a verify run's findings are shown, and small helpers of the run log and sandbox.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  costText,
  findingPlace,
  isTestCommand,
  latestVerify,
  normalizeNetwork,
  settingsPath,
  verifyLine,
  verifyRefusal,
} from '../../src/domain/runs/index.ts';
import { asRunId, asTaskId } from '../../src/domain/shared/id.ts';

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
