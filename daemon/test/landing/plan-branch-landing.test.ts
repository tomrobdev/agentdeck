import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plan-land-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { addTask, openPlanBranch, taskDetail, taskViews } = await import('#application/actions.ts');
const { cutPlanBranch } = await import('#application/work/plans.ts');
const { landPlanBranch, startPlanBranchSync } = await import('#application/runs/plan-branch-sync.ts');
const { LAND_RETRY_MINUTES, nextPlanBranchToLand, openPlanBranchPr, refreshPlanBranchPrs } =
  await import('#application/landing/pull-request/plan-branch-pr.ts');
const { refreshPrStates } = await import('#application/landing/pull-request/refresh.ts');
const { fmtTask } = await import('#cli/format.ts');
const { READY_PR, fakeCodeHost } = await import('#test/fixtures/fakes.ts');
const { advance, doneTask, queuedTask, settlePr, testApp } = await import('#test/fixtures/fixtures.ts');
const host = fakeCodeHost();
const db = testApp(openDb(join(home, 'agentdeck.db')), { codeHost: host });
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dir = join(home, 'shop');
const bare = join(home, 'shop.git');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'shared.txt'), 'one\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
sh(home, 'init', '-q', '--bare', '-b', 'main', bare);
sh(dir, 'remote', 'add', 'origin', bare);
sh(dir, 'push', '-q', '-u', 'origin', 'main');
const repo = db.addRepo({ name: 'shop', path: dir, base_branch: 'main' });
db.updateRepo(repo.id, { pr_mode: 'ready' });

const PLAN = `<!doctype html><html data-agentdeck-plan="1"><head><title>Payments phase</title></head><body>
<section data-plan-step id="a" data-status="done"><h2>A</h2></section>
<section data-plan-step id="b" data-status="todo"><h2>B</h2></section>
</body></html>`;

function commitOn(branch: string, file: string): void {
  const wt = join(home, `wt-${file}`);
  sh(dir, 'worktree', 'add', '-q', wt, branch);
  writeFileSync(join(wt, file), `${file}\n`);
  sh(wt, 'add', '-A');
  sh(wt, 'commit', '-q', '-m', file);
  sh(wt, 'push', '-q', 'origin', branch);
  sh(dir, 'worktree', 'remove', '--force', wt);
}

const later = () => Date.now() + (LAND_RETRY_MINUTES + 1) * 60_000;
const hasLocal = (name: string) => sh(dir, 'branch', '--list', name) !== '';
const hasOrigin = (name: string) => sh(bare, 'branch', '--list', name) !== '';

let plans = 0;
async function planOfThree() {
  const owner = await addTask(db, { repo: 'shop', prompt: 'the plan', title: `Pay ${++plans}`, plan_html: PLAN, propose: true });
  const { name } = openPlanBranch(db, owner.id);
  await cutPlanBranch(db, repo, { target: name });
  const cut = db.planBranchNamed(repo.id, name) ?? assert.fail('no plan branch');
  db.markFollowedUp(db.applyEvent(owner.id, { type: 'approve' })?.pending ?? []);
  advance(db, owner.id, 'done', { pr: 'merged', branch: `agentdeck/task-${owner.id}` });
  const others = [1, 2].map((n) =>
    doneTask(db, repo, { title: `step ${n} of ${plans}`, target: name, plan_task: owner.id, plan_steps: ['b'], pr: 'merged' }),
  );
  return { owner, branch: cut, tasks: [db.getTask(owner.id) ?? assert.fail(), ...others] };
}

test('three tasks merged into a plan branch: its PR opens into the base, and merging it lands the branch', async () => {
  const { branch, tasks } = await planOfThree();
  commitOn(branch.name, 'pay.txt');
  assert.equal(
    nextPlanBranchToLand(db, Date.now(), () => false),
    null,
    'just synced: it waits a few minutes before trying',
  );
  assert.equal(nextPlanBranchToLand(db, later(), () => false)?.id, branch.id);

  const waiting = taskViews(db, { limit: 50 }).find((t) => t.id === tasks[1].id) ?? assert.fail();
  assert.deepEqual(waiting.plan_landing, { name: branch.name, base: 'main', state: 'waiting' });
  assert.match(
    fmtTask({ ...tasks[1], plan_landing: waiting.plan_landing }, 'shop'),
    new RegExp(`merged into ${branch.name}, waiting for it to land`),
  );

  const lines: string[] = [];
  const landing = startPlanBranchSync(db, (m) => lines.push(m), later());
  assert.ok(landing, 'a plan branch ready to land is picked even before its sync is due');
  await landing;
  assert.equal(host.created.length, 1, lines.join('\n'));
  const pr = host.created[0];
  assert.equal(pr.base, 'main');
  assert.equal(pr.head, branch.name);
  assert.equal(pr.title, 'Payments phase');
  for (const t of tasks) assert.match(pr.body, new RegExp(`\\| #${t.id} ${t.title} \\| ${t.pr?.url} \\|`));
  assert.match(pr.body, new RegExp(`#${tasks[1].id} .* \\| b \\|`), 'the plan steps it left unfinished');
  const opened = db.planBranchNamed(repo.id, branch.name);
  assert.equal(opened?.status, 'landing');
  assert.equal(opened?.pr_url, 'https://example.test/pull/1');

  const detail = await taskDetail(db, tasks[1].id);
  assert.equal(detail.plan_branch?.ahead, 1);
  assert.equal(detail.plan_branch?.behind, 0);

  await refreshPrStates(db);
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'landing', 'an open PR leaves it landing');

  host.details['https://example.test/pull/1'] = { ...READY_PR, state: 'merged' };
  assert.ok(hasLocal(branch.name) && hasOrigin(branch.name));
  await refreshPrStates(db);
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'landed');
  assert.deepEqual(host.deletedBranches, [branch.name]);
  assert.equal(hasLocal(branch.name), false, 'the local branch is deleted');
  const landed = taskViews(db, { limit: 50 }).find((t) => t.id === tasks[1].id) ?? assert.fail();
  assert.deepEqual(landed.plan_landing, { name: branch.name, base: 'main', state: 'landed' });
  assert.match(fmtTask({ ...tasks[1], plan_landing: landed.plan_landing }, 'shop'), new RegExp(`landed on main with ${branch.name}`));
});

