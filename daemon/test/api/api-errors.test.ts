// What a failed request answers: 400 for bad input, 404 for a missing thing, 409 for a state conflict, 502 when GitHub fails, 405 for a wrong method, and the error's code.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fakeAgent, fakeCodeHost } from '../fixtures/fakes.ts';
import { doneTask, queuedTask, runningTask, testApp } from '../fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-errors-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../src/db/index.ts');
const { startApi } = await import('../../src/api/server.ts');

const host = fakeCodeHost();
host.prDetails = async () => {
  throw new Error('gh: HTTP 503');
};
const app = testApp(openDb(join(home, 'test.db')), { agent: fakeAgent(), codeHost: host });
const server = await startApi({ db: app, token: null, port: 0 });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  app.close();
});

const repo = app.addRepo({ name: 'demo', path: home, base_branch: 'main', toolchain: 'pnpm' });

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  return { res, json: (await res.json()) as { error: string; code?: string } };
}

test('a task that does not exist answers 404 with its message', async () => {
  const { res, json } = await call('GET', '/api/tasks/999999');
  assert.equal(res.status, 404);
  assert.equal(json.error, 'no such task');
  assert.equal((await call('GET', '/api/repos/nowhere')).res.status, 404);
});

test('editing a running task answers 409', async () => {
  const task = runningTask(app, repo);
  const { res, json } = await call('POST', `/api/tasks/${task.id}`, { priority: 1 });
  assert.equal(res.status, 409);
  assert.match(json.error, /is running; only/);
});

test('a PR read that fails because gh fails answers 502', async () => {
  const task = doneTask(app, repo, { pr: 'open' });
  const { res, json } = await call('GET', `/api/tasks/${task.id}/merge`);
  assert.equal(res.status, 502);
  assert.match(json.error, /^could not read the PR: /);
});

test('bad input still answers 400', async () => {
  assert.equal((await call('POST', '/api/tasks', { prompt: 5 })).res.status, 400);
});

test('a path with another method answers 405 and names the methods it allows', async () => {
  const { res } = await call('DELETE', '/api/settings');
  assert.equal(res.status, 405);
  assert.match(res.headers.get('allow') ?? '', /GET/);
  assert.equal((await call('GET', '/api/nowhere')).res.status, 404);
});

test('the error body carries the code of an ActionError that has one', async () => {
  const running = runningTask(app, repo);
  const target = queuedTask(app, repo);
  const { res, json } = await call('POST', `/api/tasks/${running.id}/links`, { on: target.id, kind: 'builds_on' });
  assert.equal(res.status, 409);
  assert.equal(json.code, 'builds_on_started');
  assert.equal((await call('POST', '/api/tasks', { prompt: 5 })).json.code, undefined);
});
