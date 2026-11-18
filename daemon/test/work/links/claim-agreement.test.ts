// claimNextTask's SQL and the domain's startWait must agree on which queued task starts next.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TaskId } from '#domain/shared/id.ts';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-claim-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { startWaits } = await import('#application/capacity/queue.ts');
const { liveLinks } = await import('#application/work/dependencies.ts');
const { startState } = await import('#domain/work/links/link.ts');

function waits(db: ReturnType<typeof openDb>) {
  const waitOf = startWaits(db);
  const links = liveLinks(db);
  return (t: import('#domain/work/task/task.ts').Task) => waitOf(t, startState(t, links.linksOf(t.id), links.target));
}

test('claimNextTask picks the first queued task, by priority then id, that has no startWait', () => {
  const db = openDb(':memory:');
  const open = db.addRepo({ name: 'open', path: '/tmp/open', base_branch: 'main' });
  const paused = db.addRepo({ name: 'paused', path: '/tmp/paused', base_branch: 'main' });
  db.updateRepo(open.id, { pr_mode: 'off' });
  db.setRepoPaused(paused.id, 'tests broke');
  db.setPaused(false);

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
  assert.equal(claimed, 2 * 4);
  db.close();
});

test('claimNextTask and startWait agree on a task that builds on a retried task whose old PR merged, at every step', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'prs', path: '/tmp/prs', base_branch: 'main' });
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  db.setPaused(false);
  const dep = db.addTask({ repo_id: repo.id, title: 'dep', prompt: 'p' });
  assert.ok(db.applyEvent(dep.id, { type: 'claim' }));
  assert.ok(db.applyEvent(dep.id, { type: 'finish', outcome: 'done' }));
  assert.ok(db.recordPr(dep.id, { type: 'opened', url: 'https://x/pull/1' }));
  assert.ok(db.recordPr(dep.id, { type: 'seen', state: 'merged' }));
  assert.ok(db.applyEvent(dep.id, { type: 'retry' }));
  assert.ok(db.applyEvent(dep.id, { type: 'claim' }));
  const later = db.addTask({ repo_id: repo.id, title: 'later', prompt: 'p', links: [{ on: dep.id, kind: 'builds_on' }] });

  const starts = (step: string): boolean => {
    const wait = waits(db)(db.getTask(later.id)!);
    const domain = wait === null || wait.kind === 'slots';
    assert.equal(db.hasQueued(), domain, step);
    return domain;
  };
  assert.equal(starts('the retried task is running'), false);
  assert.ok(db.applyEvent(dep.id, { type: 'finish', outcome: 'done' }));
  assert.equal(starts('done again, its new PR not opened yet'), false);
  db.updateRepo(repo.id, { pr_mode: 'off' });
  assert.equal(starts('done in a repo with pr_mode off'), true);
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  assert.ok(db.recordPr(dep.id, { type: 'opened', url: 'https://x/pull/2' }));
  assert.equal(starts('the new PR is open'), false);
  assert.ok(db.recordPr(dep.id, { type: 'seen', state: 'merged' }));
  assert.equal(starts('the new PR merged'), true);
  assert.equal(db.claimNextTask()?.id, later.id);
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
  const behind = db.addTask({ repo_id: repo.id, title: 'behind', prompt: 'p' });
  db.addLink({ task_id: behind.id, on: failed, kind: 'builds_on' });
  const ends = [done, running, failed, behind.id];
  const combos: [TaskId[], TaskId[]][] = [];
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

test('claimNextTask and startWait agree on a task an unblock run keeps waiting, before, during and after the run', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'unblock', path: '/tmp/unblock', base_branch: 'main' });
  db.setPaused(false);
  const held = db.addTask({ repo_id: repo.id, title: 'held', prompt: 'p', priority: 5 });
  assert.ok(db.applyEvent(held.id, { type: 'claim' }));
  assert.ok(db.applyEvent(held.id, { type: 'finish', outcome: 'blocked' }, { reason: 'stuck' }));
  const run = db.startRun(held.id, 1, '/tmp/unblock.log', 'unblock');
  assert.ok(db.applyEvent(held.id, { type: 'retry' }));
  const other = db.addTask({ repo_id: repo.id, title: 'other', prompt: 'p' });

  const heldWait = () => waits(db)(db.getTask(held.id)!);
  assert.deepEqual(heldWait(), { kind: 'unblocking' }, 'the unblock run is going');
  assert.equal(db.hasQueued(), true, 'other may start');
  assert.equal(db.claimNextTask()?.id, other.id, 'the claim passes over the task the unblock run keeps waiting');
  assert.equal(db.claimNextTask(), undefined);
  assert.equal(db.hasQueued(), false);

  db.finishRun(run, { outcome: 'cancelled' });
  const wait = heldWait();
  assert.ok(wait === null || wait.kind === 'slots', 'the run stopped: nothing but a slot to wait for');
  assert.equal(db.hasQueued(), true);
  assert.equal(db.claimNextTask()?.id, held.id);
  db.close();
});
