import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-escalate-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../../../src/db/index.ts');
const { Scheduler } = await import('../../../src/application/scheduler/scheduler.ts');
const { addTask, retryTask, updateRepo } = await import('../../../src/application/actions.ts');
const { escalation, escalationReason, escalationSince, hardFailure, strongerModel } = await import('../../../src/domain/runs/escalate.ts');
const { TESTS_FAILED, TURN_LIMIT, NO_CHANGE } = await import('../../../src/domain/runs/run-result.ts');
const { repoSettingPatch } = await import('../../../src/cli/operations/settings-args.ts');
const { taskCommands } = await import('../../../src/cli/work/tasks.ts');
const { testApp } = await import('../../fixtures/fixtures.ts');
const { fakeCodeHost } = await import('../../fixtures/fakes.ts');

const end = (fields: Partial<Parameters<typeof hardFailure>[0]> = {}) => ({
  outcome: 'failed' as const,
  reason: null,
  needs: null,
  denials: 0,
  turns: 3,
  ...fields,
});

test('a model goes one step up the ladder, by its alias or its family, and the strongest goes nowhere', () => {
  assert.equal(strongerModel('haiku'), 'sonnet');
  assert.equal(strongerModel('sonnet'), 'opus');
  assert.equal(strongerModel('claude-haiku-5-5'), 'sonnet');
  assert.equal(strongerModel('claude-sonnet-5-5'), 'opus');
  assert.equal(strongerModel('opus'), null);
  assert.equal(strongerModel('claude-opus-5-5'), null);
  assert.equal(strongerModel('fable'), null, 'a model off the ladder stays');
});

test('a hard failure is the turn limit, failing tests, an error, no result after work, or no change', () => {
  assert.equal(hardFailure(end({ reason: TURN_LIMIT })), 'turn_limit');
  assert.equal(hardFailure(end({ reason: TESTS_FAILED })), 'tests_failed');
  assert.equal(hardFailure(end({ reason: TESTS_FAILED, denials: 2 })), 'tests_failed', 'refused tool uses did not stop the run');
  assert.equal(hardFailure(end({ reason: 'error_during_execution' })), 'error');
  assert.equal(hardFailure(end({ reason: 'claude ended without a result' })), 'no_result');
  assert.equal(hardFailure(end({ reason: 'claude exited with code 1: boom' })), 'no_result');
  assert.equal(hardFailure(end({ outcome: 'blocked', reason: NO_CHANGE })), 'no_change');
});

test('what a stronger model would not fix is no hard failure', () => {
  assert.equal(hardFailure(end({ outcome: 'done' })), null);
  assert.equal(hardFailure(end({ outcome: 'cancelled', reason: TURN_LIMIT })), null);
  assert.equal(hardFailure(end({ outcome: null, reason: TURN_LIMIT })), null);
  assert.equal(hardFailure(end({ reason: 'claude exited with code 1', turns: 0 })), null, 'claude stopped before its first turn');
  assert.equal(hardFailure(end({ reason: TURN_LIMIT, denials: 1 })), null, 'refused tool uses blame the environment');
  assert.equal(hardFailure(end({ reason: TURN_LIMIT, needs: { kind: 'deps', items: ['left-pad'] } })), null);
  assert.equal(hardFailure(end({ reason: 'setup failed: exit 1' })), null);
  assert.equal(hardFailure(end({ outcome: 'blocked', reason: 'the plan contradicts the goal' })), null, 'the person answers it');
  assert.equal(hardFailure(end({ reason: 'something else' })), null);
  assert.equal(hardFailure(end({ reason: null })), null);
});

test('an escalation needs escalate on, a run on the task’s model as it is, a hard failure and a stronger model', () => {
  const failed = end({ reason: TURN_LIMIT });
  const on = { escalate: true };
  assert.deepEqual(escalation({ model: 'sonnet' }, { model: 'sonnet' }, failed, on), { from: 'sonnet', to: 'opus', cause: 'turn_limit' });
  assert.equal(escalation({ model: 'sonnet' }, { model: 'sonnet' }, failed, { escalate: false }), null);
  assert.equal(escalation({ model: 'opus' }, { model: 'sonnet' }, failed, on), null, 'a model changed since wins');
  assert.equal(escalation({ model: 'opus' }, { model: 'opus' }, failed, on), null, 'nothing above opus');
  assert.equal(escalation({ model: 'haiku' }, { model: 'haiku' }, end({ outcome: 'done' }), on), null);
});

