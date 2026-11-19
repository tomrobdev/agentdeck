// A plan's landing policy across two repos: in_order merges them one at a time, a failure after a landing leaves it partly landed with a question, and each answer settles it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plan-saga-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { addTask, answerPlanLanding, landPlanBranches, openPlanBranch, planLandingQuestion, setPlanLandingPolicy } =
  await import('#application/actions.ts');
const { READY_PR, fakeCodeHost } = await import('#test/fixtures/fakes.ts');
const { testApp } = await import('#test/fixtures/fixtures.ts');
const host = fakeCodeHost();
const db = testApp(openDb(join(home, 'agentdeck.db')), { codeHost: host });
db.setPaused(false);
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function gitRepo(name: string, base: string) {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', base);
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'readme.txt'), `${name}\n`);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  const repo = db.addRepo({ name, path: dir, base_branch: base });
  db.updateRepo(repo.id, { pr_mode: 'ready' });
  return repo;
}

const shop = gitRepo('shop', 'main');
const api = gitRepo('api', 'develop');

const PLAN = `<!doctype html><html data-agentdeck-plan="1"><head><title>Saga</title></head><body>
<section data-plan-step id="a" data-status="todo"><h2>A</h2></section>
</body></html>`;

let prs = 0;
async function landingPlan(title: string) {
  const owner = await addTask(db, { repo: 'shop', prompt: 'the plan', title, plan_html: PLAN, propose: true });
  const other = await addTask(db, { repo: 'api', prompt: 'its api part', plan_task: owner.id, propose: true });
  openPlanBranch(db, owner.id);
  const urls: Record<string, string> = {};
  for (const b of db.planBranchesOfPlan(owner.id)) {
    db.cutPlanBranch(b.id, 'abc123');
    const url = `https://example.test/plan/${++prs}`;
    db.openPlanBranchPr(b.id, url);
    urls[b.repo_id === shop.id ? 'shop' : 'api'] = url;
  }
  return { owner, other, urls };
}

const merged = () => host.merged.map((m) => m.url);
const statuses = (owner: Parameters<typeof db.planBranchesOfPlan>[0]) =>
  Object.fromEntries(db.planBranchesOfPlan(owner).map((b) => [b.repo_id === shop.id ? 'shop' : 'api', b.status]));

test('a person policy lands nothing itself; in_order merges the repos in the order given', async () => {
  const { owner, urls } = await landingPlan('In order');
  assert.equal(await landPlanBranches(db), 0, 'a person lands a plan by default');
  assert.deepEqual(merged(), []);

  const set = setPlanLandingPolicy(db, owner.id, { policy: 'in_order', order: ['api', 'shop'] });
  assert.deepEqual(
    set.map((b) => [b.repo_id, b.landing_policy, b.land_order]),
    [
      [api.id, 'in_order', 0],
      [shop.id, 'in_order', 1],
    ],
  );
  assert.throws(() => setPlanLandingPolicy(db, owner.id, { policy: 'in_order', order: ['web'] }), /no plan branch in web/);
  assert.throws(() => setPlanLandingPolicy(db, owner.id, { policy: 'auto', order: ['api'] }), /only an in_order plan/);

  host.details[urls.api] = { ...READY_PR, checks: { total: 1, failing: 0, pending: 1 } };
  assert.equal(await landPlanBranches(db), 0, 'the first in order waits for its checks, and the second waits behind it');
  assert.deepEqual(merged(), []);

  delete host.details[urls.api];
  const before = host.merge;
  host.merge = async (pr) => {
    await before(pr);
    host.details[pr.url] = { ...READY_PR, state: 'merged', merge_commit: 'f00d' };
  };
  assert.equal(await landPlanBranches(db), 2);
  host.merge = before;
  assert.deepEqual(merged(), [urls.api, urls.shop]);
  assert.deepEqual(statuses(owner.id), { shop: 'landed', api: 'landed' });
  const landed = db.planBranchesOfPlan(owner.id).find((b) => b.repo_id === shop.id);
  assert.deepEqual([landed?.landed_commit, landed?.landed_from], ['f00d', 'f00d^1']);
});

