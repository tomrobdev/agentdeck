// The unblock run: when one may start (unblockable), what its final message says (parseUnblock), what follows
// (unblockDecision), and the whole of it with fake claude: a retry with a note that uses no attempt, or a question.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { RunKind, RunOutcome } from '../src/domain/run/run.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-unblock-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { nextUnblockable, runUnblock } = await import('../src/application/run/unblock.ts');
const { updateRepo } = await import('../src/application/actions.ts');
const { repoSettingPatch } = await import('../src/cli/settings-args.ts');
const { restartWait } = await import('../src/domain/daemon/restart.ts');
const { describeEvent } = await import('../src/domain/task/digest.ts');
const { conflictReason } = await import('../src/domain/branch/sync.ts');
const { setupFailedReason } = await import('../src/domain/run/run.ts');
const { UNBLOCK_NOTE, buildUnblockPrompt, parseUnblock, readQuestion, unblockDecision, unblockable } =
  await import('../src/domain/run/unblock.ts');

// ---- unblockable

const ON = { auto_unblock: 1 };
const blocked = (o: { needs?: string | null; stop_reason?: string | null } = {}) => ({
  status: 'blocked' as const,
  needs: null,
  stop_reason: 'which database?',
  ...o,
});
const run = (kind: RunKind, outcome: RunOutcome | null = 'done') => ({ kind, outcome });

test('unblockable: off by default, and only for a blocked task', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r-default', base_branch: 'main' });
  assert.equal(repo.auto_unblock, 0, 'auto_unblock is off for a new repo');
  assert.equal(unblockable(blocked(), [run('work', 'blocked')], repo), false);
  assert.equal(unblockable(blocked(), [run('work', 'blocked')], ON), true);
  for (const status of ['queued', 'running', 'done', 'failed', 'cancelled'] as const)
    assert.equal(unblockable({ ...blocked(), status }, [run('work', 'blocked')], ON), false, status);
  db.close();
});

test('unblockable: never for NEEDS deps or host, a setup failure or a conflict', () => {
  const work = [run('work', 'blocked')];
  assert.equal(unblockable(blocked({ needs: '{"kind":"deps","items":["zod"]}' }), work, ON), false);
  assert.equal(unblockable(blocked({ needs: '{"kind":"host","items":["example.com"]}' }), work, ON), false);
  assert.equal(unblockable(blocked({ stop_reason: setupFailedReason('npm ERR! missing script') }), work, ON), false);
  assert.equal(unblockable(blocked({ stop_reason: conflictReason('main', ['a.ts', 'b.ts']) }), work, ON), false);
  assert.equal(unblockable(blocked({ stop_reason: conflictReason('main', [], 'tests failed') }), work, ON), false);
  // A file the worker may not edit is not a person-only block.
  assert.equal(unblockable(blocked({ needs: '{"kind":"edit","items":[".claude/x.md"]}' }), work, ON), true);
});

test('unblockable: once per block', () => {
  const t = blocked();
  assert.equal(unblockable(t, [run('work', 'blocked'), run('unblock', 'blocked')], ON), false, 'it already had one');
  assert.equal(unblockable(t, [run('work', 'blocked'), run('unblock', null)], ON), false, 'one is still going');
  assert.equal(unblockable(t, [run('work', 'blocked'), run('unblock', 'failed')], ON), false, 'a failed one counts');
  assert.equal(unblockable(t, [run('work', 'blocked'), run('unblock', 'interrupted')], ON), false, 'a restart ended one');
  assert.equal(
    unblockable(t, [run('work', 'blocked'), run('unblock', 'rate_limited')], ON),
    true,
    'a rate limit stopped it before it read',
  );
  assert.equal(
    unblockable(t, [run('work', 'blocked'), run('unblock'), run('work', 'blocked')], ON),
    true,
    'a new block after a retry gets its own',
  );
  assert.equal(unblockable(t, [run('work', 'blocked'), run('resolve', 'failed')], ON), true, 'a resolve run is not one');
});

// ---- the parser and the decision

test('parseUnblock: a retry with its note', () => {
  assert.deepEqual(parseUnblock('Read the README.\nUNBLOCK: RETRY: use sqlite\n'), { retry: 'use sqlite' });
  assert.deepEqual(parseUnblock('unblock: retry:   trim me  '), { retry: 'trim me' });
});