test('the reason says the move and the cause, with the run’s summary when there is one', () => {
  const e = { from: 'sonnet', to: 'opus', cause: 'turn_limit' as const };
  assert.equal(escalationReason(e, null), 'runs on opus, up from sonnet, after the turn limit');
  assert.equal(
    escalationReason({ ...e, cause: 'no_change' }, 'used 60 of 60 turns'),
    'runs on opus, up from sonnet, after a run that changed nothing (the last run used 60 of 60 turns)',
  );
});

test('the escalation for a run is the one made since the last work run that ended', () => {
  const runs = [
    { kind: 'work' as const, outcome: 'failed' as const, started_at: '2026-11-08 10:00:00' },
    { kind: 'resolve' as const, outcome: 'done' as const, started_at: '2026-11-08 11:00:00' },
    { kind: 'work' as const, outcome: 'rate_limited' as const, started_at: '2026-11-08 12:00:00' },
  ];
  const events = [
    { type: 'escalate', reason: 'runs on sonnet, up from haiku, after an error', at: '2026-11-08 09:00:00' },
    { type: 'escalate', reason: 'runs on opus, up from sonnet, after the turn limit', at: '2026-11-08 10:00:00' },
    { type: 'retry', reason: null, at: '2026-11-08 10:30:00' },
  ];
  assert.equal(escalationSince(events, runs), 'runs on opus, up from sonnet, after the turn limit');
  assert.equal(escalationSince(events.slice(0, 1), runs), null, 'an older one is for an earlier run');
  assert.equal(escalationSince(events, []), null, 'a first run has none');
});

