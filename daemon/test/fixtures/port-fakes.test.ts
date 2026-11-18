// The Agent and CodeHost ports on their in-memory fakes: a worker run and a merge, with no claude binary and no gh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-ports-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { doneTask, testApp } = await import('#test/fixtures/fixtures.ts');
const { READY_PR, fakeAgent, fakeCodeHost } = await import('#test/fixtures/fakes.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { mergeTask } = await import('#application/landing/merge/merge.ts');

const agent = fakeAgent((session) => {
  writeFileSync(join(session.cwd, 'fake-output.txt'), 'made by the fake agent\n');
  execFileSync('git', ['add', '-A'], { cwd: session.cwd });
  execFileSync('git', ['commit', '-q', '-m', 'work'], { cwd: session.cwd });
});
const codeHost = fakeCodeHost();
const db = testApp(openDb(join(home, 'test.db')), { agent, codeHost });
after(() => db.close());

const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
sh('init', '-q', '-b', 'main');
sh('config', 'user.email', 'test@example.com');
sh('config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
sh('add', '-A');
sh('commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'test -f fake-output.txt' });

test('a worker run goes through the Agent port: the task ends done, with the session and the commit the agent made', async () => {
  db.setSetting('max_concurrent', '1');
  const task = db.addTask({ repo_id: repo.id, title: 'make output', prompt: 'please make the output' });
  await new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

  const t = db.getTask(task.id)!;
  assert.equal(t.status, 'done');
  assert.equal(agent.sessions.length, 1);
  assert.equal(agent.sessions[0].cwd, t.checkout!.worktree);
  assert.ok(agent.sessions[0].args.some((a) => a.includes('please make the output')));
  assert.equal(sh('rev-list', '--count', `main..${t.checkout!.branch}`), '1');
  const [run] = db.runsForTask(t.id);
  assert.equal(run.outcome, 'done');
  assert.equal(run.session_id, 'fake-session-1');
  assert.equal(run.tests_passed, true);
});

test('a merge goes through the CodeHost port: the PR is merged with the repo method and the remote branch deleted', async () => {
  const url = 'https://example.test/pull/77';
  const t = doneTask(db, repo, { pr: 'open', url, branch: 'agentdeck/fake-merge' });

  const result = await mergeTask(db, t.id, { delete_branch: true });

  assert.deepEqual(codeHost.merged, [{ url, method: repo.merge_method, head: READY_PR.head }], 'pinned to the head it read');
  assert.deepEqual(codeHost.deletedBranches, ['agentdeck/fake-merge']);
  assert.equal(db.getTask(t.id)!.pr?.state, 'merged');
  assert.ok(result);
});
