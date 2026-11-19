// The plan-branch commands run in process: open, a landing policy, the question a partly landed plan asks and its answer, and abandon.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fakeCodeHost } from '#test/fixtures/fakes.ts';
import { scratchCli, scratchRepo } from '#test/cli/cli-run.ts';

const { db, run } = scratchCli({ codeHost: fakeCodeHost() });
const actions = await import('#application/actions.ts');
await actions.addRepo(db, { path: scratchRepo('shop'), test: 'true' });
await actions.addRepo(db, { path: scratchRepo('api'), test: 'true' });

const PLAN =
  '<html data-agentdeck-plan="1"><head><title>Pay</title></head><body><section data-plan-step id="s1" data-status="todo"><h2>One</h2></section></body></html>';
const planFile = join(mkdtempSync(join(tmpdir(), 'agentdeck-plan-')), 'plan.html');
writeFileSync(planFile, PLAN);

test('plan-branch open, policy, question, answer and abandon', async () => {
  assert.match((await run('plan-branch', 'land', '1')).err, /usage: agentdeck plan-branch open\|abandon/);
  const owner = /#(\d+)/.exec((await run('add', '--repo', 'shop', '--plan', planFile, '--propose', 'the plan')).out)?.[1] ?? '';
  await run('add', '--repo', 'api', '--plan', owner, '--propose', 'its api part');
  const opened = await run('plan-branch', 'open', owner);
  assert.match(opened.out, new RegExp(`opened plan/${owner}-pay in shop[^]*opened plan/${owner}-pay in api`));

  const policy = await run('plan-branch', 'policy', owner, 'in_order', 'api,shop');
  assert.match(policy.out, /in api lands in_order, number 1 in its order/);
  assert.match(policy.out, /in shop lands in_order, number 2 in its order/);
  assert.match((await run('plan-branch', 'policy', owner, 'together')).out, /in shop lands together$/m);
  assert.match((await run('plan-branch', 'policy', owner, 'sometimes')).err, /a landing policy is one of/);

  assert.match((await run('plan-branch', 'question', owner)).out, /is not partly landed/);
  const [shop, api] = db.planBranchesOfPlan(Number(owner) as Parameters<typeof db.planBranchesOfPlan>[0]);
  for (const b of [shop, api]) {
    db.cutPlanBranch(b.id, 'abc123');
    db.openPlanBranchPr(b.id, `https://example.test/plan/${b.id}`);
  }
  db.recordLanding(shop.id, { move: 'land', land_error: null });
  db.recordLanding(api.id, { move: 'part_land', land_error: 'CI failed' });
  const question = await run('plan-branch', 'question', owner);
  assert.match(question.out, /landed in shop but not in api \(CI failed\)[^]*retry: [^]*revert: [^]*by_hand: /);
  assert.match((await run('plan-branch', 'answer', owner, 'shrug')).err, /an answer is one of/);
  assert.match((await run('plan-branch', 'answer', owner, 'retry')).out, /in api: landing/);

  db.recordLanding(api.id, { move: 'part_land', land_error: 'CI failed again' });
  const reverted = await run('plan-branch', 'answer', owner, 'revert');
  assert.match(reverted.out, /in api: abandoned/);
  assert.match(reverted.out, /could not open a revert PR in shop: revert it by hand/);
  assert.match((await run('plan-branch', 'abandon', owner)).err, /landed, so it can't be abandoned/);
});
