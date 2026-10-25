// Plans: the format's parser, the store, and attaching them from a task's branch and through the API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plans-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { isPlanPath, parsePlan, planName, planProgress } = await import('../src/domain/plan/plan.ts');
const { openDb } = await import('../src/db/index.ts');
const { startApi } = await import('../src/api/server.ts');
const { attachPlan, collectPlans } = await import('../src/application/plans.ts');

const PLAN = `<!doctype html>
<html lang="en" data-agentdeck-plan="1">
  <head>
    <title>Speed up the &amp; cache</title>
    <style>section { color: red } /* <section data-plan-step> */</style>
  </head>
  <body>
    <h1>Ignored when there is a title</h1>
    <p class="lede" data-plan-summary>Make reads <b>fast</b>,
      and keep them correct.</p>
    <!-- <section data-plan-step data-status="done"><h2>Commented out</h2></section> -->
    <section data-plan-step id="s1" data-status="done"><h2>Measure</h2><p>Body</p></section>
    <section data-plan-step id='s2' data-status=DOING>
      <h2 class="x">Add the <code>LRU</code></h2>
    </section>
    <section data-plan-step data-status="later"><h3>Unknown status</h3></section>
    <section class="appendix"><h2>Not a step</h2></section>
    <section data-plan-step="Named step" data-status="skipped"></section>
  </body>
</html>`;

test('parsePlan reads the title, summary and steps, in order', () => {
  const plan = parsePlan(PLAN)!;
  assert.equal(plan.version, '1');
  assert.equal(plan.title, 'Speed up the & cache');
  assert.equal(plan.summary, 'Make reads fast, and keep them correct.');
  assert.deepEqual(plan.steps, [
    { id: 's1', title: 'Measure', status: 'done', done: [] },
    { id: 's2', title: 'Add the LRU', status: 'doing', done: [] },
    { id: null, title: 'Unknown status', status: 'todo', done: [] },
    { id: null, title: 'Named step', status: 'skipped', done: [] },
  ]);
  assert.deepEqual(planProgress(plan.steps), { finished: 2, total: 4 });
});

test('parsePlan reads a step’s done criteria: a list, plain text, none, and not from comments or templates', () => {
  const plan = parsePlan(`<html data-agentdeck-plan="1"><body>
    <section data-plan-step id="a"><h2>List</h2>
      <ul data-plan-done><li>One <code>x</code></li><li>
        Two &amp; three</li><li> </li></ul>
      <ul data-plan-done><li>Second list is ignored</li></ul>
    </section>
    <section data-plan-step id="b"><h2>Text</h2><p data-plan-done>All   of <b>this</b> is one check.</p></section>
    <section data-plan-step id="c"><h2>None</h2><ul><li>Not criteria</li></ul></section>
    <section data-plan-step id="d"><h2>Hidden</h2>
      <!-- <ul data-plan-done><li>In a comment</li></ul> -->
      <template><ul data-plan-done><li>In a template</li></ul></template>
    </section>
    <section data-plan-step id="e"><h2>Empty</h2><ul data-plan-done></ul></section>
  </body></html>`)!;
  assert.deepEqual(
    plan.steps.map((s) => s.done),
    [['One x', 'Two & three'], ['All of this is one check.'], [], [], []],
  );
});

test('this plan’s own steps all carry done criteria', async () => {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('../../docs/plans/plan-linked-tasks.html', import.meta.url), 'utf8');
  const plan = parsePlan(html)!;
  assert.equal(plan.steps.length, 4);
  for (const s of plan.steps) assert.ok(s.done.length > 0, `${s.id} has criteria`);
});

