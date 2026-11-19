import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plan-sync-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('#db/index.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { addTask, approveTask, openPlanBranch, status, taskViews, updateSettings } = await import('#application/actions.ts');
const { cutPlanBranch } = await import('#application/work/plans.ts');
const { keepPlanBranchCurrent, nextPlanBranchSync, syncPlanBranch } = await import('#application/runs/plan-branch-sync.ts');
const { fmtTask } = await import('#cli/format.ts');
const { testApp, waitFor } = await import('#test/fixtures/fixtures.ts');
const db = testApp(openDb(join(home, 'agentdeck.db')));
db.setSetting('max_concurrent', '1');
db.setPaused(false);
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

const dir = join(home, 'shop');
const bare = join(home, 'shop.git');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'shared.txt'), 'line one\nline two\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
sh(home, 'init', '-q', '--bare', '-b', 'main', bare);
sh(dir, 'remote', 'add', 'origin', bare);
sh(dir, 'push', '-q', '-u', 'origin', 'main');
const repo = db.addRepo({ name: 'shop', path: dir, base_branch: 'main' });

const PLAN = `<!doctype html><html data-agentdeck-plan="1"><head><title>Payments phase</title></head><body>
<section data-plan-step id="a" data-status="todo"><h2>A</h2></section>
</body></html>`;

let plans = 0;
async function activePlanBranch(prompt = 'the plan') {
  const owner = await addTask(db, { repo: 'shop', prompt, title: `plan ${++plans}`, plan_html: PLAN, propose: true });
  const { name } = openPlanBranch(db, owner.id);
  await cutPlanBranch(db, repo, { target: name });
  const branch = db.planBranchNamed(repo.id, name);
  assert.equal(branch?.status, 'active');
  return { owner, branch };
}

