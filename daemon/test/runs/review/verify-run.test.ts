import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Run } from '#domain/runs/run.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-verify-run-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('#db/index.ts');
const { rejectTask, startVerify } = await import('#application/actions.ts');
const { ActionError } = await import('#application/shared/input.ts');
const {
  CLAIM_VERDICTS,
  VERIFY_ANSWER_SCHEMA,
  VERIFY_TOOLS,
  buildVerifyPrompt,
  findingPlace,
  latestVerify,
  parseVerifyAnswer,
  runFindings,
  verifyLine,
  verifyRefusal,
  verifySchemaArgs,
} = await import('#domain/runs/verify.ts');
const { runLabel, runModel } = await import('#domain/runs/run.ts');
const { buildPrBody } = await import('#domain/landing/pull-request/pr.ts');
const { restartWait } = await import('#domain/operations/restart.ts');
const { asRunId, asTaskId, testApp, waitFor } = await import('#test/fixtures/fixtures.ts');
const { VERDICT_MARKS, sortFindings, verifyHeadline } = await import('#app/lib/runs/verify.ts');

const PROMPT = `## Goal
Count the words in a file.

## Context
count() lives in src/count.ts.`;

test("the prompt quotes the task's whole prompt, names the base and its commit, and says what to answer", () => {
  const prompt = buildVerifyPrompt({ id: asTaskId(7), title: 'Count words', prompt: PROMPT }, { ref: 'main', commit: 'abc1234' });
  assert.match(prompt, /^AgentDeck verify run for task #7: "Count words"\./);
  assert.match(prompt, /## The task's prompt\n## Goal\nCount the words in a file\.\n\n## Context\ncount\(\) lives in src\/count\.ts\./);
  assert.match(prompt, /## The code\nYou are in a checkout of main at abc1234/);
  assert.match(prompt, /## What to answer\n- A finding for each claim/);
  for (const v of ['true', 'false', 'stale', 'partly']) assert.ok(prompt.includes(v), v);
  assert.match(prompt, /The file and line/);
  assert.match(prompt, /suggested fix/);
});

test('the answer schema lists the findings with their verdicts, and goes to claude as --json-schema', () => {
  assert.deepEqual(VERIFY_ANSWER_SCHEMA.required, ['findings']);
  const item = VERIFY_ANSWER_SCHEMA.properties.findings.items;
  assert.deepEqual(item.required, ['claim', 'verdict', 'path', 'line', 'evidence']);
  assert.deepEqual(item.properties.verdict.enum, ['true', 'false', 'stale', 'partly']);
  assert.deepEqual([...CLAIM_VERDICTS], item.properties.verdict.enum);
  const args = verifySchemaArgs();
  assert.equal(args[0], '--json-schema');
  assert.deepEqual(JSON.parse(args[1]), VERIFY_ANSWER_SCHEMA);
});

const good = {
  findings: [
    { claim: 'count() lives in src/count.ts', verdict: 'true', path: 'src/count.ts', line: 3, evidence: 'Defined there.', fix: null },
    {
      claim: 'There is a test for count()',
      verdict: 'false',
      path: 'test/count.test.ts',
      line: null,
      evidence: 'No such file.',
      fix: 'Ask for the test to be written.',
    },
  ],
};

test('parseVerifyAnswer: a good answer, as structured output, JSON text or a fenced block', () => {
  assert.deepEqual(parseVerifyAnswer(good), good);
  assert.deepEqual(parseVerifyAnswer(JSON.stringify(good)), good);
  assert.deepEqual(parseVerifyAnswer(`Here:\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n`), good);
  assert.deepEqual(parseVerifyAnswer({ findings: [] }), { findings: [] }, 'a prompt with no claims');
});

test('parseVerifyAnswer: a partial answer keeps what it can', () => {
  const answer = parseVerifyAnswer({
    findings: [
      { claim: ' A file exists ', verdict: 'Stale', line: '4', path: 'a.ts', evidence: 'Moved.', fix: '  ' },
      { claim: 'No place', verdict: 'partly' },
      { claim: 'Bad line', verdict: 'true', path: 'b.ts', line: 0, evidence: 'x' },
      { claim: '', verdict: 'true' },
      { claim: 'Unknown verdict', verdict: 'maybe' },
      'not a finding',
    ],
  });
  assert.deepEqual(answer, {
    findings: [
      { claim: 'A file exists', verdict: 'stale', path: 'a.ts', line: 4, evidence: 'Moved.', fix: null },
      { claim: 'No place', verdict: 'partly', path: null, line: null, evidence: '', fix: null },
      { claim: 'Bad line', verdict: 'true', path: 'b.ts', line: null, evidence: 'x', fix: null },
    ],
  });
});

test('parseVerifyAnswer: garbage is null', () => {
  for (const raw of [null, undefined, '', 'All claims hold.', '{not json', '[]', 42, [good], { summary: 'fine' }, { findings: 'none' }])
    assert.equal(parseVerifyAnswer(raw), null, JSON.stringify(raw));
});

test('verifyRefusal: only a proposed or queued task, and one verify run at a time', () => {
  const id = asTaskId(3);
  assert.equal(verifyRefusal({ id, status: 'proposed' }, []), null);
  assert.equal(verifyRefusal({ id, status: 'queued' }, [{ kind: 'verify', ended_at: '2026-11-09 10:00:00' }]), null);
  assert.match(verifyRefusal({ id, status: 'running' }, [])!, /#3 is running: a verify run is for a proposed or queued task/);
  assert.match(verifyRefusal({ id, status: 'done' }, [])!, /is done/);
  assert.match(verifyRefusal({ id, status: 'queued' }, [{ kind: 'verify', ended_at: null }])!, /already has a verify run going/);
  assert.equal(verifyRefusal({ id, status: 'queued' }, [{ kind: 'review', ended_at: null }]), null, 'another kind is not one');
});

type ViewRun = Parameters<typeof latestVerify>[0][number];
const vrun = (o: Partial<ViewRun>): ViewRun => ({
  id: asRunId(1),
  kind: 'verify',
  outcome: 'done',
  result_text: JSON.stringify(good),
  base_commit: 'aaa',
  started_at: '2026-11-09 10:00:00',
  ended_at: '2026-11-09 10:02:00',
  ...o,
});

test('latestVerify: the newest verify run, its findings, and stale once the base moved on', () => {
  assert.equal(latestVerify([vrun({ kind: 'work' })], 'aaa'), null);
  const view = latestVerify(
    [vrun({ id: asRunId(1), base_commit: 'old' }), vrun({ id: asRunId(2), kind: 'work' }), vrun({ id: asRunId(3) })],
    'aaa',
  )!;
  assert.equal(view.run_id, 3);
  assert.equal(view.state, 'done');
  assert.equal(view.commit, 'aaa');
  assert.equal(view.stale, false);
  assert.deepEqual(view.findings, good.findings);
  assert.equal(latestVerify([vrun({})], 'bbb')!.stale, true, 'the base moved on');
  assert.equal(latestVerify([vrun({})], null)!.stale, false, 'the base is not known');
  assert.equal(latestVerify([vrun({ ended_at: null, outcome: null, result_text: null })], 'aaa')!.state, 'going');
  const failed = latestVerify([vrun({ outcome: 'failed', result_text: 'the verify run gave no answer that could be read' })], 'aaa')!;
  assert.equal(failed.state, 'failed');
  assert.deepEqual(failed.findings, []);
  assert.match(failed.reason!, /no answer/);
  assert.equal(runFindings({ kind: 'work', outcome: 'done', result_text: JSON.stringify(good) }), null, 'only a verify run has findings');
});

test('verifyLine, findingPlace, and the run kind in labels, models, the PR body and a restart', () => {
  assert.equal(verifyLine([]), 'No claims about the code');
  assert.equal(verifyLine([{ verdict: 'true' }, { verdict: 'false' }, { verdict: 'true' }]), '3 claims: 2 true, 1 false');
  assert.equal(findingPlace({ path: 'a.ts', line: 3 }), 'a.ts:3');
  assert.equal(findingPlace({ path: 'a.ts', line: null }), 'a.ts');
  assert.equal(findingPlace({ path: null, line: null }), null);
  assert.equal(runLabel({ kind: 'verify', attempt: 0 }), 'Verify');
  assert.equal(runModel('verify', { model: 'haiku' }, { support_model: 'sonnet', review_model: 'opus' }), 'opus');
  const row = { attempt: 0, outcome: 'done', num_turns: 3, cost_usd: 0.5, tests_passed: null, result_text: null };
  const body = buildPrBody({ id: 1 }, [
    { ...row, kind: 'verify' },
    { ...row, kind: 'work', attempt: 1 },
  ]);
  assert.equal(body.split('\n').filter((l) => l.startsWith('| 0')).length, 0, 'a verify run is not in the run table');
  assert.equal(body.split('\n').filter((l) => l.startsWith('| 1')).length, 1);
  assert.equal(restartWait({ tasks: 0, planner: 0, resolves: 0, verifies: 1 }), '1 verify run');
});

test('the dashboard: false claims first and marked failed, and the line with the commit and staleness', () => {
  const f = (claim: string, verdict: 'true' | 'false' | 'stale' | 'partly') => ({
    claim,
    verdict,
    path: null,
    line: null,
    evidence: '',
    fix: null,
  });
  const sorted = sortFindings([f('a', 'true'), f('b', 'false'), f('c', 'partly'), f('d', 'stale'), f('e', 'false')]);
  assert.deepEqual(
    sorted.map((x) => x.claim),
    ['b', 'e', 'd', 'c', 'a'],
  );
  assert.equal(VERDICT_MARKS.false.tone, 'failed');
  assert.equal(VERDICT_MARKS.false.label, 'false');
  assert.equal(VERDICT_MARKS.true.tone, 'done');
  for (const v of CLAIM_VERDICTS) assert.ok(VERDICT_MARKS[v], `${v} has a mark`);
  const done = { state: 'done' as const, findings: [f('a', 'true'), f('b', 'false')], commit: 'abc1234def', stale: false, reason: null };
  assert.equal(verifyHeadline(done), '2 claims: 1 true, 1 false at abc1234');
  assert.match(verifyHeadline({ ...done, stale: true }), /stale: the base has moved on/);
  assert.match(verifyHeadline({ ...done, state: 'going' }), /going/);
  assert.equal(
    verifyHeadline({ ...done, state: 'failed', findings: [], reason: 'no answer' }),
    'The verify run ended with no findings: no answer',
  );
});

const db = testApp(openDb(join(home, 'test.db')));
db.setSetting('max_concurrent', '3');
db.setPaused(false);
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let repos = 0;
function makeRepo() {
  const name = `demo-${++repos}`;
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), '# README\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { ...db.addRepo({ name, path: dir, base_branch: 'main' }), path: dir };
}
const fakeArgs = (): string[][] =>
  readFileSync(join(home, 'fake-claude-args.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const flagValues = (args: string[], flag: string): string[] => {
  const from = args.indexOf(flag) + 1;
  const end = args.findIndex((a, i) => i >= from && a.startsWith('--'));
  return args.slice(from, end === -1 ? undefined : end);
};
const verifyRuns = (id: number): Run[] => db.runsForTask(asTaskId(id)).filter((r) => r.kind === 'verify');

test('a verify run stores its findings and the commit it read, uses no attempt, and leaves the task as it was', async () => {
  const repo = makeRepo();
  const task = db.addTask({ repo_id: repo.id, title: 'count', prompt: PROMPT, status: 'proposed' });
  const head = sh(repo.path, 'rev-parse', 'HEAD');
  const { run_id, done } = startVerify(db, task.id);
  assert.throws(() => startVerify(db, task.id), /already has a verify run going/, 'one at a time');
  const report = await done;

  assert.equal(report.outcome, 'done');
  assert.equal(report.commit, head);
  assert.deepEqual(
    report.findings.map((f) => [f.verdict, f.claim]),
    [
      ['true', 'README.md has a heading'],
      ['false', 'src/count.ts exports count()'],
    ],
  );
  const [run] = verifyRuns(task.id);
  assert.equal(run.id, run_id);
  assert.equal(run.outcome, 'done');
  assert.equal(run.base_commit, head);
  assert.equal(run.attempt, 0, 'it ran beside no attempt');
  assert.equal(run.model, 'opus', 'the review model');
  assert.ok(run.pid, 'its pid is recorded');
  assert.deepEqual(JSON.parse(run.result_text!), { findings: report.findings }, 'its result is its findings, as JSON');
  assert.deepEqual(runFindings(run), report.findings);
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'proposed');
  assert.equal(t.attempts, 0);
  assert.equal(t.checkout, null, 'no worktree of its own');
  assert.equal(db.slotsUsed(), 0);
  assert.equal(sh(repo.path, 'worktree', 'list').split('\n').length, 1, 'the scratch checkout is gone');

  const args = fakeArgs().find((a) => a[a.indexOf('-p') + 1].startsWith(`AgentDeck verify run for task #${task.id}`))!;
  assert.equal(args[args.indexOf('--max-turns') + 1], '30');
  assert.match(args[args.indexOf('--append-system-prompt') + 1], /AgentDeck verify run/);
  assert.ok(args.includes('--json-schema'));
  assert.deepEqual(flagValues(args, '--allowedTools'), VERIFY_TOOLS);
  const denied = flagValues(args, '--disallowedTools');
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash(git push*)']) assert.ok(denied.includes(tool), tool);

  assert.equal(latestVerify(db.runsForTask(task.id), head)!.stale, false);
  writeFileSync(join(repo.path, 'other.txt'), 'more\n');
  sh(repo.path, 'add', '-A');
  sh(repo.path, 'commit', '-q', '-m', 'main moves on');
  assert.equal(latestVerify(db.runsForTask(task.id), sh(repo.path, 'rev-parse', 'HEAD'))!.stale, true);
});

test('a garbage answer ends the run failed, with no findings', async () => {
  const repo = makeRepo();
  const task = db.addTask({ repo_id: repo.id, title: 'garbage', prompt: 'FAKE_VERIFY_GARBAGE', status: 'queued' });
  const report = await startVerify(db, task.id).done;
  assert.equal(report.outcome, 'garbage');
  const [run] = verifyRuns(task.id);
  assert.equal(run.outcome, 'failed');
  assert.equal(latestVerify([run], null)!.state, 'failed');
  assert.equal(db.getTask(task.id)!.status, 'queued');
});

test('only a proposed or queued task, and only when work may start', () => {
  const repo = makeRepo();
  const done = db.addTask({ repo_id: repo.id, title: 'done', prompt: 'x', status: 'proposed' });
  rejectTask(db, done.id);
  assert.throws(
    () => startVerify(db, done.id),
    (e: Error) => e instanceof ActionError && /is cancelled/.test(e.message),
  );
  const queued = db.addTask({ repo_id: repo.id, title: 'paused', prompt: 'x', status: 'queued' });
  db.setPaused(true);
  try {
    assert.throws(() => startVerify(db, queued.id), /a verify run can't start now/);
  } finally {
    db.setPaused(false);
  }
  assert.equal(verifyRuns(queued.id).length, 0);
});

test('a reject ends a verify run that is going', async () => {
  const repo = makeRepo();
  const task = db.addTask({ repo_id: repo.id, title: 'slow', prompt: 'FAKE_VERIFY_SLOW', status: 'proposed' });
  const { done } = startVerify(db, task.id);
  await waitFor(() => verifyRuns(task.id)[0]?.pid, { what: 'the verify run to start claude' });
  rejectTask(db, task.id);
  const report = await done;
  assert.equal(report.outcome, 'cancelled');
  assert.equal(verifyRuns(task.id)[0].outcome, 'cancelled');
  assert.equal(db.getTask(task.id)!.status, 'cancelled');
});

test('a claim ends the verify run of a queued task', async () => {
  const repo = makeRepo();
  const task = db.addTask({ repo_id: repo.id, title: 'claimed', prompt: 'FAKE_VERIFY_SLOW', status: 'queued' });
  const { done } = startVerify(db, task.id);
  await waitFor(() => verifyRuns(task.id)[0]?.pid, { what: 'the verify run to start claude' });
  while (db.getTask(task.id)!.status === 'queued') assert.ok(db.claimNextTask(), 'a claim');
  assert.equal((await done).outcome, 'cancelled');
  assert.equal(db.getTask(task.id)!.attempts, 1, 'only the claim used an attempt');
});