test('a merge that fails for good after another repo landed leaves the plan partly landed, its tasks waiting, with a question', async () => {
  host.merged.length = 0;
  const { owner, urls } = await landingPlan('Partly');
  setPlanLandingPolicy(db, owner.id, { policy: 'together' });
  const late = await addTask(db, { repo: 'shop', prompt: 'more plan work', plan_task: owner.id });
  db.markFollowedUp(db.applyEvent(late.id, { type: 'approve' })?.pending ?? []);

  const before = host.merge;
  host.merge = async (pr) => {
    if (pr.url === urls.api) throw new Error('GraphQL: Required status check "e2e" is failing');
    await before(pr);
    host.details[pr.url] = { ...READY_PR, state: 'merged' };
  };
  await landPlanBranches(db);
  assert.deepEqual(statuses(owner.id), { shop: 'landed', api: 'partly_landed' });
  assert.equal(db.claimNextTask(), undefined, "a task on the plan's branch waits while it is partly landed");

  const { question } = planLandingQuestion(db, owner.id);
  assert.match(question?.text ?? '', /landed in shop but not in api/);
  assert.deepEqual(
    question?.options.map((o) => o.answer),
    ['retry', 'revert', 'by_hand'],
  );
  assert.equal(await landPlanBranches(db), 0, 'nothing more lands while it waits for the answer');

  await assert.rejects(answerPlanLanding(db, owner.id, { answer: 'shrug' }), /an answer is one of/);
  host.merge = async (pr) => {
    await before(pr);
    host.details[pr.url] = { ...READY_PR, state: 'merged' };
  };
  const retried = await answerPlanLanding(db, owner.id, { answer: 'retry' });
  assert.deepEqual(
    retried.branches.map((b) => b.status),
    ['landing'],
  );
  assert.equal(await landPlanBranches(db), 1);
  host.merge = before;
  assert.deepEqual(statuses(owner.id), { shop: 'landed', api: 'landed' });
  assert.equal(planLandingQuestion(db, owner.id).question, null);
});

test('finishing by hand hands the plan to a person, and a revert opens a revert PR where it landed and abandons the rest', async () => {
  const partly = async (title: string) => {
    const plan = await landingPlan(title);
    setPlanLandingPolicy(db, plan.owner.id, { policy: 'in_order', order: ['shop', 'api'] });
    host.details[plan.urls.shop] = { ...READY_PR, state: 'merged', merge_commit: sh(join(home, 'shop'), 'rev-parse', 'HEAD') };
    host.details[plan.urls.api] = { ...READY_PR, state: 'closed' };
    await landPlanBranches(db);
    assert.deepEqual(statuses(plan.owner.id), { shop: 'landed', api: 'partly_landed' });
    return plan;
  };

  const byHand = await partly('By hand');
  const handed = await answerPlanLanding(db, byHand.owner.id, { answer: 'by_hand' });
  assert.deepEqual(
    handed.branches.map((b) => [b.status, b.landing_policy]),
    [['landing', 'person']],
  );
  assert.ok(db.planBranchesOfPlan(byHand.owner.id).every((b) => b.landing_policy === 'person'));

  const shopDir = join(home, 'shop');
  writeFileSync(join(shopDir, 'landed.txt'), 'the plan\n');
  sh(shopDir, 'add', '-A');
  sh(shopDir, 'commit', '-q', '-m', 'the plan landed');
  const reverted = await partly('Revert');
  host.created.length = 0;
  const answered = await answerPlanLanding(db, reverted.owner.id, { answer: 'revert' });
  assert.deepEqual(
    answered.branches.map((b) => b.status),
    ['abandoned'],
  );
  assert.deepEqual(
    answered.reverts.map((r) => r.repo),
    ['shop'],
  );
  assert.deepEqual(
    host.created.map((pr) => [pr.base, pr.head]),
    [['main', `revert/plan/${reverted.owner.id}-saga`]],
  );
  assert.ok(host.closed.includes(reverted.urls.api), 'the plan PR that did not land is closed');
});
