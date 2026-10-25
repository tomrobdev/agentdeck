import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-restart-'));

const { ActionError } = await import('../src/application/errors.ts');
const { gracefulRestart } = await import('../src/application/restart.ts');
const { logsOptions, restartOptions, serviceAction } = await import('../src/cli/daemon-args.ts');
const { parseCommandLine } = await import('../src/cli/context.ts');
const { RELOAD_QUIET_MS, reloadDecision, restartWait } = await import('../src/domain/daemon/restart.ts');
const { openDb } = await import('../src/db/index.ts');

const flagsOf = (...argv: string[]) => parseCommandLine(argv).values;

test('restartWait says what is active', () => {
  assert.equal(restartWait({ tasks: 0, planner: 0 }), null);
  assert.equal(restartWait({ tasks: 1, planner: 0 }), '1 running task');
  assert.equal(restartWait({ tasks: 2, planner: 1 }), '2 running tasks and 1 planner run');
});

const base = { enabled: true, changed: ['a.ts'], lastChangeAt: 0, now: RELOAD_QUIET_MS + 1, tasks: 0, proposing: false };

test('reload: nothing happens when off or when nothing changed', () => {
  assert.deepEqual(reloadDecision({ ...base, enabled: false }), { pending: false, exit: false, reason: '' });
  assert.equal(reloadDecision({ ...base, changed: [] }).pending, false);
});

test('reload: waits for running work, and for edits to settle, then exits', () => {
  const busy = reloadDecision({ ...base, tasks: 1 });
  assert.deepEqual([busy.pending, busy.exit], [true, false]);
  assert.match(busy.reason, /1 running task/);
  assert.equal(reloadDecision({ ...base, proposing: true }).exit, false);
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
      if (++polls === 2) db.finishPlannerRun(planner, 'ok', 0, null);
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

test('a requested restart exits once nothing is running, and waits otherwise', () => {
  const asked = { ...base, enabled: false, changed: [], requested: true };
  const busy = reloadDecision({ ...asked, tasks: 1 });
  assert.deepEqual([busy.pending, busy.exit], [true, false]);
  assert.match(busy.reason, /restart requested.*1 running task/);
  const ready = reloadDecision(asked);
  assert.deepEqual([ready.pending, ready.exit], [true, true]);
});
