import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { asTaskId } from '../src/domain/shared/id.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-api-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('./open-db.ts');
const { startApi } = await import('../src/api/server.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');

const db = openDb(join(home, 'test.db'));
const server = await startApi({ db, port: 0 });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const repoPath = join(home, 'demo');

const api = (path: string, init: RequestInit & { json?: unknown } = {}) =>
  fetch(base + path, {
    ...init,
    headers: { ...(init.json ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as object) },
    body: init.json ? JSON.stringify(init.json) : init.body,
  });

before(() => {
  mkdirSync(repoPath);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repoPath });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repoPath, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
});

after(() => {
  server.close();
  db.close();
});

test('status starts paused', async () => {
  const st = await (await api('/api/status')).json();
  assert.equal(st.paused, true);
  assert.equal(st.max_concurrent, 2);
});

test('add repo and task, then read it back', async () => {
  const repo = await (await api('/api/repos', { method: 'POST', json: { path: repoPath, name: 'demo' } })).json();
  assert.equal(repo.name, 'demo');

  const bad = await api('/api/tasks', { method: 'POST', json: { repo: 'demo', prompt: '  ' } });
  assert.equal(bad.status, 400);

  const task = await (
    await api('/api/tasks', { method: 'POST', json: { repo: 'demo', prompt: 'FAKE_DONE do it', title: 'Do it' } })
  ).json();
  assert.equal(task.status, 'queued');
  assert.equal(task.repo, 'demo');
  assert.deepEqual(
    task.events.map((e: any) => [e.type, e.from_status, e.to_status]),
    [['created', null, 'queued']],
  );

  const list = await (await api('/api/tasks?status=queued')).json();
  assert.deepEqual(
    list.map((t: any) => t.id),
    [task.id],
  );
  assert.equal((await api('/api/tasks?status=nonsense')).status, 400);
  assert.equal((await api(`/api/repos/${repo.id}/plan`, { method: 'POST', json: {} })).status, 404, 'the planner route is /propose');
});

