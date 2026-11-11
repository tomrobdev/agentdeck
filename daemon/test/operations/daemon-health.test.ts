import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RunningTaskFact } from '#domain/operations/health.ts';
import { type TaskId, asTaskId } from '#domain/shared/id.ts';

type LooseTaskFact = Omit<RunningTaskFact, 'id'> & { id: number };
const withTaskId = (f: LooseTaskFact): RunningTaskFact => ({ ...f, id: asTaskId(f.id) });

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-health-'));

const h = await import('#domain/operations/health.ts');
const { SCHEMA_DIRTY, offMain, reloadState } = await import('#domain/operations/restart.ts');
const { daemonReport, gatherHealth, restartNow } = await import('#application/operations/doctor.ts');
const { openDb } = await import('#test/fixtures/open-db.ts');
const { waitFor } = await import('#test/fixtures/fixtures.ts');

const NOW = Date.parse('2026-11-01T12:00:00Z');
const running = { installed: true, loaded: true, pid: 100, state: 'running' };
const idleReload = { enabled: true, pending: false, reason: null, waiting: null, blocked: null, changed: 0 };
const state = (over: Partial<import('#domain/operations/health.ts').DaemonState> = {}) => ({
  commit: 'a'.repeat(40),
  started_at: '2026-11-01T09:00:00Z',
  pid: 100,
  reload: idleReload,
  ...over,
});
const facts = (over: Partial<import('#domain/operations/health.ts').HealthFacts> = {}) => ({
  now: NOW,
  service: running,
  port: 4317,
  api: state(),
  head: 'a'.repeat(40),
  behind: null,
  checkout: '/repo',
  processes: [],
  tasks: [],
  log: { problems: [], lastStop: null },
  gh: { ok: true, output: 'Logged in' },
  reviews: [],
  ...over,
});

test('a healthy daemon passes every check and has nothing to fix', () => {
  const checks = h.judgeHealth(facts());
  assert.equal(checks.length, 9);
  assert.ok(
    checks.every((c) => c.ok && c.fix === null),
    JSON.stringify(checks),
  );
});

test('service: not installed, not loaded, loaded but not running', () => {
  const s = (over: object) => h.checkService({ ...running, ...over });
  assert.deepEqual([s({ installed: false, loaded: false }).ok, s({ installed: false, loaded: false }).fix], [false, 'agentdeck install']);
  assert.equal(s({ loaded: false, pid: null, state: null }).fix, 'agentdeck service start');
  assert.match(s({ loaded: false, pid: null, state: null }).reason, /stopped/);
  const waiting = s({ state: 'spawn scheduled', pid: null });
  assert.equal(waiting.ok, false);
  assert.equal(waiting.fix, 'agentdeck restart --now');
  assert.match(s({}).reason, /running, pid 100/);
});

test('api: unreachable, a foreign daemon on the port, and answering with its uptime', () => {
  const down = h.checkApi(facts({ api: null }));
  assert.equal(down.ok, false);
  assert.match(down.reason, /127\.0\.0\.1:4317/);
  assert.equal(down.fix, 'agentdeck restart --now');
  assert.equal(
    h.checkApi(facts({ api: null, service: { ...running, loaded: false, pid: null, state: null } })).fix,
    'agentdeck service start',
  );
  const foreign = h.checkApi(facts({ api: state({ pid: 555 }) }));
  assert.equal(foreign.ok, false);
  assert.equal(foreign.fix, 'kill 555');
  const up = h.checkApi(facts());
  assert.equal(up.ok, true);
  assert.match(up.reason, /pid 100, up 3h 0m/);
});

test('uptime is worded in the largest units', () => {
  assert.deepEqual([5_000, 125_000, 3 * 3600_000 + 60_000, 50 * 3600_000].map(h.uptime), ['5s', '2m', '3h 1m', '2d 2h']);
});

test('code: same commit passes; a different one names both and how far behind, and fixes with a restart', () => {
  assert.equal(h.checkCode(facts()).ok, true);
  const behind = h.checkCode(facts({ head: 'b'.repeat(40), behind: 3 }));
  assert.equal(behind.ok, false);
  assert.match(behind.reason, /loaded aaaaaaa; the checkout is at bbbbbbb, 3 commits ahead/);
  assert.equal(behind.fix, 'agentdeck restart');
  assert.equal(h.checkCode(facts({ api: state({ commit: null }) })).ok, true);
  assert.equal(h.checkCode(facts({ head: null })).ok, true);
});

