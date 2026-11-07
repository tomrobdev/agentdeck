// Plans: the format's parser, naming, the step merge, the store, and linking tasks to plans from the CLI and the API.
import assert from 'node:assert/strict';
import { asTaskId } from '../src/domain/shared/id.ts';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plans-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';

const { isOwnPlanName, mergePlanSteps, parsePlan, planAfterRun, planFileName, planProgress, planSlug } =
  await import('../src/domain/work/plan.ts');
const { openDb } = await import('../src/db/index.ts');
const { startApi } = await import('../src/api/server.ts');
const { attachPlan } = await import('../src/application/plans.ts');
const { editTask, addTask } = await import('../src/application/actions.ts');

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

test('this plan’s own steps all carry done criteria', () => {
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

test('a plan is named after the task it belongs to and its title', () => {
  assert.equal(planSlug('Plans in AgentDeck'), 'plans-in-agentdeck');
  assert.equal(planSlug('  Speed up the & cache!! '), 'speed-up-the-cache');
  assert.equal(planSlug('Café — crème'), 'cafe-creme');
  assert.equal(planSlug('***'), 'plan');
  assert.equal(planSlug('x'.repeat(80)).length, 60);
  assert.equal(planFileName(112, 'Plans in AgentDeck'), '112-plans-in-agentdeck.html');
  assert.equal(isOwnPlanName(112, '112-plans-in-agentdeck.html'), true);
  assert.equal(isOwnPlanName(12, '112-plans-in-agentdeck.html'), false);
  assert.equal(isOwnPlanName(112, 'docs/plans/cache.html'), false);
  assert.equal(isOwnPlanName(112, 'cache.html'), false);
});

const steps3 = (a: string, b: string, c: string, extra = '') => `<html data-agentdeck-plan="1"><head><title>Three</title></head><body>
  <p data-plan-summary>Summary${extra}</p>
  <!-- <section data-plan-step id="a" data-status="skipped"><h2>Old</h2></section> -->
  <section data-plan-step id="a" data-status="${a}"><h2>A</h2></section>
  <section data-plan-step id="b" data-status="${b}"><h2>B</h2></section>
  <section data-plan-step data-status="${c}"><h2>Unnamed</h2></section>
</body></html>`;

test('mergePlanSteps takes only the linked steps from the plan file', () => {
  const stored = steps3('todo', 'todo', 'todo');
  // The worker marked every step and changed the summary; only step a is its own.
  const written = steps3('done', 'done', 'done', ' changed').replace('<h2>A</h2>', '<h2>A</h2><p>Note on a</p>');
  const merged = mergePlanSteps(stored, written, ['a'], stored);
  assert.deepEqual(
    parsePlan(merged)!.steps.map((s) => s.status),
    ['done', 'todo', 'todo'],
  );
  assert.match(merged, /Note on a/);
  assert.match(merged, /<p data-plan-summary>Summary<\/p>/, 'the rest stays as stored');
  assert.match(merged, /<!-- <section data-plan-step id="a" data-status="skipped">/, 'a commented-out step is left alone');
  // Every step: only steps with an id are saved back.
  assert.deepEqual(
    parsePlan(mergePlanSteps(stored, written, null, stored))!.steps.map((s) => s.status),
    ['done', 'done', 'todo'],
  );
  // A file that is not a plan, or lacks the step, changes nothing.
  assert.equal(mergePlanSteps(stored, '<html>gone</html>', null, stored), stored);
  assert.equal(
    mergePlanSteps(stored, written.replace(/<section data-plan-step id="a" data-status="done">[\s\S]*?<\/section>/, ''), ['a'], stored),
    stored,
  );
});

test('mergePlanSteps saves only the steps the run changed from the copy it was given', () => {
  // The run was given a and b todo; meanwhile b was finished elsewhere. The run changed only a.
  const given = steps3('todo', 'todo', 'todo');
  const stored = steps3('todo', 'done', 'todo');
  const written = steps3('done', 'todo', 'todo');
  assert.deepEqual(
    parsePlan(mergePlanSteps(stored, written, null, given))!.steps.map((s) => s.status),
    ['done', 'done', 'todo'],
  );
});

test('inserting a step without an id shifts and loses none of the others', () => {
  const plan = (body: string) => `<html data-agentdeck-plan="1"><head><title>Unnamed</title></head><body>${body}</body></html>`;
  const x = '<section data-plan-step data-status="todo"><h2>X</h2></section>';
  const y = '<section data-plan-step data-status="todo"><h2>Y</h2></section>';
  const stored = plan(`<section data-plan-step id="a" data-status="todo"><h2>A</h2></section>${x}${y}`);
  // The worker finished a and inserted a new step, without an id, before X.
  const written = plan(
    `<section data-plan-step id="a" data-status="done"><h2>A</h2></section><section data-plan-step data-status="todo"><h2>New</h2></section>${x}${y}`,
  );
  const merged = parsePlan(mergePlanSteps(stored, written, null, stored))!;
  assert.deepEqual(
    merged.steps.map((s) => [s.title, s.status]),
    [
      ['A', 'done'],
      ['X', 'todo'],
      ['Y', 'todo'],
    ],
  );
});

test('planAfterRun keeps the whole file only for an own plan no one else follows and no one changed meanwhile', () => {
  const given = steps3('todo', 'todo', 'todo');
  const written = steps3('done', 'todo', 'todo').replace(
    '</body>',
    '<section data-plan-step id="extra" data-status="todo"><h2>Extra</h2></section></body>',
  );
  const run = { stored: given, given, written, ids: ['a'], own: true, followed: false };
  assert.equal(planAfterRun(run), written, 'the whole file, the added step too');
  for (const other of [{ own: false }, { followed: true }, { given: null }, { stored: steps3('todo', 'done', 'todo') }]) {
    const after = parsePlan(planAfterRun({ ...run, ...other }))!;
    assert.ok(!after.steps.some((s) => s.id === 'extra'), `merged, not whole: ${JSON.stringify(other)}`);
    assert.equal(after.steps[0].status, 'done', 'the linked step is saved back');
  }
  assert.equal(planAfterRun({ ...run, written: '<html>gone</html>' }), given);
});

test('two tasks on one plan, running at once, each write back only their own steps', () => {
  const stored = steps3('todo', 'todo', 'todo');
  // Both runs got the same plan file and marked every step; they give it back one after the other.
  const fromA = steps3('done', 'done', 'blocked');
  const fromB = steps3('blocked', 'done', 'done');
  const afterA = mergePlanSteps(stored, fromA, ['a'], stored);
  const afterB = mergePlanSteps(afterA, fromB, ['b'], stored);
  assert.deepEqual(
    parsePlan(afterB)!.steps.map((s) => [s.id, s.status]),
    [
      ['a', 'done'],
      ['b', 'done'],
      [null, 'todo'],
    ],
  );
});

test('the store keeps a task’s own plan under its numbered name, replacing it in place', () => {
  const db = openDb(':memory:');
  const repo = db.addRepo({ name: 'r', path: '/tmp/r', base_branch: 'main' });
  const t = db.addTask({ repo_id: repo.id, title: 't', prompt: 'p' });
  db.raw.prepare("INSERT INTO task_plans (task_id, name, source, html) VALUES (?, 'docs/plans/old.html', 'branch', ?)").run(t.id, PLAN);
  assert.equal(db.ownPlan(t.id), undefined, 'a plan stored before plans had numbers is not the task’s own');

  const first = db.saveOwnPlan(t.id, PLAN, 'attached');
  assert.deepEqual([first.name, first.source, first.task_id], [`${t.id}-speed-up-the-cache.html`, 'attached', t.id]);
  db.raw.exec("UPDATE task_plans SET updated_at = '2000-01-01 00:00:00'");
  assert.equal(db.saveOwnPlan(t.id, PLAN, 'attached').updated_at, '2000-01-01 00:00:00', 'the same HTML changes nothing');

  const renamed = db.saveOwnPlan(t.id, PLAN.replace('Speed up the &amp; cache', 'Faster reads'), 'worker');
  assert.equal(renamed.id, first.id, 'the row is kept');
  assert.deepEqual([renamed.name, renamed.source], [`${t.id}-faster-reads.html`, 'worker']);
  assert.notEqual(renamed.updated_at, '2000-01-01 00:00:00');
  assert.deepEqual(
    db.plansForTask(t.id).map((p) => p.name),
    ['docs/plans/old.html', `${t.id}-faster-reads.html`],
  );
  assert.equal(db.ownPlan(t.id)!.id, first.id);

  db.raw.exec("UPDATE task_plans SET updated_at = '2000-01-01 00:00:00'");
  db.updatePlanHtml(first.id, db.ownPlan(t.id)!.html);
  assert.equal(db.plansForTask(t.id)[1].updated_at, '2000-01-01 00:00:00');
  db.updatePlanHtml(first.id, PLAN);
  assert.equal(db.ownPlan(t.id)!.html, PLAN);
  assert.equal(db.ownPlan(t.id)!.name, `${t.id}-faster-reads.html`, 'a write-back keeps the name');
  db.close();
});

// A real repo, the API, the CLI and the use cases.
const db = openDb(join(home, 'agentdeck.db'));
const server = await startApi({ db, port: 0 });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.close();
  db.close();
});

