import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BranchPr } from '../../../src/domain/landing/index.ts';
import type { TaskId } from '../../../src/domain/shared/id.ts';
import { fakeCodeHost } from '../../fixtures/fakes.ts';
import { testApp } from '../../fixtures/fixtures.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-existing-pr-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../../../src/db/index.ts');
const { followUpPending, settle } = await import('../../../src/application/landing/settle.ts');
const { existingPr, isPrExistsError, parseBranchPrs } = await import('../../../src/domain/landing/index.ts');
const { prEventsOf } = await import('../../../src/domain/work/index.ts');

const EXISTS = 'a pull request for branch "agentdeck/task-1" into branch "main" already exists: https://github.com/o/r/pull/41';
const open = (n: number): BranchPr => ({ url: `https://github.com/o/r/pull/${n}`, state: 'open' });
const merged = (n: number): BranchPr => ({ url: `https://github.com/o/r/pull/${n}`, state: 'merged' });
const closed = (n: number): BranchPr => ({ url: `https://github.com/o/r/pull/${n}`, state: 'closed' });

test('isPrExistsError: only gh refusing a second PR for the branch', () => {
  const cases: [string, boolean][] = [
    [EXISTS, true],
    ['A pull request for branch "x" into branch "main" already exists:', true],
    ['could not find any commits between main and agentdeck/task-1', false],
    ['gh timed out after 60s', false],
    ["pull request create failed: GraphQL: Head sha can't be blank", false],
  ];
  for (const [error, expected] of cases) assert.equal(isPrExistsError(error), expected, error);
});

test('parseBranchPrs reads gh pr list, leaving out what it cannot name', () => {
  const json = JSON.stringify([
    { url: 'https://github.com/o/r/pull/41', state: 'OPEN' },
    { url: 'https://github.com/o/r/pull/30', state: 'MERGED' },
    { url: 'https://github.com/o/r/pull/20', state: 'CLOSED' },
    { url: '', state: 'OPEN' },
    { url: 'https://github.com/o/r/pull/10', state: 'DRAFTY' },
    null,
  ]);
  assert.deepEqual(parseBranchPrs(json), [open(41), merged(30), closed(20)]);
  assert.deepEqual(parseBranchPrs('[]'), []);
  assert.throws(() => parseBranchPrs('{}'), /not answer with a list/);
});

test('existingPr: the open one, else the newest; none for a branch without PRs', () => {
  const cases: [string, BranchPr[], BranchPr | null][] = [
    ['an open PR behind a merged one', [merged(30), open(41)], open(41)],
    ['only older PRs: the newest', [closed(20), merged(10)], closed(20)],
    ['none', [], null],
  ];
  for (const [name, prs, expected] of cases) assert.deepEqual(existingPr(prs), expected, name);
});

test('prEventsOf: an open PR is opened; one no longer open is opened, then seen as it is', () => {
  const cases: [BranchPr, unknown[]][] = [
    [open(41), [{ type: 'opened', url: open(41).url }]],
    [
      merged(30),
      [
        { type: 'opened', url: merged(30).url },
        { type: 'seen', state: 'merged' },
      ],
    ],
    [
      closed(20),
      [
        { type: 'opened', url: closed(20).url },
        { type: 'seen', state: 'closed' },
      ],
    ],
  ];
  for (const [pr, expected] of cases) assert.deepEqual(prEventsOf(pr), expected, pr.state);
});

function setup() {
  const codeHost = fakeCodeHost();
  const db = testApp(openDb(':memory:'), { codeHost });
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  const running = () => {
    const task = db.addTask({ repo_id: repo.id, title: 'work', prompt: 'p' });
    assert.equal(db.claimNextTask()?.id, task.id);
    const branch = `agentdeck/task-${task.id}`;
    db.setCheckout(task.id, { branch });
    return { task, branch };
  };
  const finishedDone = () => {
    const t = running();
    assert.ok(db.applyEvent(t.task.id, { type: 'finish', outcome: 'done' }));
    return t;
  };
  const notes = (id: TaskId) => db.recentNotifications(50).filter((n) => n.task_id === id);
  const prRows = (id: TaskId) =>
    db
      .eventsForTask(id)
      .filter((e) => e.type === 'pr')
      .map((e) => e.reason);
  return { db, codeHost, running, finishedDone, notes, prRows };
}