test('reload: idle and pending pass; blocked fails with the way out', () => {
  assert.match(h.checkReload(facts()).reason, /none pending/);
  assert.match(h.checkReload(facts({ api: state({ reload: { ...idleReload, enabled: false } }) })).reason, /reload_on_change is off/);
  const pending = h.checkReload(
    facts({ api: state({ reload: { ...idleReload, pending: true, waiting: '2 running tasks', changed: 3 } }) }),
  );
  assert.equal(pending.ok, true);
  assert.match(pending.reason, /waiting for 2 running tasks/);
  const dirty = h.checkReload(facts({ api: state({ reload: { ...idleReload, blocked: SCHEMA_DIRTY, changed: 1 } }) }));
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /db\/schema\.ts has uncommitted changes/);
  assert.match(dirty.fix!, /^git -C \/repo diff daemon\/src\/db\/schema\.ts/);
  const off = h.checkReload(facts({ api: state({ reload: { ...idleReload, blocked: offMain('feature'), changed: 1 } }) }));
  assert.equal(off.fix, 'git -C /repo switch main');
});

test('checks that need the daemon fail as not run when it is down, with the fix for the daemon', () => {
  const f = facts({ api: null, service: { ...running, loaded: false, pid: null, state: null } });
  for (const c of [h.checkCode(f), h.checkReload(f)]) {
    assert.equal(c.ok, false);
    assert.match(c.reason, /^not run/);
    assert.equal(c.fix, 'agentdeck service start');
  }
});

test('processes: a group that outlived its run is a stray; one of a running run is not, unless the daemon is gone', () => {
  const ended = { kind: 'work' as const, run: 7, pid: 321, ended: true };
  const live = { kind: 'planner' as const, run: 2, pid: 654, ended: false };
  assert.equal(h.checkProcesses({ api: state(), processes: [] }).ok, true);
  assert.equal(h.checkProcesses({ api: state(), processes: [live] }).ok, true);
  const stray = h.checkProcesses({ api: state(), processes: [ended, live] });
  assert.equal(stray.ok, false);
  assert.match(stray.reason, /1 claude process group still alive: run 7 \(pid 321, run ended\)/);
  assert.equal(stray.fix, 'kill -TERM -- -321');
  const gone = h.checkProcesses({ api: null, processes: [ended, live] });
  assert.match(gone.reason, /2 claude process groups/);
  assert.match(gone.reason, /planner run 2 \(pid 654, daemon gone\)/);
  assert.equal(gone.fix, 'kill -TERM -- -321 -654');
});

test('tasks, daemon up: its own runs are healthy in setup, sync and tests; one older than the daemon with no claude is dead', () => {
  const tasks = (...t: LooseTaskFact[]) => h.checkTasks({ now: NOW, api: state(), tasks: t.map(withTaskId) });
  const working = { id: 1, pid: 10, alive: true, runAgeSeconds: 500 };
  const inSetup = { id: 2, pid: null, alive: false, runAgeSeconds: 600 };
  const inTests = { id: 3, pid: 11, alive: false, runAgeSeconds: 900 };
  const claimed = { id: 4, pid: null, alive: false, runAgeSeconds: null };
  const healthy = tasks(working, inSetup, inTests, claimed);
  assert.equal(healthy.ok, true, healthy.reason);
  assert.match(healthy.reason, /4 tasks running, none left over from an earlier daemon/);
  const leftNoPid = { id: 5, pid: null, alive: false, runAgeSeconds: 4 * 3600 };
  const leftDead = { id: 6, pid: 12, alive: false, runAgeSeconds: 4 * 3600 };
  const dead = tasks(working, inTests, leftNoPid, leftDead);
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /2 tasks in running with no live claude process: #5, #6/);
  assert.equal(dead.fix, 'agentdeck restart --now');
  assert.equal(tasks({ id: 7, pid: 13, alive: true, runAgeSeconds: 4 * 3600 }).ok, true);
  assert.equal(tasks({ id: 8, pid: null, alive: false, runAgeSeconds: 3 * 3600 + 0.5 }).ok, true);
});