const repoPath = join(home, 'demo');
const git = (...a: string[]) => execFileSync('git', a, { cwd: repoPath }).toString().trim();
mkdirSync(repoPath, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'Tester');
writeFileSync(join(repoPath, 'README.md'), 'hi\n');
git('add', '-A');
git('commit', '-q', '-m', 'init');
const head = git('rev-parse', 'HEAD');

const repo = db.addRepo({ name: 'demo', path: repoPath, base_branch: 'main' });
const otherRepo = db.addRepo({ name: 'other', path: join(home, 'other'), base_branch: 'main' });
/** A task's plan link as [task, steps]. */
const link = (t: { plan: { task: number; steps: string[] | null } | null }) => [t.plan?.task ?? null, t.plan?.steps ?? null];

// A plan file outside the repo, its steps a and b.
const elsewhere = mkdtempSync(join(tmpdir(), 'agentdeck-plan-file-'));
const planFile = join(elsewhere, 'x.html');
writeFileSync(planFile, PLAN.replace('id="s1"', 'id="a"').replace("id='s2'", "id='b'"));

const call = async (path: string, json?: unknown) => {
  const res = await fetch(
    base + path,
    json === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) },
  );
  return { status: res.status, body: (await res.json()) as any };
};

const CLI = join(import.meta.dirname, '../src/cli.ts');
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AGENTDECK_HOME: home, AGENTDECK_TASK_ID: '', AGENTDECK_PLANNER: '' },
  });