test('a crash after gh opened the PR: on restart gh refuses a second one, and the PR GitHub has is recorded open', async () => {
  const { db, codeHost, finishedDone, notes, prRows } = setup();
  const { task, branch } = finishedDone();
  codeHost.branchPrs[branch] = [open(41)];
  codeHost.createPr = async () => {
    throw new Error(EXISTS);
  };
  assert.equal(await followUpPending(db), 1);
  const pr = db.getTask(task.id)!.pr;
  assert.equal(pr?.state, 'open');
  assert.equal(pr?.url, open(41).url);
  assert.deepEqual(prRows(task.id), [`opened ${open(41).url}`], 'no failure in its history');
  assert.equal(notes(task.id).length, 1);
  assert.equal(notes(task.id)[0].kind, 'done');
  assert.match(notes(task.id)[0].body, /PR: https:\/\/github\.com\/o\/r\/pull\/41$/);
  assert.doesNotMatch(notes(task.id)[0].body, /Could not open/);
  assert.deepEqual(db.failedPrTasks(), []);
  db.close();
});

test('a PR GitHub has that was merged since is recorded with its url, merged', async () => {
  const { db, codeHost, finishedDone, prRows } = setup();
  const { task, branch } = finishedDone();
  codeHost.branchPrs[branch] = [merged(30)];
  codeHost.createPr = async () => {
    throw new Error(EXISTS);
  };
  await followUpPending(db);
  const pr = db.getTask(task.id)!.pr;
  assert.equal(pr?.state, 'merged');
  assert.equal(pr?.url, merged(30).url);
  assert.deepEqual(prRows(task.id), [`opened ${merged(30).url}`, 'PR is merged']);
  db.close();
});

test('gh refusing for another reason, or naming no PR the list finds, is still a failure', async () => {
  const { db, codeHost, finishedDone } = setup();
  const other = finishedDone();
  codeHost.createPr = async () => {
    throw new Error('could not find any commits between main and the branch');
  };
  await followUpPending(db);
  assert.equal(db.getTask(other.task.id)!.pr?.state, 'failed');

  const unlisted = finishedDone();
  codeHost.createPr = async () => {
    throw new Error(EXISTS);
  };
  codeHost.prsForBranch = async () => {
    throw new Error('gh: network down');
  };
  await followUpPending(db);
  const pr = db.getTask(unlisted.task.id)!.pr;
  assert.equal(pr?.state, 'failed');
  assert.match(db.eventsForTask(unlisted.task.id).at(-1)!.reason!, /already exists/, "gh's own error is the one recorded");
  db.close();
});

test('a retry between the push and gh pr create: the PR is recorded on the task, and its next finish keeps it', async () => {
  const { db, codeHost, running, notes } = setup();
  const { task } = running();
  let release!: () => void;
  const pushed = new Promise<void>((r) => (release = r));
  codeHost.push = () => pushed;
  const settling = settle(db, task.id, { type: 'finish', outcome: 'done' });
  assert.ok(db.applyEvent(task.id, { type: 'retry' }, { reason: 'one more thing' }));
  release();
  await settling;
  assert.equal(codeHost.created.length, 1);
  const retried = db.getTask(task.id)!;
  assert.equal(retried.status, 'queued');
  assert.equal(retried.pr?.state, 'open', 'GitHub has the PR whatever the task did meanwhile');
  assert.equal(retried.pr?.url, 'https://example.test/pull/1');
  assert.equal(notes(task.id).length, 0, 'a task that moved on is not told about as done');

  codeHost.push = async () => {};
  assert.equal(db.claimNextTask()?.id, task.id);
  const done = await settle(db, task.id, { type: 'finish', outcome: 'done' });
  assert.equal(done?.pr?.url, 'https://example.test/pull/1');
  assert.equal(codeHost.created.length, 1);
  assert.match(notes(task.id)[0].body, /PR: https:\/\/example\.test\/pull\/1/);
  db.close();
});
