import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-restart-'));

const { ActionError, gracefulRestart } = await import('#application/actions.ts');
const { releaseRestartPause } = await import('#application/operations/restart.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { RESTART_PAUSE_FRESH_MS } = await import('#domain/operations/restart.ts');
const { doneTask } = await import('#test/fixtures/fixtures.ts');
const { logsOptions, restartOptions, serviceAction } = await import('#cli/operations/daemon-args.ts');
const { parseCommandLine } = await import('#cli/context.ts');
const { RELOAD_QUIET_MS, reloadDecision, restartWait } = await import('#domain/operations/restart.ts');
const { openDb } = await import('#test/fixtures/open-db.ts');

const flagsOf = (...argv: string[]) => parseCommandLine(argv).values;

test('restartWait says what is active', () => {
  assert.equal(restartWait({ tasks: 0, planner: 0, resolves: 0 }), null);
  assert.equal(restartWait({ tasks: 1, planner: 0, resolves: 0 }), '1 running task');
  assert.equal(restartWait({ tasks: 2, planner: 1, resolves: 0 }), '2 running tasks and 1 planner run');
});

const idle = { tasks: 0, planner: 0, resolves: 0 };
const base = { enabled: true, changed: ['a.ts'], lastChangeAt: 0, now: RELOAD_QUIET_MS + 1, activity: idle };

test('reload: nothing happens when off or when nothing changed', () => {
  assert.deepEqual(reloadDecision({ ...base, enabled: false }), { pending: false, exit: false, reason: '' });
  assert.equal(reloadDecision({ ...base, changed: [] }).pending, false);
});

test('reload: waits for running work, and for edits to settle, then exits', () => {
  const busy = reloadDecision({ ...base, activity: { ...idle, tasks: 1 } });
  assert.deepEqual([busy.pending, busy.exit], [true, false]);
  assert.match(busy.reason, /1 running task/);
  assert.equal(reloadDecision({ ...base, activity: { ...idle, planner: 1 } }).exit, false);
  const resolving = reloadDecision({ ...base, activity: { ...idle, resolves: 1 } });
  assert.match(resolving.reason, /1 resolve run/);
  assert.doesNotMatch(resolving.reason, /running task/);
  const fresh = reloadDecision({ ...base, now: 10 });
  assert.deepEqual([fresh.pending, fresh.exit], [true, false]);
  const ready = reloadDecision(base);
  assert.deepEqual([ready.pending, ready.exit], [true, true]);
  assert.match(ready.reason, /a\.ts/);
  assert.match(reloadDecision({ ...base, changed: ['a.ts', 'b.ts', 'c.ts'] }).reason, /c\.ts and 2 more/);
});

test('service, logs and restart arguments', () => {
  assert.equal(serviceAction([]), 'status');
  assert.equal(serviceAction(['start']), 'start');
  assert.equal(serviceAction(['stop']), 'stop');
  assert.throws(() => serviceAction(['bounce']), ActionError);
  assert.throws(() => serviceAction(['stop', 'now']), ActionError);

  assert.deepEqual(logsOptions(flagsOf('logs'), []), { lines: 50, follow: false });
  assert.deepEqual(logsOptions(flagsOf('logs', '-f', '-n', '200'), []), { lines: 200, follow: true });
  assert.throws(() => logsOptions(flagsOf('logs', '-n', 'many'), []), ActionError);
  assert.throws(() => logsOptions(flagsOf('logs'), ['extra']), ActionError);

  assert.deepEqual(restartOptions(flagsOf('restart'), []), { graceful: true });
  assert.deepEqual(restartOptions(flagsOf('restart', '--now'), []), { graceful: false });
  assert.throws(() => restartOptions(flagsOf('restart'), ['now']), ActionError);
});

test('graceful restart pauses, waits for the runs, restarts and restores the pause state', async () => {
  const db = openDb(':memory:');
  db.setSetting('paused', '0');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const planner = db.startPlannerRun(repo.id, '/tmp/log');
  const events: string[] = [];
  let polls = 0;
  await gracefulRestart(db, {
    restart: async () => void events.push(`restart paused=${db.isPaused()}`),
    log: (m) => events.push(m),
    pollMs: 0,
    sleep: async () => {
      if (++polls === 2) db.finishPlannerRun(planner, 'nothing', 0, null);
    },
  });
  assert.match(events[0], /waiting for 1 planner run/);
  assert.equal(events.at(-1), 'restart paused=true');
  assert.equal(db.isPaused(), false);
  db.close();
});

test('graceful restart restores the pause state when the restart fails', async () => {
  const db = openDb(':memory:');
  db.setSetting('paused', '1');
  await assert.rejects(
    gracefulRestart(db, {
      restart: async () => {
        throw new Error('launchctl failed');
      },
      log: () => {},
    }),
    /launchctl failed/,
  );
  assert.equal(db.isPaused(), true);
  db.close();
});

test('a second restart is refused while the first still waits, and both leave the daemon as it was', async () => {
  const db = openDb(':memory:');
  db.setSetting('paused', '0');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const planner = db.startPlannerRun(repo.id, '/tmp/log');
  let second: Promise<unknown> | undefined;
  await gracefulRestart(db, {
    restart: async () => {},
    log: () => {},
    pollMs: 0,
    sleep: async () => {
      second ??= gracefulRestart(db, { restart: async () => assert.fail('the second restart ran'), log: () => {}, pollMs: 0 });
      db.finishPlannerRun(planner, 'nothing', 0, null);
    },
  });
  await assert.rejects(
    second ?? Promise.resolve(),
    (err) => err instanceof ActionError && /another `agentdeck restart` is waiting/.test(err.message),
  );
  assert.equal(db.isPaused(), false, 'the pause the first restart took is given back');
  assert.equal(db.restartPauseAt(), null);
  db.close();
});

test('a restart that was cut off leaves a pause the next restart does not take for a person’s', async () => {
  const db = openDb(':memory:');
  db.setPaused(true);
  db.setRestartPauseAt(Date.now() - RESTART_PAUSE_FRESH_MS - 1);
  await gracefulRestart(db, { restart: async () => {}, log: () => {}, pollMs: 0, sleep: async () => {} });
  assert.equal(db.isPaused(), false);
  assert.equal(db.restartPauseAt(), null);
  db.close();
});

test('a daemon that starts lifts the pause of a restart that was cut off, and no other', () => {
  const db = openDb(':memory:');
  const now = Date.now();
  db.setPaused(true);
  assert.equal(releaseRestartPause(db, now), false, 'a person’s pause stays');
  assert.equal(db.isPaused(), true);
  db.setRestartPauseAt(now - 1000);
  assert.equal(releaseRestartPause(db, now), false, 'that restart is still waiting, and gives the pause back itself');
  assert.equal(db.isPaused(), true);
  db.setRestartPauseAt(now - RESTART_PAUSE_FRESH_MS);
  assert.equal(releaseRestartPause(db, now), true);
  assert.equal(db.isPaused(), false);
  assert.equal(db.restartPauseAt(), null);
  db.close();
});

test('a scheduler that stops clears the marks of the syncs it cuts off', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const task = doneTask(db, repo, { pr: 'open' });
  db.setSyncing(task.id, true);
  db.processes = { ...db.processes, keepAwake: () => ({ set: () => {} }), stopAll: () => {} };
  new Scheduler(db, { log: () => {} }).stop();
  assert.equal(db.hasSyncMarker(task.id), false);
  db.close();
});

test('a requested restart exits once nothing is running, and waits otherwise', () => {
  const asked = { ...base, enabled: false, changed: [], requested: true };
  const busy = reloadDecision({ ...asked, activity: { ...idle, tasks: 1 } });
  assert.deepEqual([busy.pending, busy.exit], [true, false]);
  assert.match(busy.reason, /restart requested.*1 running task/);
  const ready = reloadDecision(asked);
  assert.deepEqual([ready.pending, ready.exit], [true, true]);
});

test('a blocked reload neither exits nor holds back new work, unless a restart was requested', () => {
  const change = { ...base, changed: ['db/schema.ts'], blocked: 'db/schema.ts has uncommitted changes' };
  const idleBlocked = reloadDecision(change);
  assert.deepEqual([idleBlocked.pending, idleBlocked.exit], [false, false]);
  assert.match(idleBlocked.reason, /not reloading: db\/schema.ts has uncommitted changes/);
  const asked = reloadDecision({ ...change, requested: true });
  assert.deepEqual([asked.pending, asked.exit], [true, true]);
});