test('parsePlan needs the marker on <html>, and falls back to <h1> for the title', () => {
  assert.equal(parsePlan('<html><body><section data-plan-step><h2>x</h2></section></body></html>'), null);
  assert.equal(parsePlan('<html><body data-agentdeck-plan="1"></body></html>'), null);
  const bare = parsePlan('<html data-agentdeck-plan><h1>Just &#x2713; a heading</h1></html>')!;
  assert.deepEqual(bare, { version: '1', title: 'Just ✓ a heading', summary: null, steps: [] });
});

test('plan paths and names', () => {
  assert.equal(isPlanPath('docs/plans/cache.html'), true);
  assert.equal(isPlanPath('docs/plans/cache.md'), false);
  assert.equal(isPlanPath('docs/cache.html'), false);
  assert.equal(planName(''), 'plan.html');
});

test('planName keeps the path from docs/plans/ on, and the file name for anything else', () => {
  assert.equal(planName('/Users/me/work/docs/plans/cache.html'), 'docs/plans/cache.html');
  assert.equal(planName('./docs/plans/cache.html'), 'docs/plans/cache.html');
  assert.equal(planName('docs/plans/cache.html'), 'docs/plans/cache.html');
  assert.equal(planName('/repo/docs/plans/sub/cache.html'), 'docs/plans/sub/cache.html');
  assert.equal(planName('/Users/me/work/docs/cache.html'), 'cache.html');
  assert.equal(planName('/tmp/mydocs/plans/cache.html'), 'cache.html');
  assert.equal(planName('cache.html'), 'cache.html');
  assert.equal(planName('/repo/docs/plans/'), 'plan.html');
});

test('the store upserts by name, keeps updated_at for the same HTML, and replaces branch plans', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  db.savePlan(t.id, 'mine.html', 'attached', PLAN);
  db.replaceBranchPlans(t.id, [
    { name: 'docs/plans/a.html', html: PLAN },
    { name: 'docs/plans/b.html', html: PLAN },
  ]);
  db.raw.exec("UPDATE task_plans SET updated_at = '2000-01-01 00:00:00'");
  db.replaceBranchPlans(t.id, [{ name: 'docs/plans/a.html', html: PLAN }]);
  const plans = db.plansForTask(t.id);
  assert.deepEqual(
    plans.map((p) => [p.name, p.source, p.updated_at]),
    [
      ['mine.html', 'attached', '2000-01-01 00:00:00'],
      ['docs/plans/a.html', 'branch', '2000-01-01 00:00:00'],
    ],
  );
  assert.equal(plans[0].title, 'Speed up the & cache');
  assert.equal('html' in plans[0], false);
  assert.equal(db.planHtml(t.id, plans[0].id), PLAN);
  assert.equal(db.planHtml(t.id + 1, plans[0].id), undefined);

  db.replaceBranchPlans(t.id, [{ name: 'docs/plans/a.html', html: PLAN.replace('Measure', 'Profile') }]);
  const a = db.plansForTask(t.id)[1];
  assert.notEqual(a.updated_at, '2000-01-01 00:00:00');
  assert.equal(a.steps[0].title, 'Profile');
  db.replaceBranchPlans(t.id, []);
  assert.deepEqual(
    db.plansForTask(t.id).map((p) => p.name),
    ['mine.html'],
  );
  db.close();
});

// A real repo: the task's branch adds a plan, a plain HTML page and a markdown file.
const db = openDb(join(home, 'test.db'));
const server = await startApi({ db, port: 0 });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  db.close();
});

const repoPath = join(home, 'demo');
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoPath }).toString().trim();
mkdirSync(join(repoPath, 'docs/plans'), { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'Tester');
writeFileSync(join(repoPath, 'README.md'), 'hi\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');
git('checkout', '-q', '-b', 'agentdeck/task-1');
writeFileSync(join(repoPath, 'docs/plans/cache.html'), PLAN);
writeFileSync(join(repoPath, 'docs/plans/page.html'), '<html><body>not a plan</body></html>');
writeFileSync(join(repoPath, 'docs/notes.md'), '# notes\n');
git('add', '-A');
git('commit', '-q', '-m', 'Plan the cache');
git('checkout', '-q', 'main');

const repo = db.addRepo({ name: 'demo', path: repoPath, base_branch: 'main' });
const task = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
db.setCheckout(task.id, { branch: 'agentdeck/task-1' });

const call = async (path: string, json?: unknown) => {
  const res = await fetch(
    base + path,
    json === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) },
  );
  return { status: res.status, body: (await res.json()) as any };
};

