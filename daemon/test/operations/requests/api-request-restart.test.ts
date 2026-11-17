import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fakeCodeHost } from '#test/fixtures/fakes.ts';
import { doneTask, openPr, testApp, waitFor } from '#test/fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-request-restart-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { startApi } = await import('#api/server.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { reloadDecision } = await import('#domain/operations/index.ts');

let release!: () => void;
const gate = new Promise<void>((resolve) => (release = resolve));
const codeHost = fakeCodeHost();
let closing = false;
codeHost.closePr = async () => {
  closing = true;
  await gate;
};

const app = testApp(openDb(join(home, 'test.db')), {
  codeHost,
  processes: { ...(await import('#src/compose.ts')).realProcesses(), keepAwake: () => ({ set: () => {} }) },
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

let requested = false;
const exits: string[] = [];
const scheduler = new Scheduler(app, {
  tickMs: 60_000,
  autoPropose: false,
  log: () => {},
  reload: {
    check: (activity) => reloadDecision({ enabled: false, changed: [], lastChangeAt: null, now: Date.now(), activity, requested }),
    exit: () => void exits.push('exit'),
  },
});
const server = await startApi({ db: app, token: null, port: 0, scheduler });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => {
  release();
  scheduler.stop();
  server.close();
  app.close();
});

test('a restart requested while a slow POST is in flight does not exit until it answers', async () => {
  const task = doneTask(app, repo);
  openPr(app, task.id);
  void scheduler.run();

  const answer = fetch(`${base}/api/tasks/${task.id}/close-pr`, { method: 'POST' });
  await waitFor(() => closing, { what: 'the request to be in flight' });
  requested = true;
  scheduler.wake();
  await sleep(300);
  assert.deepEqual(exits, [], 'the restart waits for the request');

  release();
  assert.equal((await answer).status, 200, 'the request is answered');
  await waitFor(() => exits.length > 0, { what: 'the restart once the request is answered' });
  assert.deepEqual(exits, ['exit']);
});
