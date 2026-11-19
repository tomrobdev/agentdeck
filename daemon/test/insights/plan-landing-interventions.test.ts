import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTask, openPlanBranch, pilotStats } from '#application/actions.ts';
import { refreshPlanBranchPrs } from '#application/landing/pull-request/plan-branch-pr.ts';
import { openDb } from '#test/fixtures/open-db.ts';
import { READY_PR, fakeCodeHost } from '#test/fixtures/fakes.ts';
import { doneTask, openPr, testApp } from '#test/fixtures/fixtures.ts';

const PLAN = `<!doctype html><html data-agentdeck-plan="1"><head><title>Payments phase</title></head><body>
<section data-plan-step id="a" data-status="done"><h2>A</h2></section>
</body></html>`;

test("a person's merge of a plan PR is not an intervention, while their merge of a task's PR with auto-merge on is", async () => {
  const host = fakeCodeHost();
  const db = testApp(openDb(':memory:'), { codeHost: host });
  const repo = db.addRepo({ name: 'shop', path: '/nonexistent/shop', base_branch: 'main' });
  db.updateRepo(repo.id, { pr_mode: 'ready', auto_merge: true });
  const owner = await addTask(db, { repo: 'shop', prompt: 'the plan', title: 'Payments', plan_html: PLAN, propose: true });
  const branch = openPlanBranch(db, owner.id);
  assert.ok(db.cutPlanBranch(branch.id, 'abc123'));

  const auto = [1, 2, 3].map((n) => {
    const t = doneTask(db, repo, { title: `step ${n}`, target: branch.name, plan_task: owner.id });
    openPr(db, t.id);
    assert.ok(db.recordMerge(t.id, 'squash', 'auto-merged: checks passed'));
    return t;
  });
  assert.equal(pilotStats(db, {}).scorecard.total.interventions.total, 0, 'the daemon merged each task PR into the plan branch');

  assert.ok(db.openPlanBranchPr(branch.id, 'https://example.test/pull/9'));
  host.details['https://example.test/pull/9'] = { ...READY_PR, state: 'merged' };
  assert.equal(await refreshPlanBranchPrs(db), 1);
  assert.equal(db.planBranchNamed(repo.id, branch.name)?.status, 'landed');
  const after = pilotStats(db, {}).scorecard.total.interventions;
  assert.equal(after.total, 0, 'landing the plan branch by hand is how phase 1 lands it');
  assert.equal(after.by_kind.manual_merge, 0);
  for (const t of auto) assert.equal(db.eventsForTask(t.id).filter((e) => e.type === 'merge').length, 1);

  const byHand = doneTask(db, repo, { title: 'by hand' });
  openPr(db, byHand.id);
  assert.ok(db.recordMerge(byHand.id, 'squash', 'merged from the dashboard'));
  assert.equal(pilotStats(db, {}).scorecard.total.interventions.by_kind.manual_merge, 1, "a task's PR merged by hand still counts");
  db.close();
});