test('collectPlans attaches marked HTML under docs/plans/ from the branch, and the task detail lists it', async () => {
  const plans = await collectPlans(db, task.id);
  assert.deepEqual(
    plans.map((p) => [p.name, p.source, p.title]),
    [['docs/plans/cache.html', 'branch', 'Speed up the & cache']],
  );
  const detail = await call(`/api/tasks/${task.id}`);
  assert.equal(detail.body.plans.length, 1);
  assert.equal(detail.body.plans[0].steps.length, 4);
  assert.equal(detail.body.plans[0].html, undefined);
  const full = await call(`/api/tasks/${task.id}/plans/${plans[0].id}`);
  assert.equal(full.status, 200);
  assert.equal(full.body.html, PLAN);
});

test('POST /plans attaches a plan by file name and refuses HTML without the marker', async () => {
  const ok = await call(`/api/tasks/${task.id}/plans`, { name: '/elsewhere/notes/design.html', html: PLAN });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.name, 'design.html');
  assert.equal(ok.body.source, 'attached');

  const bad = await call(`/api/tasks/${task.id}/plans`, { name: 'x.html', html: '<html><body>hi</body></html>' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /data-agentdeck-plan/);
  assert.equal((await call(`/api/tasks/9999/plans`, { html: PLAN })).status, 400);
  assert.equal((await call(`/api/tasks/${task.id}/plans/9999`)).status, 400);

  // Collecting again keeps the attached plan.
  const again = await call(`/api/tasks/${task.id}/plans/collect`, {});
  assert.deepEqual(
    again.body.map((p: any) => p.name),
    ['docs/plans/cache.html', 'design.html'],
  );
});

test('a plan attached from docs/plans/ is replaced by the branch copy, leaving one plan', async () => {
  const other = db.addTask({ repo_id: repo.id, title: 't2', prompt: 'p' });
  db.setCheckout(other.id, { branch: 'agentdeck/task-1' });
  const attached = attachPlan(db, other.id, {
    name: join(repoPath, 'docs/plans/cache.html'),
    html: PLAN.replace('done', 'todo'),
  });
  assert.equal(attached.name, 'docs/plans/cache.html');
  assert.equal(attached.source, 'attached');

  const plans = await collectPlans(db, other.id);
  assert.deepEqual(
    plans.map((p) => [p.name, p.source]),
    [['docs/plans/cache.html', 'branch']],
  );
  assert.equal(plans[0].steps[0].status, 'done');
});

// Tasks linked to plan steps: the plan is read from the repo's base branch when the task is added or edited.
const { editTask, addTask } = await import('../src/application/actions.ts');
const { planStepIds } = await import('../src/domain/task/task.ts');
mkdirSync(join(repoPath, 'docs/plans'), { recursive: true });
writeFileSync(join(repoPath, 'docs/plans/linked.html'), PLAN);
writeFileSync(join(repoPath, 'docs/plans/page.html'), '<html><body>not a plan</body></html>');
git('add', '-A');
git('commit', '-q', '-m', 'Plan on the base branch');

