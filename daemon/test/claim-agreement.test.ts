// claimNextTask's SQL and the domain's startWait must agree on which queued task starts next.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.AGENTDECK_HOME = mkdtempSync(join(tmpdir(), 'agentdeck-claim-'));
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { startWaits } = await import('../src/application/queue.ts');

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
        const t = db.addTask({ repo_id, title: 't', prompt: 'p', priority, after_task });
        assert.equal(t.status, 'queued');
      }

  let claimed = 0;
  for (;;) {
    const waitOf = startWaits(db);
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