test('a plan branch with a task still open does not land, and a plan PR closed unmerged makes it active again', async () => {
  const { branch } = await planOfThree();
  const unmerged = doneTask(db, repo, { title: 'unmerged', target: branch.name, plan_task: branch.plan_task, pr: 'open' });
  assert.equal(
    nextPlanBranchToLand(db, later(), () => false),
    null,
    'a done task whose PR is still open',
  );
  settlePr(db, unmerged.id, 'merged');
  const open = queuedTask(db, repo, { title: 'late', target: branch.name, plan_task: branch.plan_task });
  assert.equal(
    nextPlanBranchToLand(db, later(), () => false),
    null,
    'a task still queued',
  );
  assert.ok(db.applyEvent(open.id, { type: 'cancel' }));
  const ready = nextPlanBranchToLand(db, later(), () => false) ?? assert.fail('a cancelled task does not keep it from landing');
  assert.equal(ready.id, branch.id);

  await startPlanBranchSync(db, () => {}, later());
  const url = db.planBranchNamed(repo.id, branch.name)?.pr_url ?? assert.fail('no plan PR');
  assert.match(host.created.at(-1)?.body ?? '', new RegExp(`\\| #${open.id} late \\| cancelled \\|`));
  host.details[url] = { ...READY_PR, state: 'closed' };
  await refreshPrStates(db);
  const back = db.planBranchNamed(repo.id, branch.name);
  assert.equal(back?.status, 'active');
  assert.equal(back?.pr_url, null);
  assert.ok(hasLocal(branch.name), 'a closed plan PR deletes nothing');
});

test('a plan PR that exists already is taken; any other failure leaves the plan branch active and says why', async () => {
  const { branch } = await planOfThree();
  const create = host.createPr;
  host.createPr = async () => {
    throw new Error(`a pull request for branch "${branch.name}" into branch "main" already exists`);
  };
  host.branchPrs[branch.name] = [{ url: 'https://example.test/pull/77', state: 'open' }];
  assert.match(await landPlanBranch(db, branch), /its PR opened into main: https:\/\/example.test\/pull\/77/);
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.pr_url, 'https://example.test/pull/77');
  assert.deepEqual(await openPlanBranchPr(db, branch), { error: `${branch.name} is not ready to land` });

  const other = await planOfThree();
  host.createPr = async () => {
    throw new Error('gh: HTTP 502');
  };
  assert.match(await landPlanBranch(db, other.branch), /its PR did not open: gh: HTTP 502/);
  assert.equal(db.planBranchNamed(repo.id, other.branch.name)?.status, 'active');
  host.createPr = create;

  const lines: string[] = [];
  const prDetails = host.prDetails;
  const deleteRemote = host.deleteRemoteBranch;
  host.prDetails = async () => {
    throw new Error('gh: timed out');
  };
  await refreshPlanBranchPrs(db, (m) => lines.push(m));
  assert.ok(lines.some((l) => l.includes(`${branch.name}: could not read its PR: gh: timed out`)));
  host.prDetails = async () => ({ ...READY_PR, state: 'merged' });
  host.deleteRemoteBranch = async () => {
    throw new Error('gh: not found');
  };
  sh(dir, 'worktree', 'add', '-q', join(home, 'wt-held'), branch.name);
  assert.equal(await refreshPlanBranchPrs(db, (m) => lines.push(m)), 1);
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'landed');
  assert.ok(lines.some((l) => l.includes('remote branch not deleted: gh: not found')));
  assert.ok(lines.some((l) => l.includes('local branch not deleted')));
  sh(dir, 'worktree', 'remove', '--force', join(home, 'wt-held'));
  host.prDetails = prDetails;
  host.deleteRemoteBranch = deleteRemote;
});

test('a plan branch that conflicts with its base before landing opens no PR', async () => {
  const { branch } = await planOfThree();
  db.updateRepo(repo.id, { auto_resolve: false });
  commitOn(branch.name, 'shared.txt');
  writeFileSync(join(dir, 'shared.txt'), 'base side\n');
  sh(dir, 'commit', '-q', '-am', 'base side');
  sh(dir, 'push', '-q', 'origin', 'main');
  const before = host.created.length;
  assert.match(await landPlanBranch(db, branch), /synced before landing: conflict, so its PR waits/);
  assert.equal(host.created.length, before);
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'conflict');
});