function commitOn(branch: string, file: string, text: string): string {
  const wt = join(home, `wt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  sh(dir, 'worktree', 'add', '-q', wt, branch);
  writeFileSync(join(wt, file), text);
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-q', '-m', `${file} on ${branch}`);
  sh(wt, 'push', '-q', 'origin', branch);
  const head = sh(wt, 'rev-parse', 'HEAD');
  sh(dir, 'worktree', 'remove', '--force', wt);
  return head;
}

function moveBase(file: string, text: string): void {
  writeFileSync(join(dir, file), text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', `${file} on main`);
  sh(dir, 'push', '-q', 'origin', 'main');
}

const onOrigin = (name: string) => sh(bare, 'rev-parse', `refs/heads/${name}`);
const fileOnOrigin = (name: string, file: string) => sh(bare, 'show', `refs/heads/${name}:${file}`);
const parents = (ref: string) => sh(bare, 'rev-list', '--parents', '-n', '1', ref).split(' ').length - 1;

test('the base moves cleanly: the plan branch is synced in a scratch checkout and pushed', async () => {
  const { branch } = await activePlanBranch();
  commitOn(branch.name, 'plan.txt', 'plan work\n');
  moveBase('base.txt', 'base work\n');

  const report = await syncPlanBranch(db, branch, { allowResolve: true });
  assert.deepEqual(report, { outcome: 'clean', files: [], pushed: true });
  const head = onOrigin(branch.name);
  assert.equal(parents(head), 2, 'a merge, never a rebase');
  assert.equal(fileOnOrigin(branch.name, 'base.txt'), 'base work');
  assert.equal(fileOnOrigin(branch.name, 'plan.txt'), 'plan work');
  assert.equal(sh(dir, 'rev-parse', `refs/heads/${branch.name}`), head);
  const synced = db.planBranchNamed(repo.id, branch.name);
  assert.equal(synced?.status, 'active');
  assert.equal(synced?.head_commit, head);
  assert.equal(sh(dir, 'worktree', 'list').split('\n').length, 1, 'the scratch checkout is gone');

  assert.deepEqual(await syncPlanBranch(db, branch, { allowResolve: true }), { outcome: 'up_to_date', files: [], pushed: false });
});

test('the schedule picks a plan branch once its last sync is older than the setting', async () => {
  const { branch } = await activePlanBranch();
  const now = Date.now();
  assert.notEqual(nextPlanBranchSync(db, now)?.id, branch.id, 'just cut: not due yet');
  updateSettings(db, { plan_branch_sync_minutes: 30 });
  assert.equal(db.readSettings().plan_branch_sync_minutes, 30);
  assert.ok(nextPlanBranchSync(db, now + 31 * 60_000));
  assert.throws(() => updateSettings(db, { plan_branch_sync_minutes: 1 }), /from 5 to 10080/);
});

test('the base conflicts: a resolve run on the plan’s task settles it, and its result is pushed', async () => {
  const { owner, branch } = await activePlanBranch();
  commitOn(branch.name, 'shared.txt', 'line one\nplan side\n');
  moveBase('shared.txt', 'line one\nbase side\n');

  const report = await syncPlanBranch(db, branch, { allowResolve: true });
  assert.deepEqual(report, { outcome: 'resolved', files: ['shared.txt'], pushed: true });
  const runs = db.runsForTask(owner.id);
  assert.deepEqual(
    runs.map((r) => [r.kind, r.outcome, r.model]),
    [['plan_resolve', 'done', db.modelSettings().support_model]],
  );
  assert.match(readFileSync(join(home, 'fake-claude-calls.log'), 'utf8'), new RegExp(`conflict resolution for plan branch ${branch.name}`));
  assert.doesNotMatch(fileOnOrigin(branch.name, 'shared.txt'), /<<<<<<<|>>>>>>>/);
  assert.equal(parents(onOrigin(branch.name)), 2);
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'active');
});

test('a failed resolve leaves the plan branch where it was, in conflict, and its tasks wait', async () => {
  const { owner, branch } = await activePlanBranch('FAKE_RESOLVE_BLOCKED the plan');
  const before = commitOn(branch.name, 'shared.txt', 'line one\nplan side two\n');
  moveBase('shared.txt', 'line one\nbase side two\n');
  const waiting = await addTask(db, { repo: 'shop', prompt: 'FAKE_DONE next step', plan_task: owner.id });
  assert.equal(waiting.target, branch.name);

  const report = await syncPlanBranch(db, branch, { allowResolve: true });
  assert.equal(report.outcome, 'conflict');
  assert.match(report.reason ?? '', /which behaviour wins/);
  assert.equal(onOrigin(branch.name), before, 'origin is where it was');
  assert.equal(sh(dir, 'rev-parse', `refs/heads/${branch.name}`), before, 'and so is the local branch');
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'conflict');
  assert.equal(db.runsForTask(owner.id).at(-1)?.outcome, 'blocked');

  assert.equal(db.claimNextTask(), undefined, 'a task targeting it does not start');
  const [view] = taskViews(db, { limit: 50 }).filter((t) => t.id === waiting.id);
  assert.deepEqual(view.wait, { kind: 'plan-branch', name: branch.name, base: 'main' });
  const full = db.getTask(waiting.id);
  assert.ok(full);
  assert.match(fmtTask({ ...full, wait: view.wait }, 'shop'), new RegExp(`waits: ${branch.name} conflicts with main`));
  assert.deepEqual(
    status(db).headline.plan_branches.map((b) => b.name),
    [branch.name],
  );

  assert.equal((await syncPlanBranch(db, branch, { allowResolve: true })).outcome, 'conflict', 'no second resolve run while in conflict');
  assert.equal(db.runsForTask(owner.id).length, 1);

  const fix = join(home, 'fix');
  sh(dir, 'worktree', 'add', '-q', fix, branch.name);
  try {
    sh(fix, 'merge', '-q', 'origin/main');
  } catch {}
  writeFileSync(join(fix, 'shared.txt'), 'line one\nsettled by a person\n');
  sh(fix, 'commit', '-q', '-am', 'merge main by hand');
  sh(fix, 'push', '-q', 'origin', branch.name);
  sh(dir, 'worktree', 'remove', '--force', fix);

  assert.equal((await syncPlanBranch(db, branch, { allowResolve: true })).outcome, 'up_to_date');
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'active', 'a pushed merge settles the conflict');
  assert.equal(status(db).headline.plan_branches.length, 0);
  assert.equal(db.claimNextTask()?.id, waiting.id);
  db.applyEvent(waiting.id, { type: 'finish', outcome: 'cancelled' });
});

test('a task targeting a plan branch syncs it with the base before it starts', async () => {
  const { owner, branch } = await activePlanBranch();
  moveBase('later.txt', 'base moved after the cut\n');
  const task = await addTask(db, { repo: 'shop', prompt: 'FAKE_DONE on the plan branch', plan_task: owner.id, propose: true });
  approveTask(db, task.id);
  await drain();
  assert.equal(db.getTask(task.id)?.status, 'done');
  assert.equal(fileOnOrigin(branch.name, 'later.txt'), 'base moved after the cut');
  const own = db.getTask(task.id)?.checkout?.branch;
  assert.ok(own);
  assert.equal(sh(dir, 'show', `${own}:later.txt`), 'base moved after the cut', 'its branch started from the synced plan branch');
});

test('a repo with auto_resolve off leaves a conflicting plan branch in conflict, with no resolve run', async () => {
  const { owner, branch } = await activePlanBranch();
  const before = commitOn(branch.name, 'shared.txt', 'line one\nplan side three\n');
  moveBase('shared.txt', 'line one\nbase side three\n');
  db.raw.prepare('UPDATE repos SET auto_resolve = 0 WHERE id = ?').run(repo.id);
  try {
    const report = await syncPlanBranch(db, branch, { allowResolve: true });
    assert.deepEqual(report, { outcome: 'conflict', files: ['shared.txt'], pushed: false });
    assert.equal(onOrigin(branch.name), before);
    assert.equal(db.runsForTask(owner.id).length, 0);
    assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'conflict');
  } finally {
    db.raw.prepare('UPDATE repos SET auto_resolve = 1 WHERE id = ?').run(repo.id);
  }
});

test('a plan branch that is gone, or not active, is not synced', async () => {
  const { branch } = await activePlanBranch();
  const gone = await syncPlanBranch(db, { ...branch, name: 'plan/nowhere' }, { allowResolve: true });
  assert.deepEqual(gone, { outcome: 'error', files: [], reason: 'plan/nowhere is gone', pushed: false });
  assert.equal(await keepPlanBranchCurrent(db, repo, { id: branch.plan_task, target: null }), null);
  db.raw.prepare("UPDATE plan_branches SET status = 'landing' WHERE id = ?").run(branch.id);
  assert.deepEqual(await syncPlanBranch(db, branch, { allowResolve: true }), {
    outcome: 'deferred',
    files: [],
    reason: 'landing',
    pushed: false,
  });
  assert.equal(await keepPlanBranchCurrent(db, repo, { id: branch.plan_task, target: branch.name }), null);
});

test('two syncs of one plan branch run one after the other, and a base that is gone is an error', async () => {
  const { branch } = await activePlanBranch();
  moveBase('twice.txt', 'synced once\n');
  const [first, second] = await Promise.all([
    syncPlanBranch(db, branch, { allowResolve: true }),
    syncPlanBranch(db, branch, { allowResolve: true }),
  ]);
  assert.deepEqual([first.outcome, second.outcome], ['clean', 'up_to_date']);
  db.raw.prepare("UPDATE plan_branches SET base = 'gone' WHERE id = ?").run(branch.id);
  const report = await syncPlanBranch(db, branch, { allowResolve: true });
  assert.equal(report.outcome, 'error');
  assert.match(report.reason ?? '', /gone/);
  db.raw.prepare("UPDATE plan_branches SET status = 'abandoned' WHERE id = ?").run(branch.id);
});

test('the daemon syncs a plan branch on its schedule', async () => {
  const { branch } = await activePlanBranch();
  moveBase('scheduled.txt', 'moved before the schedule\n');
  db.raw.prepare("UPDATE plan_branches SET synced_at = datetime('now', '-2 days') WHERE id = ?").run(branch.id);
  const logs: string[] = [];
  const scheduler = new Scheduler(db, { once: false, tickMs: 50, autoPropose: false, log: (line) => logs.push(line) });
  const ran = scheduler.run();
  try {
    await waitFor(() => logs.some((l) => l.startsWith(`plan branch ${branch.name}: clean`)), { what: 'the scheduled plan branch sync' });
  } finally {
    scheduler.stop();
    await ran;
  }
  assert.ok(logs.some((l) => l === `plan branch ${branch.name}: clean, pushed`));
  assert.equal(fileOnOrigin(branch.name, 'scheduled.txt'), 'moved before the schedule');
});
