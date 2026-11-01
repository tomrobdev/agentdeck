import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-validation-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { startApi } = await import('../src/api/server.ts');
const { pilotStats } = await import('../src/application/actions.ts');

const db = openDb(join(home, 'test.db'));
const server = await startApi({ db, port: 0 });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const repoPath = join(home, 'demo');

const post = (path: string, body: unknown, raw = false) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });

let repoId = 0;
let taskId = 0;

before(async () => {
  mkdirSync(repoPath);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repoPath });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  writeFileSync(join(repoPath, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  repoId = (await (await post('/api/repos', { path: repoPath })).json()).id;
  taskId = (await (await post('/api/tasks', { prompt: 'do it', repo: 'demo' })).json()).id;
  assert.ok(repoId && taskId);
});

after(() => {
  server.close();
  db.close();
});

/** [route, body] pairs: each body has a field of the wrong type. */
function wrongTyped(): [string, unknown][] {
  const t = `/api/tasks/${taskId}`;
  const r = `/api/repos/${repoId}`;
  return [
    ['/api/settings', { max_concurrent: '3' }],
    ['/api/settings', { max_concurrent: [2] }],
    ['/api/settings', { reload_on_change: 'yes' }],
    ['/api/settings', { budget: 'big' }],
    ['/api/settings', { budget: { five_hour_max: 'a lot' } }],
    ['/api/settings', { notify: null }],
    ['/api/settings', { notify: { desktop: 'yes' } }],
    ['/api/settings', { notify: { events: 'blocked' } }],
    ['/api/settings', { notify: { events: [1] } }],
    ['/api/settings', { notify: { ntfy_topic: 5 } }],
    ['/api/settings', { notify: { ntfy_server: {} } }],
    ['/api/settings', { planner: { enabled: 1 } }],
    ['/api/settings', { planner: { interval_hours: '2' } }],
    ['/api/settings', { planner: { max_tasks: '3' } }],
    ['/api/settings', { planner: { model: 7 } }],
    ['/api/repos', { path: 5 }],
    ['/api/repos', { path: repoPath, name: 5 }],
    ['/api/repos', { path: repoPath, base: [] }],
    ['/api/repos', { path: repoPath, test: 5 }],
    ['/api/repos', { path: repoPath, setup: {} }],
    ['/api/repos', { path: repoPath, tools: 'Read' }],
    [r, { goals: 5 }],
    [r, { auto_approve: 'yes' }],
    [r, { test_cmd: 5 }],
    [r, { setup_cmd: [] }],
    [r, { base_branch: 5 }],
    [r, { pr_mode: 5 }],
    [r, { merge_method: {} }],
    [r, { auto_resolve: 1 }],
    [r, { sandbox: 'no' }],
    [r, { network: 5 }],
    [r, { network: [1] }],
    ['/api/tasks', { prompt: 5 }],
    ['/api/tasks', { prompt: 'x', title: 5 }],
    ['/api/tasks', { prompt: 'x', repo: 5 }],
    ['/api/tasks', { prompt: 'x', model: [] }],
    ['/api/tasks', { prompt: 'x', priority: '1' }],
    ['/api/tasks', { prompt: 'x', max_turns: '10' }],
    ['/api/tasks', { prompt: 'x', max_attempts: 1.5 }],
    ['/api/tasks', { prompt: 'x', builds_on: 'one' }],
    ['/api/tasks', { prompt: 'x', after: [1.5] }],
    ['/api/tasks', { prompt: 'x', plan_path: 5 }],
    ['/api/tasks', { prompt: 'x', plan_path: 'docs/plans/a.html', plan_steps: 5 }],
    [t, { title: 5 }],
    [t, { prompt: [] }],
    [t, { priority: '1' }],
    [t, { max_turns: null }],
    [t, { plan_path: 5 }],
    [t, { plan_steps: 5 }],
    [`${t}/retry`, { note: 5 }],
    [`${t}/merge`, { method: 5 }],
    [`${t}/merge`, { delete_branch: 'yes' }],
    [`${t}/plans`, { html: 5 }],
    [`${t}/plans`, { html: '<html data-agentdeck-plan="1"></html>', name: 5 }],
  ];
}

test('a POST body with a wrong-typed field answers 400, never 500', async () => {
  for (const [path, body] of wrongTyped()) {
    const res = await post(path, body);
    assert.equal(res.status, 400, `${path} ${JSON.stringify(body)} answered ${res.status}`);
  }
});

test('every POST route answers 400 to a body that is not a JSON object', async () => {
  const routes = [
    '/api/pause',
    '/api/resume',
    '/api/daemon/restart',
    '/api/settings',
    '/api/notify/test',
    '/api/repos',
    `/api/repos/${repoId}`,
    `/api/repos/${repoId}/plan`,
    `/api/repos/${repoId}/doctor`,
    `/api/repos/${repoId}/resume`,
    `/api/repos/${repoId}/archive`,
    `/api/repos/${repoId}/unarchive`,
    '/api/tasks',
    `/api/tasks/${taskId}`,
    `/api/tasks/${taskId}/approve`,
    `/api/tasks/${taskId}/reject`,
    `/api/tasks/${taskId}/cancel`,
    `/api/tasks/${taskId}/retry`,
    `/api/tasks/${taskId}/install-needs`,
    `/api/tasks/${taskId}/close-pr`,
    `/api/tasks/${taskId}/merge`,
    `/api/tasks/${taskId}/resolve`,
    `/api/tasks/${taskId}/plans`,
    `/api/tasks/${taskId}/plans/collect`,
  ];
  for (const path of routes) {
    for (const body of [[1], 'text', 5, null]) {
      const res = await post(path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)} answered ${res.status}`);
    }
  }
});

test('malformed JSON answers 400', async () => {
  const res = await post('/api/tasks', '{"prompt": ', true);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /JSON/);
});

test('GET /api/stats serves what `agentdeck stats --by week --json` prints', async () => {
  const res = await fetch(`${base}/api/stats?by=week&repo=demo`);
  assert.equal(res.status, 200);
  const stats = await res.json();
  assert.deepEqual(stats, JSON.parse(JSON.stringify(pilotStats(db, { repo: 'demo', by: 'week' }))));
  assert.deepEqual(stats.weeks, []);
  assert.equal(stats.scorecard.by, 'week');
  for (const bad of ['by=day', 'since=soon', 'repo=nope']) assert.equal((await fetch(`${base}/api/stats?${bad}`)).status, 400, bad);
});

test('a body over 2 MB answers 413', async () => {
  const res = await post('/api/tasks', JSON.stringify({ prompt: 'x'.repeat(2 * 1024 * 1024 + 1) }), true);
  assert.equal(res.status, 413);
  const ok = await post('/api/tasks', { prompt: 'still works', repo: 'demo' });
  assert.equal(ok.status, 200);
});
