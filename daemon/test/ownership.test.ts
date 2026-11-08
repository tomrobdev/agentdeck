import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-ownership-'));

const { ActionError, retryTask } = await import('../src/application/actions.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { callDaemon } = await import('../src/cli/daemon-client.ts');
const { RELOAD_QUIET_MS, reloadDecision, restartWait } = await import('../src/domain/operations/restart.ts');
const { openDb } = await import('./open-db.ts');

const base = { enabled: true, changed: ['a.ts'], lastChangeAt: 0, now: RELOAD_QUIET_MS + 1 };

function reloading() {
  const db = openDb(':memory:');
  let exited = 0;
  const scheduler = new Scheduler(db, {
    tickMs: 60_000,
    prRefreshMs: Number.MAX_SAFE_INTEGER,
    autoPropose: false,
    log: () => {},
    reload: { check: (busy) => reloadDecision({ ...base, activity: busy }), exit: () => void exited++ },
  });
  return { db, scheduler, exited: () => exited };
}

const tick = () => new Promise((r) => setImmediate(r));

for (const kind of ['sync', 'propose'] as const) {
  test(`a tracked ${kind} keeps the reload from exiting until it settles`, async () => {
    const { scheduler, exited } = reloading();
    let finish!: () => void;
    const p = scheduler.track(new Promise<void>((r) => (finish = r)), kind);
    scheduler.wake();
    assert.equal(exited(), 0);
    finish();
    await p;
    await tick();
    assert.equal(exited(), 1);
  });
}

test('a tracked run that fails still lets the reload go ahead', async () => {
  const { scheduler, exited } = reloading();
  const p = scheduler.track(Promise.reject(new Error('boom')), 'sync');
  await assert.rejects(p, /boom/);
  await tick();
  assert.equal(exited(), 1);
});

test('restartWait names a running resolve, which the db counts from its run row', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  assert.equal(restartWait({ tasks: 0, planner: 0, resolves: db.countRunningResolves() }), null);
  const run = db.startRun(task.id, 0, '/tmp/log', 'resolve');
  assert.equal(restartWait({ tasks: 0, planner: 0, resolves: db.countRunningResolves() }), '1 resolve run');
  assert.equal(restartWait({ tasks: 1, planner: 1, resolves: 2 }), '1 running task and 2 resolve runs and 1 planner run');
  db.finishRun(run, { outcome: 'done' });
  assert.equal(db.countRunningResolves(), 0);
});

test('retryTask refuses while an unfinished resolve run is in the db', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  const run = db.startRun(task.id, 0, '/tmp/log', 'resolve');
  assert.throws(() => retryTask(db, task.id), ActionError);
  db.finishRun(run, { outcome: 'done' });
  assert.throws(
    () => retryTask(db, task.id),
    (err) => err instanceof ActionError && /is \w+$/.test(err.message),
  );
});

test('callDaemon against a stopped port dies saying the daemon is not running', async () => {
  const realExit = process.exit;
  const realError = console.error;
  const printed: string[] = [];
  console.error = (m: string) => void printed.push(m);
  try {
    // Port 1 is never listening; the refusal comes back as an error event, whose handler dies.
    const outcome = await new Promise<string>((resolve) => {
      process.exit = ((code?: number) => resolve(`exit ${code}`)) as never;
      callDaemon('POST', '/api/tasks/1/sync', {}, 1).then(() => resolve('answered'));
    });
    assert.equal(outcome, 'exit 1');
    assert.match(printed.join('\n'), /the daemon is not running; start it with `agentdeck service start`/);
  } finally {
    process.exit = realExit;
    console.error = realError;
  }
});
