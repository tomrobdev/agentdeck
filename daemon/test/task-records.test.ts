// The task area review of 2026-11-02: editing a task's plan is guarded and clears only what it says, a plan attached to
// a done owner reaches a cut-off follower, and the store keeps runs, links and merge checks true.
import assert from 'node:assert/strict';
import type { TaskId } from '../src/domain/shared/id.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-records-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('./open-db.ts');
const { addTask, attachPlan, editTask, linkTasks, taskDetail, taskViews, unlinkTasks } = await import('../src/application/actions.ts');
const { editsSinceCutOff } = await import('../src/domain/runs/run.ts');
const { MAX_RESTARTS } = await import('../src/domain/work/lifecycle.ts');
const { advance, doneTask } = await import('./fixtures.ts');

type Db = ReturnType<typeof openDb>;

const plan = (title: string) => `<html data-agentdeck-plan="1"><head><title>${title}</title></head><body>
  <section data-plan-step id="a" data-status="todo"><h2>First</h2></section>
  <section data-plan-step id="b" data-status="todo"><h2>Second</h2></section>
</body></html>`;

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path: '/tmp/demo', base_branch: 'main' });
  return { db, repo };
}

test('clearing the plan of a task that owns one is refused, saying how to replace it', async () => {
  const { db } = setup();
  const t = await addTask(db, { repo: 'demo', prompt: 'p', plan_html: plan('Own'), plan_steps: 'a' });
  for (const plan_task of [null, '' as unknown as null]) {
    await assert.rejects(editTask(db, t.id, { plan_task }), /has a plan of its own.*--plan <file>.*--plan <task number>/);
  }
  const after = db.getTask(t.id)!;
  assert.equal(after.plan?.task, t.id, 'it still follows its own plan');
  assert.deepEqual(after.plan?.steps, ['a'], 'its steps are not widened to every step');
  await editTask(db, t.id, { plan_steps: 'b' });
  assert.deepEqual(db.getTask(t.id)!.plan?.steps, ['b'], '--steps still works');
});

test('a claim between the edit check and the save leaves the plan unchanged', async () => {
  const { db } = setup();
  const t = await addTask(db, { repo: 'demo', prompt: 'p', plan_html: plan('Old') });
  // The daemon claims the task while the edit checks the plan's followers, after editTask read the task as queued.
  const racing = new Proxy(db, {
    get(target, key: keyof Db) {
      if (key === 'planFollowers')
        return (id: TaskId) => {
          target.claimNextTask();
          return target.planFollowers(id);
        };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  await assert.rejects(editTask(racing, t.id, { plan_html: plan('New') }), /is running; only/);
  assert.equal(db.getTask(t.id)!.status, 'running');
  assert.equal(db.ownPlan(t.id)!.html, plan('Old'), 'the running task keeps the plan its run was given');
  assert.ok(!db.eventsForTask(t.id).some((e) => e.type === 'edit'), 'no edit is recorded');
});

test('a plan attached to a done owner makes a follower a restart cut off start afresh', () => {
  const { db, repo } = setup();
  const owner = db.addTask({ repo_id: repo.id, title: 'owner', prompt: 'p', own_plan: plan('Owner') });
  const follower = db.addTask({ repo_id: repo.id, title: 'follower', prompt: 'p', plan_task: owner.id });
  advance(db, owner.id, 'done');
  // The follower's run is cut off by a restart, with a session to resume.
  advance(db, follower.id, 'running');
  const run = db.startRun(follower.id, 1, '/tmp/log');
  db.setRunSession(run, 'cut-session');
  assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [] });
  // Claimed again, it carries the attempt the restart gave back: the worker would resume the session.
  assert.ok(db.applyEvent(follower.id, { type: 'claim' }));

  const edits = () =>
    editsSinceCutOff(db.getTask(follower.id)!, db.runsForTask(follower.id), {
      own: db.eventsForTask(follower.id),
      planOwner: db.eventsForTask(owner.id),
    });
  assert.deepEqual(edits(), []);
  attachPlan(db, owner.id, { html: plan('Owner, rewritten') });
  assert.equal(db.ownPlan(owner.id)!.html, plan('Owner, rewritten'));
  assert.deepEqual(edits(), ['plan'], 'the follower is told its plan changed');
});

test('a recovered task that fails or is cancelled has its runs end so; a requeued one keeps them interrupted', () => {
  const { db, repo } = setup();
  const add = (title: string) => db.addTask({ repo_id: repo.id, title, prompt: 'p' });
  const [requeued, failing, cancelling] = [add('requeued'), add('failing'), add('cancelling')];
  // Restarts already used up all but one of the failing task's chances.
  db.raw.prepare('UPDATE tasks SET restarts = ? WHERE id = ?').run(MAX_RESTARTS - 1, failing.id);
  for (const t of [requeued, failing, cancelling]) {
    advance(db, t.id, 'running');
    db.startRun(t.id, 1, `/tmp/${t.id}.log`);
  }
  db.applyEvent(cancelling.id, { type: 'cancel' });

  assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [failing.id] });
  const outcome = (id: TaskId) => db.runsForTask(id).map((r) => [r.outcome, r.ended_at !== null]);
  assert.deepEqual(outcome(requeued.id), [['interrupted', true]]);
  assert.deepEqual(outcome(failing.id), [['failed', true]]);
  assert.deepEqual(outcome(cancelling.id), [['cancelled', true]]);
  assert.equal(db.getTask(cancelling.id)!.status, 'cancelled');
});

