// The plan review run: opening a plan PR starts one, it reads the plan branch's whole diff, leaves its verdict on the plan PR, and a blocking finding stops an auto plan PR merging.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plan-review-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { openDb } = await import('#db/index.ts');
const { addTask, landPlanBranches, openPlanBranch, setPlanLandingPolicy } = await import('#application/actions.ts');
const { cutPlanBranch } = await import('#application/work/plans.ts');
const { startPlanBranchSync } = await import('#application/runs/plan-branch-sync.ts');
const { runPlanReview } = await import('#application/runs/plan-review.ts');
const { fakeAgent, fakeCodeHost } = await import('#test/fixtures/fakes.ts');
const { testApp } = await import('#test/fixtures/fixtures.ts');

const answer: { structured_output?: unknown } = {};
const agent = fakeAgent(() => {}, answer);
const host = fakeCodeHost();
const db = testApp(openDb(join(home, 'agentdeck.db')), { agent, codeHost: host });
db.setPaused(false);
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const dir = join(home, 'shop');
mkdirSync(dir, { recursive: true });
sh(dir, 'init', '-q', '-b', 'main');
sh(dir, 'config', 'user.email', 'test@example.com');
sh(dir, 'config', 'user.name', 'test');
writeFileSync(join(dir, 'readme.txt'), 'shop\n');
sh(dir, 'add', '-A');
sh(dir, 'commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'shop', path: dir, base_branch: 'main' });
db.updateRepo(repo.id, { pr_mode: 'ready' });

const PLAN = `<!doctype html><html data-agentdeck-plan="1"><head><title>Payouts</title></head><body>
<section data-plan-step id="ledger" data-status="done"><h2>A ledger</h2><p>Every payout is written to the ledger.</p>
<ul data-plan-done><li>A test pays out and reads the ledger back.</li></ul></section>
</body></html>`;

let prs = 0;
async function openPlanPr(title: string) {
  const owner = await addTask(db, { repo: 'shop', prompt: 'the plan', title, plan_html: PLAN, propose: true });
  const { name } = openPlanBranch(db, owner.id);
  await cutPlanBranch(db, repo, { target: name });
  sh(dir, 'checkout', '-q', name);
  writeFileSync(join(dir, `${prs}.txt`), 'payouts\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'payouts');
  sh(dir, 'checkout', '-q', 'main');
  const branch = db.planBranchNamed(repo.id, name);
  assert.ok(branch);
  const url = `https://example.test/plan/${++prs}`;
  const opened = db.openPlanBranchPr(branch.id, url);
  assert.equal(opened?.review, 'due', 'opening a plan PR makes its plan review due');
  return { owner, name, url };
}

const startOne = async () => {
  const lines: string[] = [];
  await startPlanBranchSync(db, (m) => lines.push(m));
  return lines;
};

test('opening a plan PR starts one plan review run, and its blocking finding stops an auto plan PR merging', async () => {
  const { owner, name, url } = await openPlanPr('Blocking');
  setPlanLandingPolicy(db, owner.id, { policy: 'auto' });
  assert.equal(await landPlanBranches(db), 0, 'an auto plan PR waits for its plan review');

  answer.structured_output = {
    summary: 'The ledger step is done, but nothing pays out through it.',
    findings: [{ path: '0.txt', line: 1, side: 'new', body: 'payouts skip the ledger', blocking: true }],
  };
  const lines = await startOne();
  assert.ok(
    lines.some((l) => /plan review run: blocking/.test(l)),
    lines.join('\n'),
  );
  const runs = db.runsForTask(owner.id).filter((r) => r.kind === 'plan_review');
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.outcome, 'done');
  const prompt = agent.sessions.at(-1)?.args.join(' ') ?? '';
  assert.match(prompt, new RegExp(`plan review run for ${name}`));
  assert.match(prompt, /A test pays out and reads the ledger back/);

  const reviewed = db.planBranchNamed(repo.id, name);
  assert.equal(reviewed?.review, 'blocking');
  assert.equal(reviewed?.review_head, sh(dir, 'rev-parse', name));
  assert.deepEqual(
    host.commented.map((c) => c.url),
    [url],
  );
  assert.match(
    host.commented[0]?.body ?? '',
    /blocking.*\n\nThe ledger step is done[\s\S]*\*\*Blocking\*\* `0.txt:1`: payouts skip the ledger/,
  );

  await startOne();
  assert.equal(db.runsForTask(owner.id).filter((r) => r.kind === 'plan_review').length, 1, 'a plan PR is reviewed once');
  assert.equal(await landPlanBranches(db), 0);
  assert.deepEqual(host.merged, [], 'a blocking plan review stops an auto plan PR merging');
  assert.equal(db.planBranchNamed(repo.id, name)?.status, 'landing');
});

test('a clean plan review lets an auto plan PR merge; one with no answer leaves it to a person', async () => {
  const clean = await openPlanPr('Clean');
  setPlanLandingPolicy(db, clean.owner.id, { policy: 'auto' });
  answer.structured_output = { summary: 'Every step is met.', findings: [] };
  await startOne();
  assert.equal(db.planBranchNamed(repo.id, clean.name)?.review, 'clean');
  assert.equal(await landPlanBranches(db), 1);
  assert.deepEqual(
    host.merged.map((m) => m.url),
    [clean.url],
  );

  host.merged.length = 0;
  const garbled = await openPlanPr('Garbled');
  setPlanLandingPolicy(db, garbled.owner.id, { policy: 'auto' });
  answer.structured_output = 'not json';
  const lines = await startOne();
  assert.ok(
    lines.some((l) => /plan review run: failed \(the plan review run gave no answer/.test(l)),
    lines.join('\n'),
  );
  assert.equal(db.runsForTask(garbled.owner.id).find((r) => r.kind === 'plan_review')?.outcome, 'failed');
  assert.equal(await landPlanBranches(db), 0);
  assert.deepEqual(host.merged, [], 'a plan review that gave no answer leaves the plan PR to a person');
});

test('a plan review runs once at a time, ends cancelled or rate limited without a verdict, and a reviewed branch is stale', async () => {
  const { owner, name } = await openPlanPr('Edges');
  const branch = db.planBranchNamed(repo.id, name);
  assert.ok(branch);
  const run = agent.run.bind(agent);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  agent.run = async (session) => {
    await gate;
    return { ...(await run(session)), cancelled: true };
  };
  const first = runPlanReview(db, branch);
  assert.deepEqual(await runPlanReview(db, branch), { outcome: 'deferred', reason: 'a plan review of it is running' });
  release();
  assert.deepEqual(await first, { outcome: 'deferred', reason: 'cancelled' });
  assert.equal(db.runsForTask(owner.id).find((r) => r.kind === 'plan_review')?.outcome, 'cancelled');

  agent.run = async (session) => ({ ...(await run(session)), rateLimitedUntil: Date.now() + 60_000 });
  assert.deepEqual(await runPlanReview(db, branch), { outcome: 'deferred', reason: 'rate_limited' });
  assert.equal(db.planBranchNamed(repo.id, name)?.review, 'due', 'a cut-off plan review stays due');

  agent.run = run;
  answer.structured_output = { summary: 'Every step is met.', findings: [] };
  const comment = host.commentOnPr;
  host.commentOnPr = async () => {
    throw new Error('gh is down');
  };
  assert.deepEqual(await runPlanReview(db, branch), { outcome: 'clean' });
  host.commentOnPr = comment;
  assert.deepEqual(await runPlanReview(db, branch), { outcome: 'stale' });
});