test('agentdeck add --plan <file> stores the plan under its numbered name, with no commit to the repo', () => {
  const added = cli('add', 'Measure first', '--repo', 'demo', '--plan', planFile, '--steps', 'a');
  assert.equal(added.status, 0, added.stderr);
  const id = asTaskId(Number(/task #(\d+)/.exec(added.stdout)![1]));
  const name = `${id}-speed-up-the-cache.html`;
  assert.match(added.stdout, new RegExp(`plan +${name}`));

  const t = db.getTask(id)!;
  assert.deepEqual(link(t), [id, ['a']]);
  const row = db.raw.prepare('SELECT plan_path FROM tasks WHERE id = ?').get(id) as { plan_path: string | null };
  assert.equal(row.plan_path, null, 'the legacy column is not written');
  assert.deepEqual(
    db.plansForTask(id).map((p) => [p.name, p.source]),
    [[name, 'attached']],
  );
  assert.equal(git('rev-parse', 'HEAD'), head, 'nothing was committed');
  assert.equal(git('status', '--porcelain'), '');

  const shown = cli('show', String(id));
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`plan +${name} \\(steps a\\)`));

  // A task number links that task's plan.
  const follower = cli('add', 'Then cache', '--repo', 'demo', '--plan', `#${id}`, '--steps', 'b');
  assert.equal(follower.status, 0, follower.stderr);
  const fid = Number(/task #(\d+)/.exec(follower.stdout)![1]);
  assert.match(follower.stdout, new RegExp(`plan +${name} \\(#${id}'s plan\\)`));
  assert.match(cli('show', String(fid)).stdout, new RegExp(`plan +${name} \\(#${id}'s plan, steps b\\)`));

  const notPlan = join(elsewhere, 'page.html');
  writeFileSync(notPlan, '<html><body>not a plan</body></html>');
  assert.match(cli('add', 'x', '--repo', 'demo', '--plan', notPlan).stderr, /not an AgentDeck plan/);
  assert.match(cli('add', 'x', '--repo', 'demo', '--plan', join(elsewhere, 'missing.html')).stderr, /can't read/);
  assert.match(
    cli('add', 'x', '--repo', 'demo', '--plan', planFile, '--steps', 'nope').stderr,
    /the plan has no step nope \(it has a, b\)/,
  );
});

test('add links a task to another task’s plan by number, and refuses what does not hold', async () => {
  const owner = await addTask(db, { repo: 'demo', prompt: 'own it', plan_html: readFileSync(planFile, 'utf8') });
  assert.equal(owner.plan?.task, owner.id);
  const name = `${owner.id}-speed-up-the-cache.html`;

  const some = await addTask(db, { repo: 'demo', prompt: 'do b', plan_task: owner.id, plan_steps: 'b' });
  assert.deepEqual(link(some), [owner.id, ['b']]);
  // Following a task that follows a plan follows that plan.
  const viaFollower = await addTask(db, { repo: 'demo', prompt: 'do a', plan_task: some.id, plan_steps: ['a'] });
  assert.equal(viaFollower.plan?.task, owner.id);
  const every = await addTask(db, { repo: 'demo', prompt: 'do it all', plan_task: owner.id });
  assert.deepEqual(link(every), [owner.id, null]);

  const viaApi = await call('/api/tasks', { repo: 'demo', prompt: 'api', plan_task: owner.id, plan_steps: ['a'] });
  assert.equal(viaApi.status, 200);
  assert.deepEqual([viaApi.body.plan_task, viaApi.body.plan_steps], [owner.id, '["a"]']);
  // The follower's detail shows the plan it follows, read from the task it belongs to.
  const detail = await call(`/api/tasks/${viaApi.body.id}`);
  assert.deepEqual(
    detail.body.plans.map((p: any) => [p.task_id, p.name]),
    [[owner.id, name]],
  );
  const full = await call(`/api/tasks/${owner.id}/plans/${detail.body.plans[0].id}`);
  assert.equal(full.body.html, readFileSync(planFile, 'utf8'));

  const refuses = (input: Partial<Parameters<typeof addTask>[1]>, message: RegExp) =>
    assert.rejects(addTask(db, { repo: 'demo', prompt: 'x', ...input }), (err) => err instanceof Error && message.test(err.message));
  await refuses({ plan_task: owner.id, plan_steps: 'a,nope,gone' }, new RegExp(`${name} has no step nope, gone \\(it has a, b\\)`));
  await refuses({ plan_task: asTaskId(9999) }, /there is no task #9999/);
  const plain = db.addTask({ repo_id: repo.id, title: 'plain', prompt: 'p' });
  await refuses({ plan_task: plain.id }, new RegExp(`#${plain.id} has no plan`));
  const elsewhereTask = db.addTask({ repo_id: otherRepo.id, title: 'other', prompt: 'p' });
  db.saveOwnPlan(elsewhereTask.id, PLAN, 'attached');
  await refuses({ plan_task: elsewhereTask.id }, new RegExp(`#${elsewhereTask.id} is in other, not demo`));
  await refuses({ plan_steps: 's1' }, /--steps needs --plan/);
  await refuses({ plan_task: 'x' as never }, /plan_task must be a task number/);
  await refuses({ plan_task: owner.id, plan_html: PLAN }, /not both/);
  assert.equal((await call('/api/tasks', { repo: 'demo', prompt: 'x', plan_task: '12' })).status, 400);
});

test('edit sets, changes and clears the plan link', async () => {
  const owner = await addTask(db, { repo: 'demo', prompt: 'owner', plan_html: readFileSync(planFile, 'utf8') });
  const t = db.addTask({ repo_id: repo.id, title: 'e', prompt: 'p' });
  const linked = await editTask(db, t.id, { plan_task: owner.id, plan_steps: ['a'] });
  assert.deepEqual(link(linked), [owner.id, ['a']]);

  const moreSteps = await editTask(db, t.id, { plan_steps: 'a,b' });
  assert.deepEqual(moreSteps.plan?.steps, ['a', 'b']);
  assert.equal((await editTask(db, t.id, { title: 'renamed' })).plan?.task, owner.id, 'other edits keep the link');

  await assert.rejects(editTask(db, t.id, { plan_steps: 'nope' }), /has no step nope/);
  assert.deepEqual(db.getTask(t.id)!.plan?.steps, ['a', 'b'], 'a refused edit changes nothing');

  const everyStep = await editTask(db, t.id, { plan_steps: null });
  assert.deepEqual(link(everyStep), [owner.id, null]);

  const cleared = await editTask(db, t.id, { plan_task: null });
  assert.deepEqual(link(cleared), [null, null]);

  // A plan file becomes the task's own plan.
  const own = await editTask(db, t.id, { plan_html: PLAN, plan_steps: 's2' });
  assert.deepEqual(link(own), [t.id, ['s2']]);
  assert.equal(db.ownPlan(t.id)!.name, `${t.id}-speed-up-the-cache.html`);

  const other = db.addTask({ repo_id: repo.id, title: 'o', prompt: 'p' });
  await assert.rejects(editTask(db, other.id, { plan_steps: ['s1'] }), /--steps needs --plan/);
  const viaApi = await call(`/api/tasks/${other.id}`, { plan_task: owner.id });
  assert.equal(viaApi.body.plan_task, owner.id);
  assert.equal((await call(`/api/tasks/${other.id}`, { plan_task: null })).body.plan_task, null);
});

test('attach stores or replaces the task’s own plan under its numbered name, and refuses HTML that is not a plan', async () => {
  const t = db.addTask({ repo_id: repo.id, title: 'attach', prompt: 'p' });
  const ok = await call(`/api/tasks/${t.id}/plans`, { html: PLAN });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.name, ok.body.source], [`${t.id}-speed-up-the-cache.html`, 'attached']);

  const again = attachPlan(db, t.id, { html: PLAN.replace('Speed up the &amp; cache', 'Cache v2') });
  assert.equal(again.id, ok.body.id);
  assert.equal(again.name, `${t.id}-cache-v2.html`);
  assert.equal(db.plansForTask(t.id).length, 1);

  const shown = cli('attach', String(t.id), planFile);
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`#${t.id} plan: Speed up the & cache \\(${t.id}-speed-up-the-cache\\.html, 2/4 steps\\)`));

  const bad = await call(`/api/tasks/${t.id}/plans`, { html: '<html><body>hi</body></html>' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /data-agentdeck-plan/);
  assert.equal((await call(`/api/tasks/9999/plans`, { html: PLAN })).status, 400);
  assert.equal((await call(`/api/tasks/${t.id}/plans/9999`)).status, 400);
});

