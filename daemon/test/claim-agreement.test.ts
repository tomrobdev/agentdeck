// claimNextTask's SQL and the domain's startWait must agree on which queued task starts next.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-claim-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { startWaits } = await import('../src/application/scheduler/queue.ts');
const { dependencyOf, liveLinks } = await import('../src/application/task/dependencies.ts');

/** What each task waits for, from the queue state and links as they are now. */
function waits(db: ReturnType<typeof openDb>) {
  const waitOf = startWaits(db);
  const links = liveLinks(db);
  return (t: import('../src/domain/task/task.ts').Task) => waitOf(t, dependencyOf(t, links));
}

test('claimNextTask picks the first queued task, by priority then id, that has no startWait', () => {
  const db = openDb(':memory:');
  const open = db.addRepo({ name: 'open', path: '/tmp/open', base_branch: 'main' });
  const paused = db.addRepo({ name: 'paused', path: '/tmp/paused', base_branch: 'main' });
  db.updateRepo(open.id, { pr_mode: 'off' });
  db.setRepoPaused(paused.id, 'tests broke');
  db.setPaused(false);

  // One dependency per state: done is met, running is waiting, failed is stuck.
  const dependency = (finish?: 'done' | 'failed') => {
    const t = db.addTask({ repo_id: open.id, title: 'dep', prompt: 'p' });
    if (finish) {
      assert.ok(db.applyEvent(t.id, { type: 'claim' }));
      const event = finish === 'done' ? { type: 'finish', outcome: 'done' } : { type: 'finish', outcome: 'failed', retry: false };
      assert.ok(db.applyEvent(t.id, event as never, finish === 'failed' ? { reason: 'broke' } : undefined));
    }
    return t.id;
  };
  const deps = { none: null, met: dependency('done'), waiting: dependency(), stuck: dependency('failed') };
  assert.ok(db.applyEvent(deps.waiting, { type: 'claim' }));

  // Ids ascend across the combinations, so priority and id both matter for the order.
  for (const priority of [0, 5, 0, 5])
    for (const [repo_id] of [[open.id], [paused.id]])
      for (const after_task of Object.values(deps)) {
        const t = db.addTask({
          repo_id,
          title: 't',
          prompt: 'p',
          priority,
          links: after_task == null ? [] : [{ on: after_task, kind: 'builds_on' }],
        });
        assert.equal(t.status, 'queued');
      }

  let claimed = 0;
  for (;;) {
    const waitOf = waits(db);
    const queued = db.listTasks().filter((t) => t.status === 'queued');
    // The slot limit is the scheduler's to check, not the claim's.
    const expected = queued
      .filter((t) => {
        const wait = waitOf(t);
        return wait === null || wait.kind === 'slots';
      })
      .sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
    assert.equal(db.hasQueued(), expected !== undefined, `hasQueued after ${claimed} claims`);
    const picked = db.claimNextTask();
    assert.equal(picked?.id, expected?.id, `claim ${claimed}`);
    if (!picked) break;
    claimed++;
  }
  // Only the open repo's tasks with no dependency or a met one start (2 of the 4 dependency states), once per priority round.
  assert.equal(claimed, 2 * 4);
  db.close();
});

test('claimNextTask and startState agree for tasks with several links, of either kind', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'open', path: '/tmp/open', base_branch: 'main' });
  db.updateRepo(repo.id, { pr_mode: 'off' });
  db.setPaused(false);
  const make = (finish?: 'done' | 'failed' | 'running') => {
    const t = db.addTask({ repo_id: repo.id, title: 'dep', prompt: 'p' });
    if (finish) assert.ok(db.applyEvent(t.id, { type: 'claim' }));
    if (finish === 'done') assert.ok(db.applyEvent(t.id, { type: 'finish', outcome: 'done' }));
    if (finish === 'failed') assert.ok(db.applyEvent(t.id, { type: 'finish', outcome: 'failed', retry: false }, { reason: 'broke' }));
    return t.id;
  };
  const done = make('done');
  const running = make('running');
  const failed = make('failed');
  // Queued behind a failed task: stuck by spreading, though it is itself queued.
  const behind = db.addTask({ repo_id: repo.id, title: 'behind', prompt: 'p' });
  db.addLink({ task_id: behind.id, on: failed, kind: 'builds_on' });
  const ends = [done, running, failed, behind.id];
  const combos: [number[], number[]][] = [];
  for (const a of ends) {
    combos.push([[a], []], [[], [a]]);
    for (const b of ends) if (a !== b) combos.push([[a, b], []], [[a], [b]]);
  }
  for (const [builds, after] of combos) {
    const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
    for (const on of builds) db.addLink({ task_id: t.id, on, kind: 'builds_on' });
    for (const on of after) db.addLink({ task_id: t.id, on, kind: 'after' });
  }

  let claimed = 0;
  for (;;) {
    const waitOf = waits(db);
    const expected = db
      .listTasks()
      .filter((t) => t.status === 'queued' && [null, 'slots'].includes(waitOf(t)?.kind ?? null))
      .sort((a, b) => b.priority - a.priority || a.id - b.id)[0];
    const picked = db.claimNextTask();
    assert.equal(picked?.id, expected?.id, `claim ${claimed}`);
    if (!picked) break;
    claimed++;
  }
  assert.ok(claimed > 0);
  db.close();
});
