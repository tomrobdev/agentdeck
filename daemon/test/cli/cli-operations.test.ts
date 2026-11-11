// The daemon, settings, status, context and stats commands run in process.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Service } from '../../src/application/ports/service.ts';
import { fakeCodeHost } from '../fixtures/fakes.ts';
import { doneTask, queuedTask } from '../fixtures/fixtures.ts';
import { scratchCli, scratchRepo } from './cli-run.ts';

const status = { installed: true, loaded: true, pid: 4242, state: 'running', plist: '/x.plist', program: '/x' };
const service: Service = {
  status: async () => status,
  start: async () => status,
  stop: async () => {},
  restart: async () => status,
  install: async () => status,
  uninstall: async () => {},
  tailLog: async () => {},
  daemonState: async () => null,
  logTail: () => ['daemon started'],
};
const { db, run } = scratchCli({ codeHost: fakeCodeHost(), service });
const path = scratchRepo('gamma');
const repo = await (await import('../../src/application/actions.ts')).addRepo(db, { path, test: 'true' });

test('pause and resume stop and start the queue, and status says which', async () => {
  assert.match((await run('pause')).out, /^paused: running tasks finish/);
  assert.match((await run('status')).out, /^state {6}PAUSED/m);
  assert.equal((await run('resume')).out, 'resumed');
  const status = (await run('status')).out;
  assert.match(status, /^state {6}active/m);
  assert.match(status, /^slots {6}0\/\d+ running/m);
  assert.match(status, /^tasks {6}none/m);
  assert.match(status, /^db /m);
  queuedTask(db, repo);
  assert.match((await run('status')).out, /tasks {6}queued 1/);
});

test('set changes a daemon setting and settings lists them all', async () => {
  assert.equal((await run('set', 'max_concurrent', '2')).out, 'max_concurrent = 2');
  assert.equal((await run('set', 'notify_desktop', 'off')).out, 'notify_desktop = off');
  assert.equal((await run('set', 'planner_enabled', 'on')).out, 'planner_enabled = on');
  assert.match((await run('set', 'nope', '1')).err, /unknown setting "nope"/);
  const settings = (await run('settings')).out;
  assert.match(settings, /^max_concurrent {2}2$/m);
  assert.match(settings, /^notify_desktop {2}off$/m);
  assert.match(settings, /^planner {9}on, every \d+h/m);
  assert.match(settings, /^governor {8}/m);
});

test('doctor reports the daemon health as text or JSON, and exits 1 when a check fails', async () => {
  const text = await run('doctor');
  assert.equal(text.err, '');
  assert.match(text.out, /checks failed|the daemon is healthy/);
  const json = await run('doctor', '--json');
  const parsed = JSON.parse(json.out) as { ok: boolean; checks: unknown[] };
  assert.ok(parsed.checks.length > 0);
  assert.equal(text.exit, parsed.ok ? null : 1);
});

test('install, uninstall, service, restart, logs and notify-test go through the service port and say what happened', async () => {
  assert.match((await run('install')).out, /installed \/x\.plist\ndaemon running \(pid 4242\)/);
  assert.match((await run('uninstall')).out, /removed the launchd agent/);
  assert.match((await run('service')).out, /installed \/x\.plist\nloaded {5}running, pid 4242\nprogram {4}\/x/);
  assert.match((await run('service', 'start')).out, /service started: daemon running \(pid 4242\)/);
  assert.match((await run('service', 'stop')).out, /service stopped/);
  assert.match((await run('restart', '--now')).out, /agentdeck daemon restarted/);
  assert.equal((await run('logs', '-n', '5')).exit, null);
});

test('service, restart and logs refuse a wrong command line', async () => {
  assert.match((await run('service', 'bounce')).err, /usage: agentdeck service \[start\|stop\]/);
  assert.match((await run('restart', 'now')).err, /usage: agentdeck restart/);
  assert.match((await run('logs', 'x')).err, /usage: agentdeck logs/);
  assert.match((await run('logs', '-n', 'x')).err, /-n takes a whole number/);
});

test('context prints the live queue of a repo and the event to continue from, and refuses an unknown repo or a bad --since', async () => {
  doneTask(db, repo, { pr: 'open' });
  const ctx = await run('context', '--repo', 'gamma');
  assert.match(ctx.out, /\(event \d+: pass --since \d+ to see what changes after now\)/);
  const cursor = /pass --since (\d+)/.exec(ctx.out)?.[1] ?? '0';
  assert.match((await run('context', '--repo', 'gamma', '--since', cursor)).out, /event \d+/);
  assert.match((await run('context', '--repo', 'nope')).err, /no repo "nope"/);
  assert.match((await run('context', '--repo', 'gamma', '--since', 'x')).err, /--since takes an event id/);
  assert.match((await run('context')).err, /not in a registered repo/);
});

test('stats prints the table, JSON, failures or by-model, and refuses a bad --by or --since', async () => {
  assert.match((await run('stats')).out, /gamma/);
  assert.ok('failures' in (JSON.parse((await run('stats', '--json')).out) as object));
  assert.equal((await run('stats', '--failures')).exit, null);
  assert.equal((await run('stats', '--by', 'model')).exit, null);
  assert.equal((await run('stats', '--by', 'week', '--since', '2026-01-01', '--repo', 'gamma')).exit, null);
  assert.match((await run('stats', '--by', 'year')).err, /--by takes week or model/);
  assert.match((await run('stats', '--since', 'soon')).err, /--since takes a date/);
});
