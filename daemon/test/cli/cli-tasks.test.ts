// The task commands run in process: adding, listing, showing, linking, editing and moving tasks, with their usage and refusals.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { READY_PR, fakeCodeHost } from '../fixtures/fakes.ts';
import { blockedTask, doneTask, failedTask, queuedTask } from '../fixtures/fixtures.ts';
import { scratchCli, scratchRepo } from './cli-run.ts';

const codeHost = fakeCodeHost();
const { db, run } = scratchCli({ codeHost });
const repo = await (await import('../../src/application/actions.ts')).addRepo(db, { path: scratchRepo('beta'), test: 'true' });

const PLAN =
  '<html data-agentdeck-plan="1"><head><title>P</title></head><body><section data-plan-step id="s1" data-status="todo"><h2>One</h2></section></body></html>';
const planFile = join(mkdtempSync(join(tmpdir(), 'agentdeck-plan-')), 'plan.html');
writeFileSync(planFile, PLAN);

test('add queues a task, or proposes one with --propose, and says what it built on and which plan it follows', async () => {
  assert.equal((await run('repo', 'set', 'beta', 'pr_mode', 'ready')).out, 'beta: pr_mode ready');
  const first = await run(
    'add',
    '--repo',
    'beta',
    '--title',
    'First',
    '-p',
    '3',
    '-m',
    'haiku',
    '--max-turns',
    '10',
    '--attempts',
    '2',
    'Do',
    'the',
    'first',
  );
  assert.match(first.out, /queued task #1 on beta \(haiku, 10 turns max\)/);
  const second = await run('add', '-r', 'beta', '--builds-on', '1', '--plan', planFile, '--steps', 's1', 'Second one.');
  assert.equal(second.err, '');
  assert.match(second.out, /queued task #2 on beta .*builds on #1/);
  assert.match(second.out, /plan {5}2-p\.html/);
  const proposed = await run('add', '--repo', 'beta', '--propose', 'Proposal text');
  assert.match(proposed.out, /proposed task #3/);
  assert.match(proposed.out, /note: it waits for `agentdeck approve 3`/);
  assert.match((await run('add', '--repo', 'beta', '--builds-on', 'x', 'Bad')).err, /--builds-on takes task ids/);
  assert.match((await run('add', '--repo', 'beta', '--plan', '/no/such/plan.html', 'Bad')).err, /can't read \/no\/such\/plan\.html/);
});

test('ls lists tasks, filters by status, repo and text, sorts, and says when nothing matches', async () => {
  const all = await run('ls');
  assert.match(all.out, /#3 .*proposed.*Proposal text/);
  assert.equal(all.out.split('\n').length, 3);
  assert.match((await run('ls', '--status', 'proposed')).out, /^\? #3 .*\n1 of 3 tasks$/);
  assert.match((await run('ls', '-s', 'queued', '--sort', 'oldest', '--repo', 'beta')).out, /#1 .*\n.*#2 /);
  assert.match((await run('ls', 'first')).out, /#1 .*First/);
  assert.equal((await run('ls', '--status', 'failed')).out, 'no matching tasks');
  assert.match((await run('ls', '--status', 'nope')).err, /unknown state "nope"/);
});

test('show prints a task with its model, links, plan and prompt, and a proposal with its check', async () => {
  const two = await run('show', '2');
  assert.match(two.out, /^· #2 /);
  assert.match(two.out, /model sonnet, attempts 0\/2, max turns \d+/);
  assert.match(two.out, /links {4}builds on #1 \(waiting\)/);
  assert.match(two.out, /plan {5}2-p\.html \(steps s1\)/);
  assert.match(two.out, /plan: P \(2-p\.html, 0\/1 steps\)/);
  assert.match((await run('show', '1')).out, /needed by #2 \(builds on it\)/);
  assert.match((await run('show', '3')).out, /Proposal text/);
  assert.equal((await run('show')).err, 'agentdeck: expected a task id');
});

test('link and unlink join and separate tasks, and refuse a wrong command line, a cycle and a task that started', async () => {
  const three = await run('add', '--repo', 'beta', 'Third');
  assert.match(three.out, /task #4/);
  assert.equal((await run('link', '4', '--after', '1')).out, '#4 lands after #1');
  assert.equal((await run('link', '4', '--builds-on', '2')).out, '#4 builds on #2');
  assert.match((await run('link', '4')).err, /usage: agentdeck link <id>/);
  assert.match((await run('link', '1', '--after', '4')).err, /cycle/);
  assert.equal((await run('unlink', '4', '1')).out, '#4 no longer depends on #1');
  assert.match((await run('unlink', '4')).err, /usage: agentdeck unlink/);
  const running = queuedTask(db, repo);
  db.applyEvent(running.id, { type: 'claim' });
  const late = await run('link', String(running.id), '--builds-on', '1');
  assert.match(late.err, new RegExp(`agentdeck link ${running.id} --after 1`));
});

test('edit changes a task and prints it with its model and attempts', async () => {
  const edited = await run(
    'edit',
    '1',
    '--title',
    'Renamed',
    '-p',
    '9',
    '-m',
    'opus',
    '--max-turns',
    '12',
    '--attempts',
    '4',
    '--prompt',
    'New prompt',
  );
  assert.match(edited.out, /#1 .*p9 .*Renamed/);
  assert.match(edited.out, /model opus, attempts 0\/4, max turns 12/);
  assert.match((await run('edit', '1', '--plan', '2')).out, /#1/);
  assert.match((await run('edit', '1', '--plan', '')).out, /#1/);
  assert.match((await run('edit', '1', '--plan', '#2')).out, /#1/);
  assert.match((await run('edit', '1', '--priority', '')).err, /priority/);
});

test('approve, reject, cancel, retry and done move a task and say so', async () => {
  assert.equal((await run('approve', '3')).out, 'queued #3');
  assert.match((await run('approve')).err, /usage: agentdeck approve <id>/);
  const spare = await run('add', '--repo', 'beta', '--propose', 'To reject');
  const spareId = /proposed task #(\d+)/.exec(spare.out)?.[1] ?? '';
  assert.match((await run('reject', spareId)).out, new RegExp(`rejected #${spareId}`));
  assert.equal((await run('cancel', '3')).out, 'cancelled #3');
  const failed = failedTask(db, repo);
  assert.equal((await run('retry', String(failed.id), '--note', 'try again')).out, `requeued #${failed.id}`);
  const blocked = blockedTask(db, repo);
  assert.equal((await run('done', String(blocked.id), '--note', 'by hand')).out, `marked #${blocked.id} done`);
});

test('show of a blocked task prints its needs and question, and of a done task its PR and checks', async () => {
  assert.equal((await run('merge', '--all')).out, 'no pull requests in review');
  const blocked = blockedTask(db, repo);
  const shown = await run('show', String(blocked.id));
  assert.match(shown.out, /^! #\d+ .*blocked.*— stuck/);
  const done = doneTask(db, repo, { pr: 'open', branch: 'agentdeck/x' });
  const view = await run('show', String(done.id));
  assert.match(view.out, /PR open: https:\/\/x\/pull\//);
  assert.match(view.out, /branch {3}agentdeck\/x/);
  assert.match((await run('ls', '--status', 'review')).out, new RegExp(`#${done.id} `));
});

test('merge of a conflicting PR records a merge request, says it is syncing and exits 0; with auto_resolve off it refuses', async () => {
  const conflicted = doneTask(db, repo, { pr: 'open', url: 'https://x/pull/conflict', branch: 'agentdeck/conflict' });
  codeHost.details['https://x/pull/conflict'] = { ...READY_PR, mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  const res = await run('merge', String(conflicted.id), '--yes');
  assert.equal(res.exit, null);
  assert.match(res.out, /^conflicts with main: syncing, it merges once the sync is clean and the tests pass$/m);
  assert.ok(db.getTask(conflicted.id)?.pr?.merge_request);
  assert.deepEqual(codeHost.merged, []);

  db.recordPr(conflicted.id, { type: 'closed' });
  const other = doneTask(db, repo, { pr: 'open', url: 'https://x/pull/conflict-off', branch: 'agentdeck/conflict-off' });
  codeHost.details['https://x/pull/conflict-off'] = { ...READY_PR, mergeable: 'CONFLICTING', merge_state: 'DIRTY' };
  await run('repo', 'set', 'beta', 'auto_resolve', 'off');
  const refused = await run('merge', String(other.id), '--yes');
  assert.equal(refused.exit, 1);
  assert.match(refused.out, /problem: the branch has conflicts with the base branch, and the repo has auto_resolve off/);
  await run('repo', 'set', 'beta', 'auto_resolve', 'on');
});

test('review says there are none, log and attach refuse what they cannot do, and attach stores a plan', async () => {
  assert.equal((await run('review', '1')).out, 'no reviews on #1');
  assert.match((await run('log', '999')).err, /no task #999/);
  assert.match((await run('log', '1')).err, /#1 has no runs yet/);
  assert.match((await run('attach', '1')).err, /usage: agentdeck attach <id> <plan file>/);
  assert.match((await run('attach', '1', planFile)).out, /^#1 plan: P \(1-p\.html, 0\/1 steps\)$/);
  assert.match((await run('attach', '1', '/no/such.html')).err, /can't read \/no\/such\.html/);
});

test('install-needs, open-pr, close-pr, fix-checks, merge and auto-merge refuse a task that cannot take them, and say how to use them', async () => {
  assert.match((await run('auto-merge', '1')).err, /usage: agentdeck auto-merge <id> on\|off\|repo/);
  assert.match((await run('auto-merge', '1', 'on')).out, /^#1: auto-merge on/);
  assert.match((await run('auto-merge', '1', 'repo')).out, /\(the repo's setting\)/);
  assert.match((await run('merge')).err, /expected a task id/);
  for (const cmd of ['open-pr', 'close-pr', 'fix-checks', 'install-needs', 'clean']) assert.equal((await run(cmd, '1')).exit, 1, cmd);
  assert.equal((await run('open-pr')).err, 'agentdeck: expected a task id');
});