test('tasks, daemon down: a dead process or a pid overdue fails; a fresh run without a pid yet does not', () => {
  const tasks = (...t: LooseTaskFact[]) => h.checkTasks({ now: NOW, api: null, tasks: t.map(withTaskId) });
  const ok = { id: 1, pid: 10, alive: true, runAgeSeconds: 500 };
  assert.equal(tasks(ok).ok, true);
  assert.match(tasks(ok).reason, /1 task running, each with a live process/);
  assert.equal(tasks({ id: 2, pid: null, alive: false, runAgeSeconds: 5 }).ok, true);
  const dead = tasks(ok, { id: 3, pid: 11, alive: false, runAgeSeconds: 500 });
  assert.equal(dead.ok, false);
  assert.match(dead.reason, /1 task in running with no live claude process: #3/);
  assert.equal(dead.fix, 'agentdeck service start');
  assert.equal(tasks({ id: 4, pid: null, alive: false, runAgeSeconds: 600 }).ok, false);
  assert.equal(tasks({ id: 5, pid: null, alive: false, runAgeSeconds: null }).ok, false);
});

test('log: errors of the last 24 hours are found, with stacks folded in and older ones left out', () => {
  const lines = [
    'Error: from before any date',
    '[2026-10-30T10:00:00.000Z] task 1: worker crashed: Error: too old',
    '[2026-11-01T08:00:00.000Z] SIGTERM: stopping workers; their tasks will be requeued on next start',
    '[2026-11-01T09:00:00.000Z] task 2: worker crashed: Error: boom',
    '    at foo (file.ts:1:1)',
    '    at bar (file.ts:2:2)',
    '[2026-11-01T10:00:00.000Z] task 3: done',
    'TypeError: x is not a function',
    '    at baz (file.ts:3:3)',
    '[2026-11-01T11:00:00.000Z] task 4: failed (the tests: Error in output)',
  ];
  const facts = h.logFacts(lines, NOW);
  assert.deepEqual(
    facts.problems.map((p) => p.line),
    ['task 2: worker crashed: Error: boom', 'TypeError: x is not a function'],
  );
  assert.deepEqual(facts.lastStop, { at: Date.parse('2026-11-01T08:00:00.000Z'), signal: 'SIGTERM' });
});

test('log: verdict and fix', () => {
  assert.equal(h.checkLog({ now: NOW, log: null }).ok, true);
  const quiet = h.checkLog({ now: NOW, log: { problems: [], lastStop: { at: NOW - 3600_000, signal: 'SIGTERM' } } });
  assert.equal(quiet.ok, true);
  assert.match(quiet.reason, /no errors in the last 24 hours; last stopped by SIGTERM 1h 0m ago/);
  const bad = h.checkLog({ now: NOW, log: { problems: [{ at: NOW - 120_000, line: 'task 2: worker crashed: boom' }], lastStop: null } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /1 error in the last 24 hours, the latest 2m ago: task 2: worker crashed: boom/);
  assert.equal(bad.fix, 'agentdeck logs -n 200');
});

test('gh: logged in or not', () => {
  assert.equal(h.checkGh({ ok: true, output: 'Logged in as x' }).ok, true);
  const out = h.checkGh({ ok: false, output: 'You are not logged in' });
  assert.equal(out.ok, false);
  assert.equal(out.fix, 'gh auth login');
});

test('reloadState: pending with what it waits for, blocked only while a change waits', () => {
  const base = { enabled: true, changed: ['a.ts'], lastChangeAt: 0, now: 10_000, activity: { tasks: 2, planner: 0, resolves: 0 } };
  const waiting = reloadState(base);
  assert.deepEqual([waiting.pending, waiting.waiting, waiting.blocked, waiting.changed], [true, '2 running tasks', null, 1]);
  const blocked = reloadState({ ...base, blocked: SCHEMA_DIRTY });
  assert.deepEqual([blocked.pending, blocked.blocked], [false, SCHEMA_DIRTY]);
  assert.equal(reloadState({ ...base, blocked: SCHEMA_DIRTY, changed: [] }).blocked, null);
  assert.equal(reloadState({ ...base, blocked: SCHEMA_DIRTY, requested: true }).blocked, null);
  assert.equal(reloadState({ ...base, enabled: false, blocked: SCHEMA_DIRTY }).blocked, null);
  const idle = reloadState({ ...base, activity: { tasks: 0, planner: 0, resolves: 0 }, now: 100_000 });
  assert.deepEqual([idle.pending, idle.waiting], [true, null]);
});

test('gatherHealth reads runs and tasks from the database and their liveness from the probes', async () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const t = (title: string) => db.addTask({ repo_id: repo.id, title, prompt: 'p' });
  const finished = t('finished');
  const live = t('live');
  const dead = t('dead');
  const runOf = (task: TaskId, pid: number) => {
    const id = db.startRun(task, 1, '/tmp/log');
    db.setRunPid(id, pid);
    return id;
  };
  const endedRun = runOf(finished.id, 111);
  db.finishRun(endedRun, {});
  db.applyEvent(live.id, { type: 'claim' });
  runOf(live.id, 222);
  db.applyEvent(dead.id, { type: 'claim' });
  runOf(dead.id, 333);
  db.raw.prepare("UPDATE runs SET started_at = '2026-11-01 08:00:00'").run();
  const setup = t('in setup');
  db.applyEvent(setup.id, { type: 'claim' });
  const setupRun = db.startRun(setup.id, 1, '/tmp/log');
  const testing = t('in its tests');
  db.applyEvent(testing.id, { type: 'claim' });
  const testRun = runOf(testing.id, 444);
  const at = db.raw.prepare('UPDATE runs SET started_at = ? WHERE id = ?');
  at.run('2026-11-01 11:50:00', setupRun);
  at.run('2026-11-01 11:30:00', testRun);
  const alive = new Set([111, 222]);
  const asked: { pid: number; pid_at: string }[] = [];
  const facts = await gatherHealth(
    db,
    {
      service: async () => running,
      api: async () => state(),
      head: async () => 'b'.repeat(40),
      ahead: async () => 4,
      alive: (r) => {
        asked.push(r);
        return alive.has(r.pid);
      },
      logLines: () => ['[2026-11-01T11:59:00.000Z] task 9: worker crashed: Error: x'],
      gh: async () => ({ ok: true, output: 'ok' }),
      reviews: async () => [],
      now: () => NOW,
    },
    4317,
  );
  assert.equal(facts.behind, 4);
  assert.deepEqual(
    facts.processes.map((p) => [p.pid, p.ended]),
    [
      [111, true],
      [222, false],
    ],
  );
  assert.deepEqual(
    facts.tasks.map((x) => [x.id, x.pid, x.alive, x.runAgeSeconds]),
    [
      [live.id, 222, true, 4 * 3600],
      [dead.id, 333, false, 4 * 3600],
      [setup.id, null, false, 600],
      [testing.id, 444, false, 1800],
    ],
  );
  assert.ok(asked.length > 0);
  for (const r of asked) assert.notEqual(r.pid_at, '2026-11-01 08:00:00', JSON.stringify(r));
  assert.equal(facts.log?.problems.length, 1);
  const checks = h.judgeHealth(facts);
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['code loaded', 'claude processes', 'running tasks', 'daemon.log']);
  assert.match(checks.find((c) => c.name === 'running tasks')!.reason, new RegExp(`no live claude process: #${dead.id}$`));
  db.close();
});

