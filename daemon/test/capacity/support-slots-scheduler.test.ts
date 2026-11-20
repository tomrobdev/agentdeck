// The scheduler starts a review run in a support slot while a task fills the one work slot, and with no support slot it waits.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-support-slots-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('#db/index.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { status, updateRepo, updateSettings } = await import('#application/actions.ts');
const { testApp, waitFor } = await import('#test/fixtures/fixtures.ts');
const { fakeCodeHost } = await import('#test/fixtures/fakes.ts');

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

let setups = 0;
async function busyWorkSlotAndReviewDue(supportSlots: number) {
  const n = ++setups;
  const db = testApp(openDb(join(home, `test-${n}.db`)), { codeHost: fakeCodeHost() });
  updateSettings(db, { max_concurrent: 1, support_slots: supportSlots });
  const dir = join(home, `demo-${n}`);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), 'A demo.\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  const repo = db.addRepo({ name: `demo-${n}`, path: dir, base_branch: 'main' });
  updateRepo(db, repo.name, { pr_mode: 'draft', auto_review: false });
  const done = db.addTask({ repo_id: repo.id, title: 'done', prompt: 'FAKE_DONE write the output' });
  await new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
  assert.equal(db.getTask(done.id)?.pr?.state, 'open');
  updateRepo(db, repo.name, { auto_review: true });
  const busy = db.addTask({ repo_id: repo.id, title: 'busy', prompt: 'FAKE_HANG' });
  db.setPaused(false);
  const scheduler = new Scheduler(db, { tickMs: 50, autoPropose: false, log: () => {} });
  const running = scheduler.run();
  await waitFor(() => db.getTask(busy.id)?.status === 'running', { what: 'the busy task to take the work slot' });
  const reviews = () => db.runsForTask(done.id).filter((r) => r.kind === 'review');
  const stop = async () => {
    scheduler.stop();
    await running;
    await waitFor(() => reviews().every((r) => r.ended_at), { timeoutMs: 10_000, what: 'the review run to end' });
    db.close();
  };
  return { db, reviews, stop };
}

test('with the one work slot busy, a done task due a review gets its review run in the support slot', async () => {
  const { db, reviews, stop } = await busyWorkSlotAndReviewDue(1);
  try {
    await waitFor(() => reviews().length > 0, { what: 'the review run to start' });
    assert.equal(status(db).running, 1, 'the task still has the work slot');
    assert.match(status(db).headline.slots ?? '', /^1\/1 slots/);
  } finally {
    await stop();
  }
});

test('with support_slots 0, the review run waits for the work slot', async () => {
  const { db, reviews, stop } = await busyWorkSlotAndReviewDue(0);
  try {
    await sleep(1_000);
    assert.equal(reviews().length, 0);
    assert.equal(status(db).headline.slots, '1/1 slots');
  } finally {
    await stop();
  }
});
