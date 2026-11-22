// The repo, goals and settings commands run in process: their arguments, their output and their refusals.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scratchCli, scratchRepo } from '#test/cli/cli-run.ts';

const { run } = scratchCli();
const path = scratchRepo('alpha');

test('repo add registers a git repo and checks it', async () => {
  const added = await run('repo', 'add', path, '--test', 'true');
  assert.match(added.out, /added repo "alpha" \(.*base main.*tests: true\)/);
  assert.match(added.out, /alpha: (ready|PAUSED)/);
  assert.equal((await run('repo', 'add')).err, 'agentdeck: repo add needs a path');
  const missing = await run('repo', 'add', '/does/not/exist');
  assert.match(missing.err, /is not a git repository/);
  assert.equal(missing.exit, 1);
});

test('repo ls lists each repo on a line, and --archived the archived ones', async () => {
  const list = await run('repo', 'ls');
  assert.match(list.out, /^alpha\s+.*base=main .*pr=.*sandbox=.*no goals/m);
  assert.equal((await run('repo')).out, list.out);
  assert.equal((await run('repo', 'ls', '--archived')).out, '');
});

test('repo set changes a setting and says so, tools say where the rules come from, and a wrong key shows the usage', async () => {
  assert.equal((await run('repo', 'set', 'alpha', 'auto_approve', 'on')).out, 'alpha: auto_approve on');
  assert.equal((await run('repo', 'set', 'alpha', 'model', '')).out, 'alpha: model (none)');
  assert.match((await run('repo', 'set', 'alpha', 'tools', 'Read, Grep')).out, /alpha: tools the repo's own: Read, Grep/);
  assert.match((await run('repo', 'set', 'alpha', 'tools', '')).out, /alpha: tools detected from its toolchain/);
  assert.match((await run('repo', 'set', 'alpha', 'nope', 'x')).err, /usage: agentdeck repo set <repo>/);
  assert.match((await run('repo', 'ls')).out, /auto-approve/);
  assert.doesNotMatch((await run('repo', 'ls')).out, / {2}issues/);
  await run('repo', 'set', 'alpha', 'issues', 'on');
  assert.match((await run('repo', 'ls')).out, / {2}issues/);
  await run('repo', 'set', 'alpha', 'issues', 'off');
});

test('goals prints the goals file, and --file replaces it', async () => {
  assert.match((await run('goals', 'alpha')).out, /\(empty: write the outcomes you want/);
  const file = join(mkdtempSync(join(tmpdir(), 'agentdeck-goals-')), 'goals.md');
  writeFileSync(file, 'Ship the thing\n');
  assert.match((await run('goals', 'alpha', '--file', file)).out, /Ship the thing/);
  assert.match((await run('repo', 'ls')).out, /goals ✓/);
  assert.equal((await run('goals')).err, 'agentdeck: usage: agentdeck goals <repo> [--file goals.md]');
});

test('repo resume, archive, unarchive and delete need a repo, and delete of a live repo goes ahead', async () => {
  for (const sub of ['doctor', 'resume', 'drain', 'archive', 'unarchive', 'delete'])
    assert.match((await run('repo', sub)).err, /usage: agentdeck repo/);
  assert.equal((await run('repo', 'resume', 'alpha')).out, 'alpha: resumed');
  assert.match((await run('repo', 'drain', 'alpha')).out, /^alpha: draining: no new task starts/);
  assert.match((await run('status')).out, /^repo {7}alpha DRAINING/m);
  assert.equal((await run('repo', 'resume', 'alpha')).out, 'alpha: resumed');
  assert.equal((await run('repo', 'archive', 'alpha')).out, 'alpha: archived');
  assert.match((await run('repo', 'ls', '--archived')).out, /^alpha/);
  assert.equal((await run('repo', 'unarchive', 'alpha')).out, 'alpha: unarchived');
  assert.match((await run('repo', 'bogus')).err, /unknown repo command: bogus/);
});

test('propose needs a repo, and archiving then deleting with --yes removes it with a count of what went', async () => {
  assert.match((await run('propose')).err, /usage: agentdeck propose <repo>/);
  await run('repo', 'archive', 'alpha');
  const gone = await run('repo', 'delete', 'alpha', '--yes');
  assert.match(gone.out, /alpha: will delete 0 tasks, 0 runs and 0 worktrees/);
  assert.match(gone.out, /alpha: deleted/);
  assert.equal((await run('repo', 'ls')).out, '');
});