test('daemonReport gives the checks, HEAD, the running tasks and the last 20 log lines', async () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 'busy', prompt: 'p' });
  db.applyEvent(task.id, { type: 'claim' });
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const report = await daemonReport(
    db,
    {
      service: async () => running,
      api: async () => state(),
      head: async () => 'b'.repeat(40),
      ahead: async () => 1,
      alive: () => true,
      logLines: () => [...lines, ''],
      gh: async () => ({ ok: true, output: 'ok' }),
      reviews: async () => [],
      now: () => NOW,
    },
    4317,
  );
  assert.equal(report.head, 'b'.repeat(40));
  assert.deepEqual(report.running, [{ id: task.id, title: 'busy' }]);
  assert.equal(report.log.length, 20);
  assert.equal(report.log.at(-1), 'line 29');
  assert.ok(report.checks.some((c) => c.name === 'code loaded' && !c.ok));
  db.close();
});

test('restartNow names the running tasks and restarts after the answer', async () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const task = db.addTask({ repo_id: repo.id, title: 'busy', prompt: 'p' });
  db.applyEvent(task.id, { type: 'claim' });
  let restarted = 0;
  const result = restartNow(db, async () => void restarted++, 0);
  assert.deepEqual(result, { requeued: [{ id: task.id, title: 'busy' }] });
  assert.equal(restarted, 0);
  await waitFor(() => restarted > 0, { what: 'the restart' });
  assert.equal(restarted, 1);
  db.close();
});
