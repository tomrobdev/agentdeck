// Linking and unlinking, adding with links, the merge gate for after links and the one warning for a stuck chain.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-linkuse-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { ActionError, addTask, linkTasks, unlinkTasks, taskDetail, cancelTask } = await import('../src/application/actions.ts');
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

test('addTask takes builds_on and after as lists or comma text, and refuses a missing task', async () => {
  const { db, add } = setup();
  const [a, b, c] = [add(), add(), add()];
  const t = await addTask(db, { repo: 'demo', prompt: 'x', builds_on: `${a.id},${b.id}`, after: [c.id] });
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
      [c.id, 'after', 'holding'],
    ],
  );
  assert.deepEqual((await taskDetail(db, c.id)).dependents, [{ id: t.id, kind: 'after' }]);
  await assert.rejects(() => addTask(db, { repo: 'demo', prompt: 'x', after: [999] }), /--after: no task #999/);
  await assert.rejects(() => addTask(db, { repo: 'demo', prompt: 'x', builds_on: [999] }), /--builds-on: no task #999/);
  await assert.rejects(() => addTask(db, { repo: 'demo', prompt: 'x', builds_on: [a.id], after: [a.id] }), ActionError);
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
  assert.equal((await taskDetail(db, leaf.id)).waiting?.on, root.id);
  cancelTask(db, leaf.id);
  db.close();
});
