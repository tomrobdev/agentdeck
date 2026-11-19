// A plan with tasks in two repos: opening its plan branch opens one in each, a builds-on link across them waits for the work, and each lands on its own base.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plan-repos-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { abandonPlanBranch, addTask, linkTasks, openPlanBranch } = await import('#application/actions.ts');
const { cutPlanBranch } = await import('#application/work/plans.ts');
const { startPlanBranchSync } = await import('#application/runs/plan-branch-sync.ts');
const { LAND_RETRY_MINUTES } = await import('#application/landing/pull-request/plan-branch-pr.ts');
const { refreshPrStates } = await import('#application/landing/pull-request/refresh.ts');
const { READY_PR, fakeAgent, fakeCodeHost } = await import('#test/fixtures/fakes.ts');
const { advance, openPr, settlePr, testApp } = await import('#test/fixtures/fixtures.ts');
const host = fakeCodeHost();
const db = testApp(openDb(join(home, 'agentdeck.db')), { agent: fakeAgent(), codeHost: host });
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function gitRepo(name: string, base: string) {
  const dir = join(home, name);
  const bare = join(home, `${name}.git`);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', base);
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'readme.txt'), `${name}\n`);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  sh(home, 'init', '-q', '--bare', '-b', base, bare);
  sh(dir, 'remote', 'add', 'origin', bare);
  sh(dir, 'push', '-q', '-u', 'origin', base);
  const repo = db.addRepo({ name, path: dir, base_branch: base });
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  return { ...repo, dir };
}

const shop = gitRepo('shop', 'main');
const api = gitRepo('api', 'develop');

const PLAN = `<!doctype html><html data-agentdeck-plan="1"><head><title>Checkout across repos</title></head><body>
<section data-plan-step id="a" data-status="todo"><h2>A</h2></section>
</body></html>`;

const later = () => Date.now() + (LAND_RETRY_MINUTES + 1) * 60_000;
const startedBranch = (id: Parameters<typeof db.getTask>[0]) => `agentdeck/task-${id}`;

test('a plan with tasks in two repos opens a plan branch in each, links across them, and each lands on its own base', async () => {
  const owner = await addTask(db, { repo: 'shop', prompt: 'the plan', plan_html: PLAN, propose: true });
  const server = await addTask(db, { repo: 'api', prompt: 'the endpoint', plan_task: owner.id, propose: true });
  const client = await addTask(db, { repo: 'shop', prompt: 'the page', plan_task: owner.id, propose: true });

  const opened = openPlanBranch(db, client.id);
  const name = `plan/${owner.id}-checkout-across-repos`;
  assert.deepEqual([opened.repo_id, opened.name, opened.base], [shop.id, name, 'main']);
  assert.deepEqual(
    opened.others.map((b) => [b.repo_id, b.name, b.base, b.targeted]),
    [[api.id, name, 'develop', [server.id]]],
  );
  assert.deepEqual([...opened.targeted].sort(), [owner.id, client.id].sort());
  assert.equal(db.getTask(server.id)?.target, name);
  assert.throws(() => openPlanBranch(db, owner.id), /has a plan branch already/);

  linkTasks(db, client.id, { on: server.id, kind: 'builds_on' });
  const onBase = await addTask(db, { repo: 'shop', prompt: 'after it lands', target: 'main', builds_on: [server.id] });
  assert.equal(onBase.target, null);

  for (const repo of [shop, api]) await cutPlanBranch(db, repo, { target: name });
  for (const t of [owner, server, client]) db.markFollowedUp(db.applyEvent(t.id, { type: 'approve' })?.pending ?? []);
  advance(db, owner.id, 'done', { pr: 'merged', branch: startedBranch(owner.id) });
  advance(db, server.id, 'done', { pr: 'merged', branch: startedBranch(server.id) });

  assert.equal(db.claimNextTask()?.id, client.id, 'the server task is merged into the plan branch the client task targets');
  assert.equal(db.claimNextTask(), undefined, 'a task on the base waits until the plan branch lands');
  assert.ok(db.applyEvent(client.id, { type: 'finish', outcome: 'done' }));
  openPr(db, client.id);
  settlePr(db, client.id, 'merged');

  for (let i = 0; i < 2; i++) await startPlanBranchSync(db, () => {}, later());
  assert.deepEqual(
    host.created.map((pr) => [pr.head, pr.base]).sort(),
    [
      [name, 'develop'],
      [name, 'main'],
    ],
    'each plan branch opens its PR into its own repo’s base',
  );
  assert.equal(db.claimNextTask(), undefined, 'still waiting while the plan PRs are open');

  for (const n of [1, 2]) host.details[`https://example.test/pull/${n}`] = { ...READY_PR, state: 'merged' };
  await refreshPrStates(db);
  assert.equal(db.planBranchNamed(shop.id, name)?.status, 'landed');
  assert.equal(db.planBranchNamed(api.id, name)?.status, 'landed');
  assert.equal(db.claimNextTask()?.id, onBase.id, 'once the api plan branch has landed on develop, the base task gets the work');
});

test('abandoning a plan’s plan branch abandons it in every repo, moving back the tasks that have not started', async () => {
  const owner = await addTask(db, { repo: 'api', prompt: 'another plan', title: 'Second', plan_html: PLAN, propose: true });
  const elsewhere = await addTask(db, { repo: 'shop', prompt: 'its shop part', plan_task: owner.id, propose: true });
  const opened = openPlanBranch(db, owner.id);
  assert.equal(opened.repo_id, api.id, 'the plan owner’s repo comes first');
  assert.deepEqual(
    opened.others.map((b) => b.repo_id),
    [shop.id],
  );
  const abandoned = abandonPlanBranch(db, elsewhere.id);
  assert.deepEqual(
    [abandoned, ...abandoned.others].map((b) => [b.repo_id, b.status]),
    [
      [api.id, 'abandoned'],
      [shop.id, 'abandoned'],
    ],
  );
  assert.equal(db.getTask(elsewhere.id)?.target, null);
});
