// The CLI calling a live daemon: callDaemon (cli/daemon-client.ts) against a started API, on the paths `agentdeck
// propose` and `agentdeck sync` call, in success and error. An error ends the CLI through `die`, so the test replaces
// process.exit and console.error for the call and reads what it would have printed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ProposalResult } from '../../src/domain/proposals/index.ts';
import { fakeAgent, fakeCodeHost } from '../fixtures/fakes.ts';
import { asRepoId, asTaskId, testApp, waitFor } from '../fixtures/fixtures.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-client-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../src/db/index.ts');
const { startApi } = await import('../../src/api/server.ts');
const { ensureWorktree } = await import('../../src/adapters/git.ts');
const { callDaemon } = await import('../../src/cli/daemon-client.ts');
type SyncReport = import('../../src/application/actions.ts').SyncReport;

const app = testApp(openDb(join(home, 'test.db')), { agent: fakeAgent(), codeHost: fakeCodeHost() });
const server = await startApi({ db: app, port: 0 });
const port = (server.address() as AddressInfo).port;
const others: Server[] = [];

after(() => {
  server.close();
  for (const s of others) s.close();
  app.close();
});

const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const repoPath = join(home, 'demo');
mkdirSync(repoPath);
git(repoPath, 'init', '-q', '-b', 'main');
git(repoPath, 'config', 'user.email', 't@example.com');
git(repoPath, 'config', 'user.name', 't');
writeFileSync(join(repoPath, 'a.txt'), 'a\n');
git(repoPath, 'add', '-A');
git(repoPath, 'commit', '-q', '-m', 'init');
const repo = app.addRepo({ name: 'demo', path: repoPath, base_branch: 'main' });

/** A done task with a worktree whose branch has one commit of its own. */
async function doneWithWorktree() {
  const t = app.addTask({ repo_id: repo.id, title: 'w', prompt: 'p' });
  const { branch, path } = await ensureWorktree(repo, t);
  app.setCheckout(t.id, { branch, worktree: path });
  writeFileSync(join(path, `${t.id}.txt`), 'b\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-q', '-m', 'work');
  for (const event of [{ type: 'claim' }, { type: 'finish', outcome: 'done' }] as const) {
    const applied = app.applyEvent(t.id, event);
    assert.ok(applied, `${event.type} was refused`);
    app.markFollowedUp(applied.pending);
  }
  return t;
}

/** Call the daemon as the CLI does when it must end: the exit code and what it printed to stderr. */
async function dies(call: () => Promise<unknown>): Promise<{ code: number | undefined; printed: string }> {
  const exit = process.exit;
  const error = console.error;
  let code: number | undefined;
  const printed: string[] = [];
  let answered = false;
  process.exit = ((c?: number) => void (code = c ?? 0)) as typeof process.exit;
  console.error = (...a: unknown[]) => void printed.push(a.join(' '));
  try {
    void call().then(() => (answered = true));
    await waitFor(() => code !== undefined || answered, { what: 'the CLI to exit' });
  } finally {
    process.exit = exit;
    console.error = error;
  }
  assert.equal(answered, false, 'the call ends the CLI instead of answering');
  return { code, printed: printed.join('\n') };
}

/** A server on a port of its own that answers every request with `status` and `body`. */
async function answering(status: number, body: string): Promise<number> {
  const s = createServer((_req, res) => res.writeHead(status, { 'Content-Type': 'text/plain' }).end(body));
  others.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return (s.address() as AddressInfo).port;
}

test('propose: the daemon answers with the proposal result', async () => {
  const res = await callDaemon<ProposalResult>('POST', `/api/repos/${repo.id}/propose`, {}, port);
  assert.equal(res.outcome, 'no_goals', 'a repo with no goals file is not planned');
  assert.deepEqual(res.tasks, []);
  assert.deepEqual(res.skipped, []);
});

test('propose: an unknown repo ends the CLI with the daemon’s error', async () => {
  const { code, printed } = await dies(() => callDaemon('POST', `/api/repos/${asRepoId(9999)}/propose`, {}, port));
  assert.equal(code, 1);
  assert.equal(printed, 'agentdeck: no repo "9999"');
});

test('sync: a branch already in sync answers up_to_date, and one behind the base merges it in', async () => {
  const t = await doneWithWorktree();
  const first = await callDaemon<SyncReport>('POST', `/api/tasks/${t.id}/sync`, {}, port);
  assert.equal(first.outcome, 'up_to_date');
  assert.deepEqual(first.files, []);

  writeFileSync(join(repoPath, 'base.txt'), 'moved on\n');
  git(repoPath, 'add', '-A');
  git(repoPath, 'commit', '-q', '-m', 'base moves on');
  const second = await callDaemon<SyncReport>('POST', `/api/tasks/${t.id}/sync`, {}, port);
  assert.equal(second.outcome, 'clean');
  assert.equal(git(app.getTask(t.id)!.checkout!.worktree!, 'show', 'HEAD:base.txt'), 'moved on', 'the base is in the branch');
});

test('sync: an unknown task, and a task that is not done, end the CLI with the daemon’s error', async () => {
  const unknown = await dies(() => callDaemon('POST', `/api/tasks/${asTaskId(9999)}/sync`, {}, port));
  assert.equal(unknown.code, 1);
  assert.equal(unknown.printed, 'agentdeck: no such task');

  const queued = app.addTask({ repo_id: repo.id, title: 'q', prompt: 'p' });
  const bare = await dies(() => callDaemon('POST', `/api/tasks/${queued.id}/sync`, {}, port));
  assert.equal(bare.code, 1);
  assert.equal(bare.printed, `agentdeck: #${queued.id} is queued; only a done task's branch is synced this way`);
});

test('no daemon listening: the CLI says to start it', async () => {
  const free = await answering(200, '{}');
  const s = others.pop()!;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  const { code, printed } = await dies(() => callDaemon('POST', `/api/tasks/1/sync`, {}, free));
  assert.equal(code, 1);
  assert.match(printed, /the daemon is not running; start it with `agentdeck service start`/);
});

test('an answer that is not JSON, or an error status with no error, ends the CLI naming the status', async () => {
  const html = await dies(async () => callDaemon('POST', '/api/tasks/1/sync', {}, await answering(502, '<html>bad gateway</html>')));
  assert.equal(html.code, 1);
  assert.match(html.printed, /the daemon answered 502 with something that is not JSON/);

  const empty = await dies(async () => callDaemon('POST', '/api/tasks/1/sync', {}, await answering(500, '')));
  assert.equal(empty.code, 1);
  assert.match(empty.printed, /the daemon answered 500$/);
});
