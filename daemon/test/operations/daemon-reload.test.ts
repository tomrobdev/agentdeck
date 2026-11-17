import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Source } from '#application/ports/source.ts';
import { fakeAgent, fakeCodeHost } from '#test/fixtures/fakes.ts';
import { testApp, waitFor } from '#test/fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-reload-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const free = createServer();
await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', resolve));
const port = (free.address() as AddressInfo).port;
await new Promise<void>((resolve) => free.close(() => resolve()));
process.env.AGENTDECK_PORT = String(port);

const { openDb } = await import('#db/index.ts');
const { runDaemon } = await import('#src/daemon.ts');
const { realProcesses } = await import('#src/compose.ts');

let onChange: ((file: string) => void) | null = null;
const source: Source = {
  commit: async () => 'abc1234def5678',
  branch: async () => 'main',
  dirty: async () => false,
  watch: (_dir, cb) => {
    onChange = cb;
    return () => void (onChange = null);
  },
};

let finish!: () => void;
const released = new Promise<void>((resolve) => (finish = resolve));
const agent = fakeAgent(async (session) => {
  await released;
  writeFileSync(join(session.cwd, 'work.txt'), 'done\n');
  execFileSync('git', ['add', '-A'], { cwd: session.cwd });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'work'], { cwd: session.cwd });
});

const app = testApp(openDb(join(home, 'test.db')), {
  agent,
  codeHost: fakeCodeHost(),
  source,
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

const exits: number[] = [];

const EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const;
type Listener = (...args: unknown[]) => void;
const listeners = (event: string) => process.listeners(event as 'exit') as Listener[];
const listenersBefore = new Map(EVENTS.map((e) => [e, listeners(e)]));
const added = (event: (typeof EVENTS)[number]) => listeners(event).filter((l) => !listenersBefore.get(event)!.includes(l));

const logs: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => void logs.push(a.join(' '));

after(() => {
  for (const stop of added('SIGTERM')) stop();
  for (const close of added('exit')) close();
  for (const event of EVENTS) for (const l of added(event)) process.off(event as 'exit', l);
  console.log = realLog;
  finish();
  app.close();
});

const daemonState = async () => (await fetch(`http://127.0.0.1:${port}/api/daemon`)).json();

test('a source change while a task runs waits for it; once nothing runs the daemon exits for launchd', async () => {
  app.writeSettings({ ...app.readSettings(), reload_on_change: true });
  app.setPaused(false);
  const task = app.addTask({ repo_id: repo.id, title: 'long run', prompt: 'take a while' });
  const stopped = runDaemon({ db: app, once: false, log: (line) => logs.push(line), exit: (code) => void exits.push(code) });

  await waitFor(() => logs.some((l) => l.includes('agentdeck daemon abc1234')), { what: 'the daemon to start' });
  await waitFor(() => agent.sessions.length === 1 && app.getTask(task.id)?.status === 'running', { what: 'the task to run' }).catch(
    (err: Error) => assert.fail(`${err.message}; the daemon logged:\n${logs.join('\n')}`),
  );
  assert.ok(onChange, 'the daemon watches its source');

  for (let i = 0; i < 5; i++) onChange!('application/x.ts');
  let state = await daemonState();
  assert.equal(state.reload.changed, 1, 'the same file saved again is counted once');
  assert.equal(state.reload.pending, true);
  assert.equal(state.reload.waiting, '1 running task');
  onChange!('domain/y.ts');
  state = await daemonState();
  assert.equal(state.reload.changed, 2);

  await waitFor(() => logs.some((l) => /source changed \(domain\/y\.ts and 1 more\); reloading once 1 running task finish/.test(l)), {
    timeoutMs: 15_000,
    what: 'the scheduler to wait for the running task',
  });
  assert.deepEqual(exits, [], 'no restart while the task runs');
  assert.equal(app.getTask(task.id)?.status, 'running');

  finish();
  await waitFor(() => exits.length > 0, { timeoutMs: 15_000, what: 'the daemon to exit once the task is done' });
  assert.deepEqual(exits, [0], 'it exits cleanly, once');
  assert.equal(app.getTask(task.id)?.status, 'done', 'the task finished before the restart');
  assert.ok(logs.some((l) => /source changed \(domain\/y\.ts and 1 more\) and nothing is running; exiting/.test(l)));
  await stopped;
  assert.equal(agent.sessions.length, 1, 'no other run started while the reload was pending');
});
