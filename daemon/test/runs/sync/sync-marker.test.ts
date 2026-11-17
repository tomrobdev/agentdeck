import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-sync-marker-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { installNeeds, removeTaskWorktree, retryTask, syncNow } = await import('#application/actions.ts');
const { isSyncing, markSyncing } = await import('#application/work/checkout-locks.ts');
const { advance, doneTask } = await import('#test/fixtures/fixtures.ts');
const { TASK_STATUSES, WORKTREE_REMOVABLE_STATUSES } = await import('#domain/work/index.ts');
type TaskStatus = (typeof TASK_STATUSES)[number];

function setup() {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'demo', path: '/tmp/agentdeck-no-such-repo', base_branch: 'main', toolchain: 'pnpm' });
  return { db, repo };
}

test('retry, install-needs and worktree removal refuse while another process has a sync marked', async () => {
  const { db, repo } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-sync-marker-wt-'));

  const done = doneTask(db, repo, { title: 'done' });
  db.setCheckout(done.id, { worktree: dir });
  db.setSyncing(done.id, true);
  assert.ok(isSyncing(db, done.id));
  assert.throws(() => retryTask(db, done.id), /syncing/);
  await assert.rejects(removeTaskWorktree(db, done.id), /syncing/);
  assert.equal(db.getTask(done.id)!.checkout?.worktree, dir, 'the worktree is still recorded');

  const blocked = db.addTask({ repo_id: repo.id, title: 'blocked', prompt: 'p' });
  db.setCheckout(blocked.id, { worktree: dir });
  db.claimNextTask();
  db.applyEvent(
    blocked.id,
    { type: 'finish', outcome: 'blocked', environment: true },
    { reason: 'NEEDS', needs: { kind: 'deps', items: ['left-pad'] } },
  );
  db.setSyncing(blocked.id, true);
  await assert.rejects(installNeeds(db, blocked.id), /syncing/);
  assert.equal(db.getTask(blocked.id)!.status, 'blocked');

  db.setSyncing(done.id, false);
  assert.ok(!isSyncing(db, done.id));
  retryTask(db, done.id);
  assert.equal(db.getTask(done.id)!.status, 'queued');
});

test('recoverOrphans clears a marker left by a daemon that died mid-sync', () => {
  const { db, repo } = setup();
  const t = doneTask(db, repo, { title: 'done' });
  db.setSyncing(t.id, true);
  db.recoverOrphans();
  assert.equal(db.getTask(t.id)!.checkout?.syncing_since ?? null, null);
  assert.ok(!isSyncing(db, t.id));
});

test('a sync that throws still clears its marker', async () => {
  const { db, repo } = setup();
  const t = doneTask(db, repo, { title: 'done', branch: 'agentdeck/task-x' });
  let seen: boolean | undefined;
  await assert.rejects(
    markSyncing(db, t.id, async () => {
      seen = isSyncing(db, t.id);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(seen, true, 'the marker was set while it ran');
  assert.ok(!isSyncing(db, t.id));

  await assert.rejects(syncNow(db, t.id));
  assert.ok(!isSyncing(db, t.id));
});

test('worktree removal refuses a task in any status but WORKTREE_REMOVABLE_STATUSES, saying why', async () => {
  const { db, repo } = setup();
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-sync-marker-rm-'));
  const refusals: Partial<Record<TaskStatus, RegExp>> = {
    queued: /: task is queued$/,
    running: /: task is running$/,
    cancel_requested: /: task is running$/,
  };
  for (const status of TASK_STATUSES) {
    const added = db.addTask({ repo_id: repo.id, title: status, prompt: 'p', status: status === 'proposed' ? 'proposed' : 'queued' });
    const t = status === 'proposed' ? added : advance(db, added.id, status);
    assert.equal(t.status, status);
    const refused = refusals[status];
    assert.equal(WORKTREE_REMOVABLE_STATUSES.includes(status), !refused, status);
    await assert.rejects(removeTaskWorktree(db, t.id), refused ?? /: task has no worktree$/, status);
    db.setCheckout(t.id, { worktree: dir });
    if (refused) await assert.rejects(removeTaskWorktree(db, t.id), refused, status);
  }
});