const db = testApp(openDb(join(home, 'agentdeck.db')), { codeHost: fakeCodeHost() });
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
sh(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
db.addRepo({ name: 'demo', path: dir, base_branch: 'main' });

const started = (marker: string) =>
  readFileSync(join(home, 'fake-claude-args.log'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as string[])
    .filter((args) => args[args.indexOf('-p') + 1].includes(marker))
    .map((args) => ({ model: args[args.indexOf('--model') + 1], prompt: args[args.indexOf('-p') + 1] }));

const escalations = (id: Parameters<typeof db.eventsForTask>[0]) => db.eventsForTask(id).filter((e) => e.type === 'escalate');

test('a failed run at the turn limit requeues one model up, and the next run is told why', async () => {
  const task = await addTask(db, { repo: 'demo', prompt: 'FAKE_MAX_TURNS climb', model: 'haiku', max_attempts: 2 });
  await drain();
  const runs = started('FAKE_MAX_TURNS climb');
  assert.deepEqual(
    runs.map((r) => r.model),
    ['haiku', 'sonnet'],
  );
  assert.match(runs[1].prompt, /This attempt runs on sonnet, up from haiku, after the turn limit/);
  assert.equal(db.getTask(task.id)!.status, 'failed');
  assert.equal(db.getTask(task.id)!.model, 'sonnet', 'the last attempt used up the attempts, so nothing moves again');
  assert.equal(escalations(task.id).length, 1);
});

test('a sonnet task at the turn limit runs its second attempt on opus; an environment block’s retry stays sonnet', async () => {
  const task = await addTask(db, { repo: 'demo', prompt: 'FAKE_MAX_TURNS to opus', model: 'sonnet', max_attempts: 2 });
  await drain();
  assert.deepEqual(
    started('FAKE_MAX_TURNS to opus').map((r) => r.model),
    ['sonnet', 'opus'],
  );
  assert.equal(escalations(task.id).length, 1, 'opus stays opus after the second failure');

  const blocked = await addTask(db, { repo: 'demo', prompt: 'FAKE_DENIED_NEEDS sandboxed', model: 'sonnet', max_attempts: 2 });
  await drain();
  assert.equal(db.getTask(blocked.id)!.status, 'blocked');
  assert.deepEqual(retryTask(db, blocked.id), { model: 'sonnet', escalated: false });
  await drain();
  assert.deepEqual(
    started('FAKE_DENIED_NEEDS sandboxed').map((r) => r.model),
    ['sonnet', 'sonnet'],
  );
  assert.equal(escalations(blocked.id).length, 0);
});

test('a person’s retry without a model escalates; one that names a model runs on it; escalate off keeps the model', async () => {
  const task = await addTask(db, { repo: 'demo', prompt: 'FAKE_MAX_TURNS retry me', model: 'sonnet', max_attempts: 1 });
  await drain();
  assert.equal(db.getTask(task.id)!.status, 'failed');
  assert.equal(db.getTask(task.id)!.model, 'sonnet', 'no attempt left, so the worker does not move it');

  assert.throws(() => retryTask(db, task.id, { model: 'gpt-9' }), /model must be/);
  assert.throws(() => retryTask(db, task.id, { model: '' }), /model must not be empty/);
  assert.throws(() => retryTask(db, task.id, { model: 5 as never }), /model must be text/);
  assert.throws(() => retryTask(db, task.id, { note: 5 as never }), /note must be text/);
  assert.throws(() => retryTask(db, task.id, {}, ['done']), /is failed/);

  assert.deepEqual(retryTask(db, task.id), { model: 'opus', escalated: true });
  assert.equal(escalations(task.id).length, 1);
  db.raw.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(task.id);

  assert.deepEqual(retryTask(db, task.id, { model: 'haiku' }), { model: 'haiku', escalated: false });
  assert.equal(escalations(task.id).length, 1, 'a retry that names a model is never escalated');
  assert.ok(db.eventsForTask(task.id).some((e) => e.type === 'edit' && e.reason === 'model'));
  db.raw.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(task.id);

  assert.deepEqual(retryTask(db, task.id), { model: 'haiku', escalated: false });
  db.raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(task.id);

  updateRepo(db, 'demo', { escalate: false });
  assert.equal(db.findRepo('demo')!.escalate, false);
  const kept = await addTask(db, { repo: 'demo', prompt: 'FAKE_MAX_TURNS stay', model: 'haiku', max_attempts: 2 });
  await drain();
  assert.deepEqual(
    started('FAKE_MAX_TURNS stay').map((r) => r.model),
    ['haiku', 'haiku'],
  );
  assert.equal(escalations(kept.id).length, 0);
  updateRepo(db, 'demo', { escalate: true });
});

test('a retry escalates without the run log, worded without a summary; a failed task with no work run keeps its model', async () => {
  const task = await addTask(db, { repo: 'demo', prompt: 'FAKE_MAX_TURNS log gone', model: 'haiku', max_attempts: 1 });
  await drain();
  const run = db.runsForTask(task.id).findLast((r) => r.kind === 'work')!;
  rmSync(run.log_path, { force: true });
  assert.deepEqual(retryTask(db, task.id), { model: 'sonnet', escalated: true });
  assert.match(escalations(task.id)[0].reason ?? '', /up from haiku/);
  db.raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(task.id);

  const never = await addTask(db, { repo: 'demo', prompt: 'never ran', model: 'haiku' });
  db.raw.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(never.id);
  assert.deepEqual(retryTask(db, never.id), { model: 'haiku', escalated: false });
  assert.equal(escalations(never.id).length, 0);
  db.raw.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(never.id);
});

test('agentdeck retry says when it moved the model up, and repo set takes escalate', async () => {
  assert.deepEqual(repoSettingPatch('escalate', 'off'), { escalate: false });
  assert.deepEqual(repoSettingPatch('escalate', 'on'), { escalate: true });

  const task = await addTask(db, { repo: 'demo', prompt: 'FAKE_MAX_TURNS from the cli', model: 'haiku', max_attempts: 1 });
  await drain();
  const out: string[] = [];
  const { log } = console;
  console.log = (m: unknown) => void out.push(String(m));
  try {
    const ctx = (flags: Record<string, unknown>) => ({ db, cmd: 'retry', rest: [String(task.id)], flags, repoName: () => 'demo' }) as never;
    await taskCommands.retry(ctx({}));
    db.raw.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(task.id);
    await taskCommands.retry(ctx({ model: 'opus' }));
  } finally {
    console.log = log;
  }
  assert.deepEqual(out, [`requeued #${task.id}, one model up: sonnet`, `requeued #${task.id}`]);
  assert.equal(db.getTask(task.id)!.model, 'opus');
});