test('add links a task to a plan on the base branch, with and without steps', async () => {
  const some = await addTask(db, { repo: 'demo', prompt: 'do it', plan_path: 'docs/plans/linked.html', plan_steps: 's1, s2' });
  assert.equal(some.plan_path, 'docs/plans/linked.html');
  assert.deepEqual(planStepIds(some), ['s1', 's2']);

  const every = await addTask(db, { repo: 'demo', prompt: 'do it all', plan_path: 'docs/plans/linked.html' });
  assert.equal(every.plan_path, 'docs/plans/linked.html');
  assert.equal(every.plan_steps, null);
  assert.equal(planStepIds(every), null);

  const viaApi = await call('/api/tasks', { repo: 'demo', prompt: 'api', plan_path: 'docs/plans/linked.html', plan_steps: ['s2'] });
  assert.equal(viaApi.body.plan_path, 'docs/plans/linked.html');
  assert.equal(viaApi.body.plan_steps, '["s2"]');

  const plain = await addTask(db, { repo: 'demo', prompt: 'no plan' });
  assert.deepEqual([plain.plan_path, plain.plan_steps], [null, null]);
});

test('add refuses a missing file, a file that is not a plan, an unknown step and steps without a plan', async () => {
  const refuses = (input: Parameters<typeof addTask>[1], message: RegExp) =>
    assert.rejects(addTask(db, { ...input, repo: 'demo', prompt: 'x' }), (err) => err instanceof Error && message.test(err.message));
  await refuses({ prompt: 'x', plan_path: 'docs/plans/missing.html' }, /docs\/plans\/missing\.html is not on demo's base branch/);
  await refuses({ prompt: 'x', plan_path: 'docs/plans/page.html' }, /is not an AgentDeck plan/);
  await refuses({ prompt: 'x', plan_path: 'README.md' }, /not a plan path/);
  await refuses({ prompt: 'x', plan_path: 'docs/plans/../README.md' }, /not a plan path/);
  await refuses(
    { prompt: 'x', plan_path: 'docs/plans/linked.html', plan_steps: 's1,nope,gone' },
    /has no step nope, gone \(it has s1, s2\)/,
  );
  await refuses({ prompt: 'x', plan_steps: 's1' }, /--steps needs --plan/);
  // A plan only on a task branch is not on the base branch.
  await refuses({ prompt: 'x', plan_path: 'docs/plans/cache.html' }, /not on demo's base branch/);
});

test('edit sets, changes and clears the plan link', async () => {
  const t = db.addTask({ repo_id: repo.id, title: 'e', prompt: 'p' });
  const linked = await editTask(db, t.id, { plan_path: 'docs/plans/linked.html', plan_steps: ['s1'] });
  assert.deepEqual([linked.plan_path, planStepIds(linked)], ['docs/plans/linked.html', ['s1']]);

  const moreSteps = await editTask(db, t.id, { plan_steps: 's1,s2' });
  assert.deepEqual(planStepIds(moreSteps), ['s1', 's2']);
  assert.equal((await editTask(db, t.id, { title: 'renamed' })).plan_path, 'docs/plans/linked.html', 'other edits keep the link');

  await assert.rejects(editTask(db, t.id, { plan_steps: 'nope' }), /has no step nope/);
  assert.deepEqual(planStepIds(db.getTask(t.id)!), ['s1', 's2'], 'a refused edit changes nothing');

  const everyStep = await editTask(db, t.id, { plan_steps: null });
  assert.equal(everyStep.plan_steps, null);
  assert.equal(everyStep.plan_path, 'docs/plans/linked.html');

  const cleared = await editTask(db, t.id, { plan_path: '' });
  assert.deepEqual([cleared.plan_path, cleared.plan_steps], [null, null]);

  const other = db.addTask({ repo_id: repo.id, title: 'o', prompt: 'p' });
  await assert.rejects(editTask(db, other.id, { plan_steps: ['s1'] }), /--steps needs --plan/);
  const viaApi = await call(`/api/tasks/${other.id}`, { plan_path: 'docs/plans/linked.html' });
  assert.equal(viaApi.body.plan_path, 'docs/plans/linked.html');
  assert.equal((await call(`/api/tasks/${other.id}`, { plan_path: null })).body.plan_path, null);
});