test('link and unlink leave no stale after_task in the API', async () => {
  const { db, repo } = setup();
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  const a = db.addTask({ repo_id: repo.id, title: 'a', prompt: 'p' });
  const b = db.addTask({ repo_id: repo.id, title: 'b', prompt: 'p' });
  const t = await addTask(db, { repo: 'demo', prompt: 'x', builds_on: [a.id] });
  unlinkTasks(db, t.id, a.id);
  linkTasks(db, t.id, { on: b.id, kind: 'builds_on' });
  const detail = await taskDetail(db, t.id);
  assert.ok(!('after_task' in detail), 'the detail has no after_task');
  assert.deepEqual(
    detail.links.map((l) => l.on),
    [b.id],
  );
  for (const view of taskViews(db, { limit: 10 })) assert.ok(!('after_task' in view), `#${view.id} is listed without after_task`);
  assert.ok(!('after_task' in db.getTask(t.id)!), 'the store reads no after_task');
  const row = db.raw.prepare('SELECT after_task FROM tasks WHERE id = ?').get(t.id) as { after_task: number | null };
  assert.equal(row.after_task, null, 'nor writes it');
});

test('a legacy plan_path stays in its column, out of the store and the API', async () => {
  const { db, repo } = setup();
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  db.raw.prepare('UPDATE tasks SET plan_path = ? WHERE id = ?').run('docs/plans/old.html', t.id);
  assert.ok(!('plan_path' in db.getTask(t.id)!), 'the store reads no plan_path');
  assert.ok(!('plan_path' in db.listTaskSummaries({ limit: 10 })[0]), 'nor in a summary');
  assert.ok(!('plan_path' in (await taskDetail(db, t.id))), 'the detail has no plan_path');
  for (const view of taskViews(db, { limit: 10 })) assert.ok(!('plan_path' in view), `#${view.id} is listed without plan_path`);
});

test('a merge request check finished after a conflict blocked the task is dropped', () => {
  const { db, repo } = setup();
  const t = doneTask(db, repo, { pr: 'open' });
  assert.ok(db.requestMerge(t.id, 'squash'));
  assert.ok(db.setMergeRequestCheck(t.id, { verdict: 'wait', reasons: ['checks pending'] }));
  assert.ok(db.applyEvent(t.id, { type: 'conflict' }, { reason: 'conflict' }));

  assert.equal(db.setMergeRequestCheck(t.id, { verdict: 'merge', reasons: [] }), false);
  assert.equal(db.getTask(t.id)!.pr?.merge_request?.check?.verdict, 'wait', 'the blocked task keeps the check it had');
});
