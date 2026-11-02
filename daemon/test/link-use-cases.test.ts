// Linking and unlinking, adding with links, the merge gate for after links and the one warning for a stuck chain.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-linkuse-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { ActionError, addTask, linkTasks, unlinkTasks, taskDetail, cancelTask, deleteRepo } = await import('../src/application/actions.ts');
const { doneTask, failedTask, queuedTask, runningTask, settlePr } = await import('./fixtures.ts');
const { landsAfter, warnStuckDependents } = await import('../src/application/task/dependencies.ts');
const { mergeCheck } = await import('../src/domain/pull-request/merge.ts');
const { autoMergeCheck } = await import('../src/domain/pull-request/auto-merge.ts');

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  const add = () => db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  return { db, repo, add };
}

const pr = {
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 1,
  files: 1,
  additions: 1,
  deletions: 0,
  checks: { total: 1, failing: 0, pending: 0 },
  paths: ['a.ts'],
  labels: ['agentdeck:auto-merge'],
};

test('addTask takes builds_on and after as id lists, and refuses a missing task without naming a flag', async () => {
  const { db, add } = setup();
  const [a, b, c] = [add(), add(), add()];
  const t = await addTask(db, { repo: 'demo', prompt: 'x', builds_on: [a.id, b.id], after: [c.id] });
  assert.deepEqual(
    db.linksOf(t.id).map((l) => [l.on, l.kind]),
    [
      [a.id, 'builds_on'],
      [b.id, 'builds_on'],
      [c.id, 'after'],
    ],
  );
  const view = await taskDetail(db, t.id);
  assert.deepEqual(
    view.links.map((l) => [l.on, l.kind, l.state]),
    [
      [a.id, 'builds_on', 'waiting'],
      [b.id, 'builds_on', 'waiting'],
      [c.id, 'after', 'unlanded'],
    ],
  );
  // The view names every task it builds on that is still on its way.
  assert.deepEqual(view.waiting, { on: [a.id, b.id], stuck: null });
  assert.deepEqual((await taskDetail(db, c.id)).dependents, [{ id: t.id, kind: 'after' }]);
  await assert.rejects(() => addTask(db, { repo: 'demo', prompt: 'x', after: [999] }), /^Error: can't land after #999: no such task$/);
  await assert.rejects(() => addTask(db, { repo: 'demo', prompt: 'x', builds_on: [999] }), /^Error: can't build on #999: no such task$/);
  await assert.rejects(() => addTask(db, { repo: 'demo', prompt: 'x', builds_on: [a.id], after: [a.id] }), ActionError);
  db.close();
});

test('addTask with propose files a proposal that keeps its links until it is approved', async () => {
  const { db, add } = setup();
  const a = add();
  const t = await addTask(db, { repo: 'demo', prompt: 'x', builds_on: [a.id], propose: true });
  assert.equal(t.status, 'proposed');
  assert.equal(t.source, 'manual');
  assert.equal(db.applyEvent(t.id, { type: 'approve' })?.status, 'queued');
  assert.deepEqual(
    (await taskDetail(db, t.id)).links.map((l) => [l.on, l.kind]),
    [[a.id, 'builds_on']],
  );
  await assert.rejects(
    () => addTask(db, { repo: 'demo', prompt: 'x', propose: 'yes' as unknown as boolean }),
    /propose must be true or false/,
  );
  db.close();
});

test('a task after another runs at once', async () => {
  const { db, add } = setup();
  const a = add();
  db.applyEvent(a.id, { type: 'claim' });
  const t = await addTask(db, { repo: 'demo', prompt: 'x', after: [a.id] });
  assert.equal(db.claimNextTask()!.id, t.id);
  db.close();
});

test('linkTasks and unlinkTasks; a self link, a repeat and a cycle are refused with a reason', () => {
  const { db, add } = setup();
  const [a, b, c] = [add(), add(), add()];
  linkTasks(db, b.id, { on: a.id, kind: 'builds_on' });
  linkTasks(db, c.id, { on: b.id, kind: 'after' });
  assert.throws(() => linkTasks(db, a.id, { on: a.id, kind: 'after' }), /can't depend on itself/);
  assert.throws(() => linkTasks(db, b.id, { on: a.id, kind: 'after' }), /already linked/);
  assert.throws(() => linkTasks(db, a.id, { on: c.id, kind: 'builds_on' }), /would make a cycle/);
  assert.throws(() => linkTasks(db, a.id, { on: 999, kind: 'after' }), /no task #999/);
  assert.throws(() => linkTasks(db, a.id, { on: b.id, kind: 'sideways' as never }), /kind must be/);
  unlinkTasks(db, b.id, a.id);
  assert.deepEqual(db.linksOf(b.id), []);
  assert.throws(() => unlinkTasks(db, b.id, a.id), /not linked/);
  linkTasks(db, a.id, { on: c.id, kind: 'builds_on' }); // no cycle any more
  db.close();
});

test('an after link holds the merge until the other lands, and is gone when the other is', () => {
  const { db, add } = setup();
  const [a, b] = [add(), add()];
  linkTasks(db, b.id, { on: a.id, kind: 'after' });
  assert.equal(landsAfter(db, b.id).length, 1);

  const held = mergeCheck({ pr_state: 'open', pr, tests_passed: 1, lands_after: landsAfter(db, b.id) });
  assert.deepEqual(held.problems, [`lands after #${a.id}: #${a.id} is not done yet`]);
  const repo = { test_cmd: 'x', auto_merge_max_lines: 400, auto_merge_skip: '' };
  const auto = autoMergeCheck({ pr_state: 'open', pr, tests_passed: 1, lands_after: landsAfter(db, b.id), repo, paused: null });
  assert.equal(auto.verdict, 'wait');

  db.applyEvent(a.id, { type: 'claim' });
  db.applyEvent(a.id, { type: 'finish', outcome: 'done' });
  assert.deepEqual(landsAfter(db, b.id), [], 'done in a repo without PRs has landed');
  assert.deepEqual(mergeCheck({ pr_state: 'open', pr, tests_passed: 1, lands_after: landsAfter(db, b.id) }).problems, []);
  assert.equal(autoMergeCheck({ pr_state: 'open', pr, tests_passed: 1, lands_after: [], repo, paused: null }).verdict, 'merge');
  db.close();
});

test('an after link frees the merge when the other is cancelled, a proposal rejected, or its PR closed', () => {
  const { db, repo, add } = setup();
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  const merges = (id: number) => mergeCheck({ pr_state: 'open', pr, tests_passed: 1, lands_after: landsAfter(db, id) }).problems;

  const [cancelled, b1] = [add(), add()];
  linkTasks(db, b1.id, { on: cancelled.id, kind: 'after' });
  assert.equal(merges(b1.id).length, 1);
  cancelTask(db, cancelled.id);
  assert.deepEqual(merges(b1.id), []);

  const proposal = db.addTask({ repo_id: repo.id, title: 'p', prompt: 'p', status: 'proposed' });
  const b2 = add();
  linkTasks(db, b2.id, { on: proposal.id, kind: 'after' });
  assert.ok(db.applyEvent(proposal.id, { type: 'reject' }));
  assert.deepEqual(merges(b2.id), []);

  const closed = doneTask(db, repo, { pr: 'open' });
  const b3 = add();
  linkTasks(db, b3.id, { on: closed.id, kind: 'after' });
  assert.deepEqual(merges(b3.id), [`lands after #${closed.id}: #${closed.id}'s PR is not merged yet`]);
  settlePr(db, closed.id, 'closed');
  assert.deepEqual(merges(b3.id), []);

  // A failed task can still land after a retry, so the merge waits.
  const failed = failedTask(db, repo);
  const b4 = add();
  linkTasks(db, b4.id, { on: failed.id, kind: 'after' });
  assert.deepEqual(merges(b4.id), [`lands after #${failed.id}: #${failed.id} failed`]);
  db.close();
});

test('a builds-on link is refused on a task that has started, and an after link is not', () => {
  const { db, repo, add } = setup();
  const a = add();
  const running = runningTask(db, repo);
  const done = doneTask(db, repo);
  assert.throws(() => linkTasks(db, done.id, { on: a.id, kind: 'builds_on' }), /has started already.*after link/);
  assert.throws(() => linkTasks(db, running.id, { on: a.id, kind: 'builds_on' }), /has started already/);
  linkTasks(db, done.id, { on: a.id, kind: 'after' });
  assert.deepEqual(db.linksOf(running.id), []);
  db.close();
});

test('a stuck notification leaves out a task stuck on a cancelled task between, and a chained reason says via', async () => {
  const { db, add } = setup();
  const [root, mid, cancelled, leaf, deep] = [add(), add(), add(), add(), add()];
  linkTasks(db, mid.id, { on: root.id, kind: 'builds_on' });
  linkTasks(db, deep.id, { on: mid.id, kind: 'builds_on' });
  linkTasks(db, cancelled.id, { on: root.id, kind: 'builds_on' });
  linkTasks(db, leaf.id, { on: cancelled.id, kind: 'builds_on' });
  cancelTask(db, cancelled.id);
  assert.ok(db.applyEvent(root.id, { type: 'claim' }));
  db.applyEvent(root.id, { type: 'finish', outcome: 'failed', retry: false }, { reason: 'broke' });
  warnStuckDependents(db, root.id);
  const notes = db.recentNotifications(50).filter((n) => n.kind === 'blocked' && n.task_id === root.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /^2 tasks can't start/);
  assert.match(notes[0].body, new RegExp(`#${mid.id} `));
  assert.match(notes[0].body, new RegExp(`#${deep.id} `));
  assert.doesNotMatch(notes[0].body, new RegExp(`#${leaf.id} `), 'retrying the root would not release it');
  assert.deepEqual((await taskDetail(db, deep.id)).waiting, {
    on: [root.id],
    stuck: `waits on #${root.id} (via #${mid.id}), which failed`,
  });
  assert.deepEqual((await taskDetail(db, leaf.id)).waiting, { on: [cancelled.id], stuck: `#${cancelled.id} was cancelled` });
  db.close();
});

test('merging one of two tasks a task builds on does not list it as unblocked', async () => {
  const { db, repo } = setup();
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  const [a, b] = [doneTask(db, repo, { pr: 'open' }), doneTask(db, repo, { pr: 'open' })];
  const both = await addTask(db, { repo: 'demo', prompt: 'x', builds_on: [a.id, b.id] });
  const onlyA = await addTask(db, { repo: 'demo', prompt: 'x', builds_on: [a.id] });
  assert.deepEqual((await taskDetail(db, a.id)).unblocks, [onlyA.id]);
  assert.deepEqual((await taskDetail(db, b.id)).unblocks, []);
  assert.deepEqual((await taskDetail(db, both.id)).waiting, { on: [a.id, b.id], stuck: null });
  settlePr(db, a.id, 'merged');
  assert.deepEqual((await taskDetail(db, b.id)).unblocks, [both.id], 'once a is merged, merging b lets it start');
  assert.deepEqual((await taskDetail(db, both.id)).waiting, { on: [b.id], stuck: null });
  db.close();
});

test("deleting a repo warns about another repo's queued task that built on its unmerged work", async () => {
  const { db, repo } = setup();
  const gone = db.addRepo({ name: 'gone', path: join(process.env.AGENTDECK_HOME!, 'no-such-repo'), base_branch: 'main' });
  const [unmerged, merged] = [queuedTask(db, gone), doneTask(db, gone, { pr: 'merged' })];
  const builder = await addTask(db, { repo: 'demo', prompt: 'x', title: 'builder', builds_on: [unmerged.id] });
  const fine = await addTask(db, { repo: 'demo', prompt: 'x', title: 'fine', builds_on: [merged.id] });
  db.setRepoArchived(gone.id, true);
  await deleteRepo(db, 'gone');
  const notes = db.recentNotifications(50).filter((n) => n.kind === 'blocked');
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /^1 task lost what it builds on: gone was deleted/);
  assert.match(notes[0].body, new RegExp(`#${builder.id} builder`));
  assert.doesNotMatch(notes[0].body, new RegExp(`#${fine.id} `));
  assert.equal(db.getTask(builder.id)!.repo_id, repo.id);
  db.close();
});

test('a failed task notifies once for every task it leaves stuck, two links down', async () => {
  const { db, add } = setup();
  const [root, mid, leaf, other] = [add(), add(), add(), add()];
  linkTasks(db, mid.id, { on: root.id, kind: 'builds_on' });
  linkTasks(db, leaf.id, { on: mid.id, kind: 'builds_on' });
  linkTasks(db, other.id, { on: root.id, kind: 'after' }); // after links never strand a start
  assert.ok(db.applyEvent(root.id, { type: 'claim' }));
  db.applyEvent(root.id, { type: 'finish', outcome: 'failed', retry: false }, { reason: 'broke' });
  warnStuckDependents(db, root.id);
  const notes = db.recentNotifications(50).filter((n) => n.kind === 'blocked' && n.task_id === root.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].title, /^2 tasks can't start/);
  assert.match(notes[0].body, new RegExp(`#${mid.id}`));
  assert.match(notes[0].body, new RegExp(`#${leaf.id}`));
  assert.doesNotMatch(notes[0].body, new RegExp(`#${other.id} `));
  assert.deepEqual((await taskDetail(db, leaf.id)).waiting?.on, [root.id]);
  cancelTask(db, leaf.id);
  db.close();
});
