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
const { collectPlans } = await import('../src/application/plans.ts');

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
    { id: 's1', title: 'Measure', status: 'done' },
    { id: 's2', title: 'Add the LRU', status: 'doing' },
    { id: null, title: 'Unknown status', status: 'todo' },
    { id: null, title: 'Named step', status: 'skipped' },
  ]);
  assert.deepEqual(planProgress(plan.steps), { finished: 2, total: 4 });
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
  assert.equal(planName('/Users/me/work/docs/plans/cache.html'), 'cache.html');
  assert.equal(planName(''), 'plan.html');
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
const server = await startApi(db, 0);
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
db.updateTask(task.id, { branch: 'agentdeck/task-1' });

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
  const ok = await call(`/api/tasks/${task.id}/plans`, { name: '/elsewhere/docs/plans/design.html', html: PLAN });
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
