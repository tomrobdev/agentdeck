// A running sync is recorded in the database, so the CLI sees what the daemon is doing: retry, install-needs and
// worktree removal refuse while a task syncs, and a crash or a throw never leaves the marker behind.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-sync-marker-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('./open-db.ts');
const { installNeeds, removeTaskWorktree, retryTask, syncNow } = await import('../src/application/actions.ts');
const { isSyncing, markSyncing } = await import('../src/application/work/checkout-locks.ts');
const { doneTask } = await import('./fixtures.ts');

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
  db.setSyncing(done.id, true); // what the daemon wrote; this "process" only reads it
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
  retryTask(db, done.id); // no longer refused
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

  // The same through syncTask: the repo is not a git repo, so the worktree step throws.
  await assert.rejects(syncNow(db, t.id));
  assert.ok(!isSyncing(db, t.id));
});
