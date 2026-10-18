import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-api-'));
process.env.AGENTDECK_HOME = home;
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db.ts');
const { startApi } = await import('../src/api.ts');
const { Scheduler } = await import('../src/scheduler.ts');

const db = openDb(join(home, 'test.db'));
const server = await startApi(db, 0);
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

  const task = await (await api('/api/tasks', { method: 'POST', json: { repo: 'demo', prompt: 'FAKE_DONE do it', title: 'Do it' } })).json();
  assert.equal(task.status, 'queued');
  assert.equal(task.repo, 'demo');

  const list = await (await api('/api/tasks?status=queued')).json();
  assert.deepEqual(list.map((t: any) => t.id), [task.id]);
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

test('cancel and retry', async () => {
  const done = await api('/api/tasks/1/cancel', { method: 'POST' });
  assert.equal(done.status, 400, 'done tasks cannot be cancelled');
  const retried = await (await api('/api/tasks/1/retry', { method: 'POST' })).json();
  assert.equal(retried.status, 'queued');
  const cancelled = await (await api('/api/tasks/1/cancel', { method: 'POST' })).json();
  assert.equal(cancelled.result, 'cancelled');
});
