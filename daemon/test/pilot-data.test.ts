// What the pilot scorecard needs: a history of usage readings, and a PR's checks once settled and at merge.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-pilot-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('../src/db/index.ts');
const { doneTask } = await import('./fixtures.ts');
const { github } = await import('../src/adapters/github.ts');
const { mergeTask } = await import('../src/application/pull-request/merge.ts');
const { refreshPrStates } = await import('../src/application/pull-request/refresh.ts');
type PrDetails = import('../src/domain/pull-request/merge.ts').PrDetails;

const db = openDb(join(home, 'test.db'));
after(() => db.close());

const dir = join(home, 'demo');
mkdirSync(dir, { recursive: true });
const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
sh('init', '-q', '-b', 'main');
sh('config', 'user.email', 'test@example.com');
sh('config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
sh('add', '-A');
sh('commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'true' });

test('a usage reading that changed appends a sample; an unchanged one does not', () => {
  db.recordUsageWindow('five_hour', 0.2, 1000, 'allowed');
  db.recordUsageWindow('five_hour', 0.2, 1000, 'allowed');
  assert.equal(db.usageSamples('five_hour').length, 1);

  db.recordUsageWindow('five_hour', 0.3, 1000, 'allowed');
  db.recordUsageWindow('five_hour', 0.3, 1000, 'allowed_warning');
  assert.deepEqual(
    db.usageSamples('five_hour').map((s) => [s.utilization, s.resets_at]),
    [
      [0.2, 1000],
      [0.3, 1000],
    ],
  );

  // A new window resetting is a change even at the same utilization.
  db.recordUsageWindow('five_hour', 0.3, 2000, 'allowed');
  assert.equal(db.usageSamples('five_hour').length, 3);

  db.recordUsageWindow('seven_day', 0.1, 5000, null);
  assert.equal(db.usageSamples().length, 4);
  assert.equal(db.usageSamples('seven_day').length, 1);
  // The latest reading is still kept as before.
  assert.equal(db.usageWindows().find((w) => w.window === 'five_hour')!.utilization, 0.3);
});

const pending: PrDetails = {
  state: 'open',
  draft: false,
  mergeable: 'MERGEABLE',
  merge_state: 'CLEAN',
  commits: 1,
  files: 1,
  additions: 5,
  deletions: 1,
  checks: { total: 3, failing: 0, pending: 1 },
  paths: [],
  labels: [],
};

test("a PR's checks are stored once they settle, kept as first seen, and the merge stores its own", async () => {
  const t = doneTask(db, repo, { pr: 'open', url: 'https://x/pull/1', branch: 'agentdeck/checks' });
  let current = pending;
  github.prDetails = async () => current;
  github.markReady = async () => {};
  github.merge = async () => {};
  github.deleteRemoteBranch = async () => {};

  // Still running: nothing stored. No checks at all might only be CI not started: nothing stored.
  await refreshPrStates(db);
  assert.equal(db.getTask(t.id)!.pr_checks_opened, null);
  current = { ...pending, checks: { total: 0, failing: 0, pending: 0 } };
  await refreshPrStates(db);
  assert.equal(db.getTask(t.id)!.pr_checks_opened, null);

  current = { ...pending, checks: { total: 3, failing: 1, pending: 0 } };
  await refreshPrStates(db);
  assert.deepEqual(db.getTask(t.id)!.pr_checks_opened, { total: 3, failing: 1, pending: 0 });

  // A later result does not replace the first settled one.
  current = { ...pending, checks: { total: 3, failing: 0, pending: 0 } };
  await refreshPrStates(db);
  assert.deepEqual(db.getTask(t.id)!.pr_checks_opened, { total: 3, failing: 1, pending: 0 });
  assert.equal(db.getTask(t.id)!.pr_checks_merged, null);

  await mergeTask(db, t.id, { method: 'squash' });
  const merged = db.getTask(t.id)!;
  assert.equal(merged.pr_state, 'merged');
  assert.deepEqual(merged.pr_checks_merged, { total: 3, failing: 0, pending: 0 });
  assert.deepEqual(merged.pr_checks_opened, { total: 3, failing: 1, pending: 0 });
});