test('rejects browser requests from other origins', async () => {
  const res = await api('/api/pause', { method: 'POST', headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
  assert.equal(db.isPaused(), true);

  const ok = await api('/api/resume', { method: 'POST', headers: { Origin: 'http://localhost:1420' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:1420');
  assert.equal(db.isPaused(), false);
});

test('log stream replays a finished run and ends', async () => {
  await new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
  const detail = await (await api('/api/tasks/1')).json();
  assert.equal(detail.status, 'done');
  assert.equal(detail.runs.length, 1);

  const body = await (await api('/api/tasks/1/log')).text();
  assert.match(body, /"kind":"text"/);
  assert.match(body, /"kind":"result"/);
  assert.match(body, /event: end/);
});

test('a log that cannot be read ends the stream instead of stopping the daemon', async () => {
  // A directory where the log should be: it exists and has a size, but reading it throws (EISDIR).
  const unreadable = join(home, 'unreadable-log');
  mkdirSync(unreadable);
  const runId = db.startRun(asTaskId(1), 1, unreadable);
  const body = await (await api(`/api/tasks/1/log?run=${runId}`)).text();
  assert.match(body, /event: end/);
  db.finishRun(runId, { outcome: 'failed' });
  const st = await api('/api/status');
  assert.equal(st.status, 200, 'the daemon still answers');
});

test('cancel and retry', async () => {
  const done = await api('/api/tasks/1/cancel', { method: 'POST' });
  assert.equal(done.status, 400, 'done tasks cannot be cancelled');
  const retried = await (await api('/api/tasks/1/retry', { method: 'POST' })).json();
  assert.equal(retried.status, 'queued');
  const cancelled = await (await api('/api/tasks/1/cancel', { method: 'POST' })).json();
  assert.equal(cancelled.result, 'cancelled');
});

test('retry takes a note, which the timeline keeps; close-pr needs an open PR', async () => {
  const retried = await (await api('/api/tasks/1/retry', { method: 'POST', json: { note: 'Add a test.' } })).json();
  assert.equal(retried.status, 'queued');
  assert.equal(retried.events.at(-1).reason, 'Add a test.');
  const noPr = await api('/api/tasks/1/close-pr', { method: 'POST' });
  assert.equal(noPr.status, 400);
  await api('/api/tasks/1/cancel', { method: 'POST' });
});

test('settings round-trip with validation', async () => {
  const s = await (await api('/api/settings')).json();
  assert.equal(s.budget.weekly_max, 0.8);
  assert.equal(s.notify.desktop, true);

  const bad = await api('/api/settings', { method: 'POST', json: { budget: { weekly_max: 2 } } });
  assert.equal(bad.status, 400);
  const badTopic = await api('/api/settings', { method: 'POST', json: { notify: { ntfy_topic: 'has spaces' } } });
  assert.equal(badTopic.status, 400);

  const ok = await (
    await api('/api/settings', {
      method: 'POST',
      json: { max_concurrent: 3, budget: { weekly_max: 0.7 }, notify: { events: ['blocked'], ntfy_topic: 'my-topic' } },
    })
  ).json();
  assert.equal(ok.max_concurrent, 3);
  assert.equal(ok.budget.weekly_max, 0.7);
  assert.equal(ok.budget.five_hour_max, 0.85, 'untouched keys keep their values');
  assert.deepEqual(ok.notify.events, ['blocked']);

  const st = await (await api('/api/status')).json();
  assert.equal(typeof st.governor.allow, 'boolean');
});

test('test notification is recorded', async () => {
  const res = await api('/api/notify/test', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(db.recentNotifications(1)[0].kind, 'test');
});

test('POST /api/tasks/:id edits a task; bad edits are 400', async () => {
  const task = await (await api('/api/tasks', { method: 'POST', json: { repo: 'demo', prompt: 'before' } })).json();
  const patch = { prompt: 'after', max_turns: 7, priority: 2 };
  const edited = await (await api(`/api/tasks/${task.id}`, { method: 'POST', json: patch })).json();
  assert.deepEqual([edited.prompt, edited.max_turns, edited.priority, edited.status], ['after', 7, 2, 'queued']);

  const bad = await api(`/api/tasks/${task.id}`, { method: 'POST', json: { max_turns: 'lots' } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /max_turns/);
  await api(`/api/tasks/${task.id}/cancel`, { method: 'POST' });
  const cancelled = await api(`/api/tasks/${task.id}`, { method: 'POST', json: { prompt: 'again' } });
  assert.equal(cancelled.status, 400, 'cancelled tasks are not editable');
});

test('POST /api/repos/:id/doctor reports checks and pauses; resume clears the pause', async () => {
  const repos = await (await api('/api/repos')).json();
  const demo = repos.find((r: any) => r.name === 'demo');
  assert.equal(demo.paused_reason, null);

  const report = await (await api(`/api/repos/${demo.id}/doctor`, { method: 'POST' })).json();
  assert.equal(report.ok, false, 'demo has no toolchain or test command');
  assert.equal(report.checks[0].name, 'git repo');
  assert.ok(report.checks.every((c: any) => typeof c.reason === 'string'));
  assert.match(report.paused_reason, /^doctor: /);
  assert.equal((await (await api(`/api/repos/${demo.id}`)).json()).paused_reason, report.paused_reason);

  const resumed = await (await api(`/api/repos/${demo.id}/resume`, { method: 'POST' })).json();
  assert.equal(resumed.paused_reason, null);
});

test('task list returns summaries, pages with limit/before, and always includes active tasks', async () => {
  const ids: number[] = [];
  const active = await (await api('/api/tasks', { method: 'POST', json: { repo: 'demo', prompt: 'still queued' } })).json();
  for (let i = 0; i < 5; i++) {
    const t = await (await api('/api/tasks', { method: 'POST', json: { repo: 'demo', prompt: `secret prompt ${i}` } })).json();
    await api(`/api/tasks/${t.id}/cancel`, { method: 'POST' });
    ids.push(t.id);
  }
  const list = (path: string) => api(path).then((r) => r.json() as Promise<any[]>);

  const all = await list('/api/tasks');
  for (const t of all) {
    assert.equal('prompt' in t, false, 'list rows omit the prompt');
    assert.equal(t.repo, 'demo');
  }
  assert.equal((await (await api(`/api/tasks/${active.id}`)).json()).prompt, 'still queued', 'detail keeps the prompt');

  // limit counts the newest tasks; active ones ride along on top.
  const limited = await list('/api/tasks?limit=2');
  assert.deepEqual(
    limited.map((t) => t.id),
    [ids[4], ids[3], active.id],
  );

  // before pages to older tasks, without repeating active ones.
  const older = await list(`/api/tasks?limit=2&before=${ids[3]}`);
  assert.deepEqual(
    older.map((t) => t.id),
    [ids[2], ids[1]],
  );

  // status filter composes with limit and before.
  const cancelled = await list(`/api/tasks?status=cancelled&limit=2&before=${ids[3]}`);
  assert.deepEqual(
    cancelled.map((t) => t.id),
    [ids[2], ids[1]],
  );
  const queued = await list('/api/tasks?status=queued&limit=1');
  assert.deepEqual(
    queued.map((t) => t.id),
    [active.id],
  );

  // limit is clamped to 1..1000 and bad values fall back to the default.
  assert.equal((await list('/api/tasks?limit=0')).length > 0, true);
  assert.equal((await list('/api/tasks?limit=abc')).length, all.length);
});

test('status reports which code the daemon runs, and restart waits while work runs', async () => {
  const info = { commit: 'abc1234def', started_at: '2026-10-19T14:02:00.000Z', pid: 4242 };
  let requested = 0;
  const reloadFacts = () => ({ changed: ['a.ts'], lastChangeAt: 0, blocked: 'the checkout is on x, not main' });
  const server2 = await startApi({ db, port: 0, daemon: { info, requestRestart: () => requested++, reloadFacts } });
  const url = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
  try {
    // GET /api/daemon: the loaded commit, pid and start time next to the reload state.
    db.setSetting('reload_on_change', '1');
    const state = await (await fetch(`${url}/api/daemon`)).json();
    assert.deepEqual([state.commit, state.pid, state.started_at], [info.commit, 4242, info.started_at]);
    assert.equal(state.reload.blocked, 'the checkout is on x, not main');
    assert.equal(state.reload.changed, 1);
    assert.deepEqual((await (await fetch(`${url}/api/status`)).json()).daemon, info);
    // The default server has no checkout to name.
    assert.equal((await (await api('/api/status')).json()).daemon.commit, null);

    const idle = await (await fetch(`${url}/api/daemon/restart`, { method: 'POST' })).json();
    assert.deepEqual(idle, { waiting: null });

    const repo = db.listRepos()[0];
    const planner = db.startPlannerRun(repo.id, join(home, 'planner.log'));
    const busy = await (await fetch(`${url}/api/daemon/restart`, { method: 'POST' })).json();
    assert.deepEqual(busy, { waiting: '1 planner run' });
    assert.equal(requested, 2);
    db.finishPlannerRun(planner, 'nothing', 0, null);
  } finally {
    server2.close();
  }
});

test('GET /api/events sends the current rev, then each new one, and unsubscribes on close', async () => {
  const subscribers = new Set<(rev: number) => void>();
  const changes = {
    rev: 7,
    subscribe: (fn: (rev: number) => void) => (subscribers.add(fn), () => void subscribers.delete(fn)),
  };
  const server2 = await startApi({ db, port: 0, changes });
  const url = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
  const ctl = new AbortController();
  try {
    const res = await fetch(`${url}/api/events`, { signal: ctl.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    assert.equal(dec.decode((await reader.read()).value), 'event: rev\ndata: {"rev":7}\n\n');
    assert.equal(subscribers.size, 1);
    for (const fn of subscribers) fn(8);
    assert.equal(dec.decode((await reader.read()).value), 'event: rev\ndata: {"rev":8}\n\n');
    ctl.abort();
    for (let i = 0; i < 50 && subscribers.size; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(subscribers.size, 0);
  } finally {
    ctl.abort();
    server2.closeAllConnections();
    server2.close();
  }
});
