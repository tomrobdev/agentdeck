import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-wake-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { startApi } = await import('../src/api/server.ts');

const repoPath = join(home, 'demo');
mkdirSync(repoPath);
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoPath });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
writeFileSync(join(repoPath, 'a.txt'), 'a\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');

const db = openDb(join(home, 'test.db'));
const events: string[] = [];
const server = await startApi({ db, port: 0, scheduler: { wake: () => events.push('wake'), track: (p) => p } });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  server.close();
  db.close();
});

const post = (path: string, json: unknown = {}) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) });

test('a successful write wakes the scheduler once, after the response', async () => {
  await post('/api/repos', { path: repoPath, name: 'demo' });
  const task = await (await post('/api/tasks', { repo: 'demo', prompt: 'do it', propose: true })).json();
  assert.equal(task.status, 'proposed');
  await new Promise((r) => setTimeout(r, 20));
  events.length = 0;

  const res = await post(`/api/tasks/${task.id}/approve`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'queued');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, ['wake']);
});

test('reads and failed writes do not wake it', async () => {
  events.length = 0;
  assert.equal((await fetch(`${base}/api/tasks`)).status, 200);
  assert.equal((await post('/api/tasks/9999/approve')).status >= 400, true);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(events, []);
});