test('parseUnblock: an ask with its options, at most four', () => {
  assert.deepEqual(parseUnblock('Hmm.\nUNBLOCK: ASK: Which database?\n- sqlite\n- postgres\n'), {
    ask: 'Which database?',
    options: ['sqlite', 'postgres'],
  });
  assert.deepEqual(parseUnblock('UNBLOCK: ASK: Pick one\n- a\n- b\n- c\n- d\n- e'), { ask: 'Pick one', options: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(parseUnblock('UNBLOCK: ASK: Pick one\n\n* a\nthat is all\n- b'), { ask: 'Pick one', options: ['a'] });
  assert.deepEqual(parseUnblock('UNBLOCK: ASK: Just this?'), { ask: 'Just this?', options: [] });
});

test('parseUnblock: a malformed ending counts as ask with the last line', () => {
  assert.deepEqual(parseUnblock('I looked around.\nNot sure what to make of it.'), { ask: 'Not sure what to make of it.', options: [] });
  assert.deepEqual(parseUnblock('Tried.\nUNBLOCK: RETRY:'), { ask: 'UNBLOCK: RETRY:', options: [] });
  assert.deepEqual(parseUnblock('STATUS: DONE'), { ask: 'STATUS: DONE', options: [] });
  assert.equal('ask' in parseUnblock(''), true);
  assert.equal('ask' in parseUnblock(null), true);
});

test('unblockDecision: a retry needs attempts left; otherwise it asks', () => {
  assert.deepEqual(unblockDecision({ retry: 'use sqlite' }, { attempts: 1, max_attempts: 2 }), { retry: `${UNBLOCK_NOTE}use sqlite` });
  const none = unblockDecision({ retry: 'use sqlite' }, { attempts: 2, max_attempts: 2 });
  assert.ok('ask' in none && none.ask.question.includes('use sqlite') && /no attempts left/.test(none.ask.question));
  assert.deepEqual(unblockDecision({ ask: 'Which?', options: ['a'] }, { attempts: 0, max_attempts: 3 }), {
    ask: { question: 'Which?', options: ['a'] },
  });
  assert.equal(readQuestion('{"question":"Which?","options":["a"]}')?.question, 'Which?');
  assert.equal(readQuestion('not json'), null);
  assert.equal(readQuestion(null), null);
});

test('buildUnblockPrompt: the task, why it stopped, the last message and the review note', () => {
  const prompt = buildUnblockPrompt(
    { id: 7, title: 'Pick a db', prompt: 'Add storage.', stop_reason: 'which database?' },
    { plan: null, lastMessage: 'I need to know which database.', reviewNote: 'keep it small' },
  );
  assert.ok(prompt.startsWith('AgentDeck unblock run for task #7'));
  for (const part of [
    'Add storage.',
    'which database?',
    'I need to know which database.',
    'keep it small',
    'UNBLOCK: RETRY:',
    'UNBLOCK: ASK:',
  ])
    assert.ok(prompt.includes(part), part);
});

test('repo set auto_unblock on|off', () => {
  assert.deepEqual(repoSettingPatch('auto_unblock', 'on'), { auto_unblock: true });
  assert.deepEqual(repoSettingPatch('auto_unblock', 'off'), { auto_unblock: false });
});

// ---- the slot, the claim and crash recovery

test('an open unblock run takes a slot, keeps a retried task from being claimed, and a restart ends it', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r-slots', base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  assert.ok(db.applyEvent(t.id, { type: 'claim' }));
  assert.ok(db.applyEvent(t.id, { type: 'finish', outcome: 'blocked' }, { reason: 'stuck' }));
  const runId = db.startRun(t.id, 1, '/tmp/unblock.log', 'unblock');
  assert.equal(db.slotsUsed(), 1);
  assert.equal(db.countRunningUnblocks(), 1);
  assert.equal(restartWait({ tasks: 0, planner: 0, resolves: 0, unblocks: 1 }), '1 unblock run');

  // A person retries while it runs: the claim waits for the unblock run to end.
  assert.ok(db.applyEvent(t.id, { type: 'retry' }));
  assert.equal(db.claimNextTask(), undefined);
  assert.equal(db.hasQueued(), false);

  db.recoverOrphans();
  const ended = db.runsForTask(t.id).find((r) => r.id === runId)!;
  assert.equal(ended.outcome, 'interrupted');
  assert.equal(db.countRunningUnblocks(), 0);
  assert.equal(db.claimNextTask()?.id, t.id);
  db.close();
});

// ---- with fake claude

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let repos = 0;
/** A git repo of its own for each test, with auto_unblock as given. */
function makeRepo(autoUnblock: boolean) {
  const name = `demo-${++repos}`;
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), 'Use sqlite.\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  const repo = db.addRepo({ name, path: dir, base_branch: 'main' });
  if (autoUnblock) updateRepo(db, name, { auto_unblock: true });
  return repo;
}
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
const fakeArgs = (): string[][] =>
  readFileSync(join(home, 'fake-claude-args.log'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('a blocked task gets one unblock run, then is queued again with the note and its attempts unchanged', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'which db', prompt: 'FAKE_BLOCKED add storage', max_attempts: 3 });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  const runs = db.runsForTask(task.id);
  assert.deepEqual(
    runs.map((r) => r.kind),
    ['work', 'unblock', 'work'],
  );
  assert.equal(runs[1].attempt, 1, 'the unblock run ran beside attempt 1');
  assert.equal(runs[1].outcome, 'done');
  assert.equal(runs[2].attempt, 2, 'the run after it is the second attempt: the unblock run used none');
  assert.equal(t.attempts, 2);
  assert.equal(t.max_attempts, 3, 'the retry did not change the attempts allowed');
  assert.equal(db.slotsUsed(), 0);

  const retry = db.eventsForTask(task.id).find((e) => e.type === 'unblock_retry')!;
  assert.equal(retry.reason, `${UNBLOCK_NOTE}use sqlite, as the README says (FAKE_UNBLOCKED)`);
  assert.equal(describeEvent(retry), 'unblock run: retried with a note');
  assert.equal(db.eventsForTask(task.id).filter((e) => e.type === 'unblock_retry').length, 1, 'one unblock run');

  // The unblock run ran with its own prompt and turns, under the worker's settings; the next work run got the note.
  const unblockArgs = fakeArgs().find((a) => a[a.indexOf('-p') + 1].startsWith(`AgentDeck unblock run for task #${task.id}`))!;
  assert.equal(unblockArgs[unblockArgs.indexOf('--max-turns') + 1], '30');
  assert.match(unblockArgs[unblockArgs.indexOf('--append-system-prompt') + 1], /AgentDeck unblock run/);
  const settings = JSON.parse(readFileSync(unblockArgs[unblockArgs.indexOf('--settings') + 1], 'utf8'));
  assert.equal(settings.sandbox.enabled, true);
  assert.ok(
    settings.permissions.allow.some((r: string) => r.includes(`task-${task.id}`)),
    'file rules cover only the worktree',
  );
  const workPrompts = fakeArgs()
    .map((a) => a[a.indexOf('-p') + 1])
    .filter((p) => p.includes('FAKE_BLOCKED add storage') && !p.startsWith('AgentDeck'));
  assert.ok(workPrompts.at(-1)!.startsWith(`${UNBLOCK_NOTE}use sqlite`), 'the note goes first in the next prompt');
});