test('attach refuses a running task: its run’s end would write the old plan back', async () => {
  const t = db.addTask({ repo_id: repo.id, title: 'running', prompt: 'p', own_plan: PLAN });
  for (const status of ['running', 'cancel_requested']) {
    db.raw.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, t.id);
    assert.throws(
      () => attachPlan(db, t.id, { html: PLAN.replace('Speed up the &amp; cache', 'Replaced') }),
      new RegExp(`#${t.id} is ${status}; a plan can't be attached while it runs`),
    );
    const viaApi = await call(`/api/tasks/${t.id}/plans`, { html: PLAN });
    assert.equal(viaApi.status, 400);
  }
  assert.equal(db.ownPlan(t.id)!.html, PLAN, 'the plan is untouched');
});

test('replacing a plan that drops a step a follower links is refused, naming the follower', async () => {
  const html = readFileSync(planFile, 'utf8'); // steps a and b
  const owner = await addTask(db, { repo: 'demo', prompt: 'owner', plan_html: html, plan_steps: 'a' });
  const follower = await addTask(db, { repo: 'demo', prompt: 'follows b', plan_task: owner.id, plan_steps: 'b' });
  const finished = await addTask(db, { repo: 'demo', prompt: 'did b', plan_task: owner.id, plan_steps: 'b' });
  db.raw.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(finished.id);
  const renamed = html.replace("id='b'", "id='b2'");
  const refused = new RegExp(`the new plan drops steps that tasks following it link: #${follower.id} \\(b\\)$`);

  assert.throws(() => attachPlan(db, owner.id, { html: renamed }), refused);
  await assert.rejects(editTask(db, owner.id, { plan_html: renamed, plan_steps: 'a' }), refused);
  assert.equal(db.ownPlan(owner.id)!.html, html, 'the plan is untouched');
  // attach checks the owner's own linked steps too (edit checks the steps it names).
  assert.throws(() => attachPlan(db, owner.id, { html: html.replace('id="a"', 'id="a2"') }), new RegExp(`#${owner.id} \\(a\\)`));
  // A plan that keeps the linked ids replaces it.
  const kept = html.replace('Speed up the &amp; cache', 'Kept ids');
  assert.equal(attachPlan(db, owner.id, { html: kept }).name, `${owner.id}-kept-ids.html`);
});
