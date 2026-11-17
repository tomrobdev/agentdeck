import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeCodeHost } from '#test/fixtures/fakes.ts';
import { doneTask, openPr, testApp, waitFor } from '#test/fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-sigterm-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
process.env.AGENTDECK_API_TOKEN = 'drain-token';
const free = createServer();
await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
const port = (free.address() as AddressInfo).port;
await new Promise<void>((resolve) => free.close(() => resolve()));
process.env.AGENTDECK_PORT = String(port);

const { openDb } = await import('#db/index.ts');
const { runDaemon } = await import('#src/daemon.ts');
const { realProcesses } = await import('#src/compose.ts');

let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));
let closing = false;
const codeHost = fakeCodeHost();
codeHost.closePr = async () => {
  closing = true;
  await gate;
};

const app = testApp(openDb(join(home, 'test.db')), {
  codeHost,
  processes: { ...realProcesses(), keepAwake: () => ({ set: () => {} }) },
  notifier: { desktop: async () => {}, ntfy: async () => {} },
});

const repoPath = join(home, 'demo');
mkdirSync(repoPath);
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoPath });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 't');
writeFileSync(join(repoPath, 'a.txt'), 'a\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');
const repo = app.addRepo({ name: 'demo', path: repoPath, base_branch: 'main' });

type Listener = (...args: unknown[]) => void;
const listeners = (event: string) => process.listeners(event as 'exit') as Listener[];
const before = new Map(['exit', 'SIGINT', 'SIGTERM'].map((e) => [e, listeners(e)]));
const added = (event: string) => listeners(event).filter((l) => !before.get(event)?.includes(l));

const logs: string[] = [];
const exits: number[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => void logs.push(a.join(' '));

after(() => {
  release();
  for (const stop of added('SIGTERM')) stop();
  for (const event of ['exit', 'SIGINT', 'SIGTERM']) for (const l of added(event)) process.off(event as 'exit', l);
  console.log = realLog;
  app.close();
});

test('SIGTERM with only a change stream open exits without waiting for it', async () => {
  const exited: number[] = [];
  const ran = runDaemon({ db: app, once: false, log: (line) => logs.push(line), exit: (code) => void exited.push(code) });
  await waitFor(() => logs.some((l) => l.includes('agentdeck daemon')), { what: 'the daemon to start' });
  const stream = new AbortController();
  const events = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: stream.signal });
  assert.equal(events.status, 200);
  const mine = added('SIGTERM');
  for (const stop of mine) stop();
  await waitFor(() => exited.length > 0, { timeoutMs: 2000, what: 'the daemon to exit with the stream still open' });
  stream.abort();
  for (const event of ['exit', 'SIGINT', 'SIGTERM']) for (const l of added(event)) process.off(event as 'exit', l);
  logs.length = 0;
  await ran;
});

test('SIGTERM lets a request in flight answer before the daemon exits', async () => {
  app.setPaused(false);
  const task = doneTask(app, repo);
  openPr(app, task.id);
  const stopped = runDaemon({ db: app, once: false, log: (line) => logs.push(line), exit: (code) => void exits.push(code) });
  await waitFor(() => logs.some((l) => l.includes('agentdeck daemon')), { what: 'the daemon to start' });

  const answer = fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/close-pr`, {
    method: 'POST',
    headers: { Authorization: 'Bearer drain-token' },
  });
  await waitFor(() => closing, { what: 'the request to be in flight' });
  for (const stop of added('SIGTERM')) stop();
  await sleep(300);
  assert.deepEqual(exits, [], 'the daemon waits for the request');
  assert.ok(logs.some((l) => /SIGTERM: no new requests/.test(l)));

  release();
  assert.equal((await answer).status, 200, 'the request is answered');
  await waitFor(() => exits.length > 0, { what: 'the daemon to exit once the request is answered' });
  assert.deepEqual(exits, [0]);
  await stopped;
});