test('the unblock run itself uses no attempt', async () => {
  const repo = makeRepo(false);
  const task = db.addTask({ repo_id: repo.id, title: 'stuck', prompt: 'FAKE_BLOCKED nothing here', max_attempts: 3 });
  await drain();
  const before = db.getTask(task.id)!;
  assert.equal(before.status, 'blocked');
  assert.equal(db.runsForTask(task.id).length, 1, 'auto_unblock off: no unblock run');
  assert.equal(nextUnblockable(db)?.id, undefined);

  updateRepo(db, repo.name, { auto_unblock: true });
  assert.equal(nextUnblockable(db)?.id, task.id);
  assert.deepEqual(await runUnblock(db, before), {
    outcome: 'retried',
    reason: `${UNBLOCK_NOTE}use sqlite, as the README says (FAKE_UNBLOCKED)`,
  });
  const afterRun = db.getTask(task.id)!;
  assert.equal(afterRun.status, 'queued');
  assert.equal(afterRun.attempts, before.attempts);
  assert.equal(afterRun.max_attempts, before.max_attempts);
  assert.ok(db.applyEvent(task.id, { type: 'cancel' }));
});

test('a task with no attempts left gets a question, not a retry', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'last try', prompt: 'FAKE_BLOCKED one shot', max_attempts: 1 });
  await drain();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'blocked');
  assert.equal(t.attempts, 1);
  assert.deepEqual(
    db.runsForTask(task.id).map((r) => [r.kind, r.outcome]),
    [
      ['work', 'blocked'],
      ['unblock', 'blocked'],
    ],
  );
  const q = readQuestion(t.question)!;
  assert.match(q.question, /no attempts left/);
  assert.ok(q.question.includes('use sqlite'), 'it asks whether to retry with the note');
  const ask = db.eventsForTask(task.id).find((e) => e.type === 'unblock_ask')!;
  assert.equal(ask.reason, q.question);
  assert.equal(describeEvent(ask), 'unblock run: asked a question');
  assert.equal(
    db.eventsForTask(task.id).some((e) => e.type === 'unblock_retry'),
    false,
  );

  await drain();
  assert.equal(db.runsForTask(task.id).length, 2, 'once per block: no second unblock run');
});

test('an unblock run that asks leaves the question and its options; a retry clears them', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'ask', prompt: 'FAKE_BLOCKED FAKE_UNBLOCK_ASK', max_attempts: 3 });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'blocked');
  assert.equal(t.attempts, 1);
  assert.deepEqual(readQuestion(t.question), { question: 'Which database should it use?', options: ['sqlite', 'postgres'] });

  assert.equal(db.applyEvent(task.id, { type: 'retry' })?.question, null);
  assert.ok(db.applyEvent(task.id, { type: 'cancel' }));
});

test('an unblock run with a malformed ending asks with its last line', async () => {
  const repo = makeRepo(true);
  const task = db.addTask({ repo_id: repo.id, title: 'garbled', prompt: 'FAKE_BLOCKED FAKE_UNBLOCK_GARBAGE', max_attempts: 3 });
  await drain();
  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'blocked');
  assert.deepEqual(readQuestion(t.question), { question: 'Not sure what to make of it.', options: [] });
});
