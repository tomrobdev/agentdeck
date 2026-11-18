// A run's bookkeeping when something goes wrong beside it: a store that throws, a log that cannot be written, a second run.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-run-end-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#test/fixtures/open-db.ts');
const { blockedTask, doneTask } = await import('#test/fixtures/fixtures.ts');
const { endTaskRun, openTaskRun } = await import('#application/runs/claude-run.ts');
const { runReview } = await import('#application/runs/review.ts');
const { settle } = await import('#application/landing/settle.ts');
const { removeTaskWorktree } = await import('#application/work/tasks.ts');
const { ActionError } = await import('#application/shared/input.ts');
const { LOG_DIR } = await import('#src/config.ts');

const scratch = () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  return { db, repo };
};

test('a run whose end could not be stored is ended by the next try, and frees its slot', async () => {
  const { db, repo } = scratch();
  const task = blockedTask(db, repo);
  const opened = openTaskRun(db, task, 'unblock');
  const finishRun = db.finishRun;
  let calls = 0;
  db.finishRun = (...args: Parameters<typeof finishRun>) => {
    if (!calls++) throw new Error('database is locked');
    return finishRun(...args);
  };
  await assert.rejects(endTaskRun(db, opened, 'done'), /database is locked/);
  assert.equal(db.slotsUsed(), 1, 'the run is still open');
  await endTaskRun(db, opened, 'failed', 'database is locked');
  const run = db.runsForTask(task.id).at(-1);
  assert.equal(run?.outcome, 'failed');
  assert.ok(run?.ended_at);
  assert.equal(db.slotsUsed(), 0);
  await endTaskRun(db, opened, 'done');
  assert.equal(db.runsForTask(task.id).at(-1)?.outcome, 'failed', 'an ended run is not ended twice');
  db.close();
});

test('a log that stops taking writes does not bring the process down, and the run still ends', async () => {
  const { db, repo } = scratch();
  const task = blockedTask(db, repo);
  const opened = openTaskRun(db, task, 'unblock');
  opened.log.destroy(new Error('ENOSPC: no space left on device'));
  db.runLog.event(opened.log, { type: 'agentdeck_error', text: 'after the disk filled' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await endTaskRun(db, opened, 'failed', 'the log could not be written');
  assert.equal(db.runsForTask(task.id).at(-1)?.outcome, 'failed');
  db.close();
});

test('a log that cannot be opened fails the open before a run is recorded', () => {
  const { db, repo } = scratch();
  const task = blockedTask(db, repo);
  mkdirSync(LOG_DIR, { recursive: true });
  chmodSync(LOG_DIR, 0o555);
  try {
    assert.throws(() => openTaskRun(db, task, 'unblock'), /EACCES/);
  } finally {
    chmodSync(LOG_DIR, 0o755);
  }
  assert.deepEqual(db.runsForTask(task.id), []);
  assert.equal(db.slotsUsed(), 0);
  db.close();
});

test('a task sent back to work is not claimed while its resolve run is still going', async () => {
  const { db, repo } = scratch();
  const task = doneTask(db, repo, { pr: 'open', branch: 'agentdeck/t' });
  const resolve = db.startRun(task.id, task.attempts, '/tmp/resolve.jsonl', 'resolve');
  assert.equal((await settle(db, task.id, { type: 'review_retry' }, { reason: 'Review run: fix it' }))?.status, 'queued');
  assert.equal(db.hasQueued(), false);
  assert.equal(db.claimNextTask(), undefined, 'two runs would share the worktree');
  db.finishRun(resolve, { outcome: 'done' });
  assert.equal(db.claimNextTask()?.id, task.id);
  db.close();
});

test('a worktree is not removed under a run that is going in it', async () => {
  const { db, repo } = scratch();
  const task = blockedTask(db, repo);
  db.setCheckout(task.id, { branch: 'agentdeck/b', worktree: '/tmp/wt-b' });
  const unblock = db.startRun(task.id, task.attempts, '/tmp/unblock.jsonl', 'unblock');
  const removed: unknown[] = [];
  db.workspace = { ...db.workspace, removeCheckout: async (_repo, checkout) => void removed.push(checkout) };
  await assert.rejects(removeTaskWorktree(db, task.id), (err) => err instanceof ActionError && /has a run going/.test(err.message));
  assert.deepEqual(removed, []);
  assert.equal(db.getTask(task.id)?.checkout?.worktree, '/tmp/wt-b');
  db.finishRun(unblock, { outcome: 'done' });
  await removeTaskWorktree(db, task.id);
  assert.deepEqual(removed, [{ worktree: '/tmp/wt-b' }]);
  db.close();
});

test('a review run that answers after its task merged leaves the task merged', async () => {
  const { db, repo } = scratch();
  db.updateRepo(repo.id, { auto_review: true, pr_mode: 'ready' });
  const task = doneTask(db, repo, { pr: 'open', branch: 'agentdeck/t' });
  let cancelAsked: boolean | undefined;
  db.workspace = {
    ...db.workspace,
    prepareCheckout: async () => ({ path: '/tmp/wt', branch: 'agentdeck/t' }),
    rootInfo: async () => ({ files: [], scripts: [] }),
  } as typeof db.workspace;
  db.agent = {
    ...db.agent,
    run: async (spec) => {
      assert.ok(db.recordMerge(task.id, 'squash', 'merged by a person'));
      cancelAsked = spec.shouldCancel?.();
      const findings = [{ path: 'a.ts', line: 3, side: 'new', body: 'off by one', blocking: true }];
      return {
        result: { result: '', structured_output: { summary: 'Broken.', findings }, num_turns: 3 },
        exitCode: 0,
        rateLimitedUntil: undefined,
        cancelled: false,
        stderr: '',
        sessionId: 's',
      };
    },
  } as typeof db.agent;
  const report = await runReview(db, { task, head: 'h'.repeat(40), from: 'b'.repeat(40), diffHash: 'd1' });
  assert.equal(cancelAsked, true, 'the run is asked to stop once the task merged');
  assert.equal(report.outcome, 'stale');
  const now = db.getTask(task.id);
  assert.equal(now?.status, 'done');
  assert.equal(now?.pr?.state, 'merged');
  assert.equal(
    db.eventsForTask(task.id).some((e) => e.type === 'review_retry'),
    false,
  );
  assert.equal(db.claimNextTask(), undefined);
  db.close();
});
