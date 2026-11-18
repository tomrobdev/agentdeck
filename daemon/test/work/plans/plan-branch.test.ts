import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plan-branch-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('#db/index.ts');
const { Scheduler } = await import('#application/scheduler/scheduler.ts');
const { abandonPlanBranch, addTask, approveTask, editTask, openPlanBranch, taskDetail } = await import('#application/actions.ts');
const { testApp } = await import('#test/fixtures/fixtures.ts');

const db = testApp(openDb(join(home, 'agentdeck.db')));
db.setSetting('max_concurrent', '1');
after(() => db.close());

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

function gitRepo(name: string, origin: boolean): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  if (origin) {
    const bare = join(home, `${name}.git`);
    sh(home, 'init', '-q', '--bare', '-b', 'main', bare);
    sh(dir, 'remote', 'add', 'origin', bare);
    sh(dir, 'push', '-q', '-u', 'origin', 'main');
  }
  db.addRepo({ name, path: dir, base_branch: 'main' });
  return dir;
}

const PLAN = `<!doctype html><html data-agentdeck-plan="1"><head><title>Payments phase</title></head><body>
<section data-plan-step id="a" data-status="todo"><h2>A</h2></section>
<section data-plan-step id="b" data-status="todo"><h2>B</h2></section>
<section data-plan-step id="c" data-status="todo"><h2>C</h2></section>
</body></html>`;

const dir = gitRepo('shop', true);
const bare = join(home, 'shop.git');

test('opening a plan branch targets the plan’s three proposed tasks; the first to start cuts and pushes it from the base', async () => {
  const owner = await addTask(db, { repo: 'shop', prompt: 'the plan', plan_html: PLAN, propose: true });
  const tasks = await Promise.all(
    ['a', 'b', 'c'].map((step) =>
      addTask(db, { repo: 'shop', prompt: `FAKE_DONE step ${step}`, plan_task: owner.id, plan_steps: [step], propose: true }),
    ),
  );
  const base = sh(dir, 'rev-parse', 'main');

  const opened = openPlanBranch(db, tasks[0].id);
  assert.equal(opened.name, `plan/${owner.id}-payments-phase`);
  assert.equal(opened.plan_task, owner.id);
  assert.equal(opened.status, 'open');
  assert.equal(opened.base, 'main');
  assert.deepEqual([...opened.targeted].sort(), [owner.id, ...tasks.map((t) => t.id)].sort());
  for (const t of tasks) assert.equal(db.getTask(t.id)?.target, opened.name);
  assert.equal(sh(dir, 'branch', '--list', opened.name), '', 'not cut before a task starts');
  assert.throws(() => openPlanBranch(db, owner.id), /has a plan branch already/);
  assert.equal((await taskDetail(db, tasks[1].id)).plan_branch?.name, opened.name);

  const later = await addTask(db, { repo: 'shop', prompt: 'later', plan_task: owner.id, propose: true });
  assert.equal(later.target, opened.name, 'a task added later with --plan takes the plan branch');
  const named = await addTask(db, { repo: 'shop', prompt: 'on main', plan_task: owner.id, target: 'main', propose: true });
  assert.equal(named.target, null, 'unless it names another target');
  assert.equal((await editTask(db, named.id, { target: opened.name })).target, opened.name, 'a plan branch is a valid target');

  approveTask(db, tasks[0].id);
  await drain();
  assert.equal(db.getTask(tasks[0].id)?.status, 'done');
  const cut = db.planBranchOf(owner.id, opened.repo_id);
  assert.equal(cut?.status, 'active');
  assert.equal(cut?.head_commit, base);
  assert.equal(sh(dir, 'rev-parse', `refs/heads/${opened.name}`), base, 'cut from the base');
  assert.equal(sh(bare, 'rev-parse', `refs/heads/${opened.name}`), base, 'and pushed');
});

test('abandoning is refused while a task on it runs, then moves its tasks that have not started back to the base', async () => {
  const owner = await addTask(db, { repo: 'shop', prompt: 'another plan', plan_html: PLAN, propose: true });
  const waiting = await addTask(db, { repo: 'shop', prompt: 'waits', plan_task: owner.id, propose: true });
  const runs = await addTask(db, { repo: 'shop', prompt: 'runs', plan_task: owner.id });
  const { name } = openPlanBranch(db, owner.id);
  const claimed = db.claimNextTask();
  assert.equal(claimed?.id, runs.id);
  assert.throws(() => abandonPlanBranch(db, owner.id), new RegExp(`#${runs.id} is running on ${name}`));

  db.applyEvent(runs.id, { type: 'finish', outcome: 'done' });
  db.setCheckout(runs.id, { branch: `agentdeck/task-${runs.id}` });
  const abandoned = abandonPlanBranch(db, waiting.id);
  assert.equal(abandoned.status, 'abandoned');
  assert.deepEqual([...abandoned.moved].sort(), [owner.id, waiting.id].sort());
  assert.equal(db.getTask(waiting.id)?.target, null);
  assert.equal(db.getTask(runs.id)?.target, name, 'a task that started keeps its target');

  assert.throws(() => abandonPlanBranch(db, owner.id), /is abandoned, so it can't be abandoned/);
  assert.throws(() => openPlanBranch(db, owner.id), /has a plan branch already/);
  const after = await addTask(db, { repo: 'shop', prompt: 'after', plan_task: owner.id, propose: true });
  assert.equal(after.target, null, 'an abandoned plan branch is no target');
});

test('a plan branch needs a plan, and abandoning needs a plan branch', async () => {
  const bare = await addTask(db, { repo: 'shop', prompt: 'no plan', propose: true });
  assert.throws(() => openPlanBranch(db, bare.id), /has no plan/);
  const owner = await addTask(db, { repo: 'shop', prompt: 'a plan', plan_html: PLAN, propose: true });
  assert.throws(() => abandonPlanBranch(db, owner.id), /has no plan branch/);
  openPlanBranch(db, owner.id);
  const racing = { ...db, abandonPlanBranch: () => undefined };
  assert.throws(() => abandonPlanBranch(racing, owner.id), /changed while it was being abandoned/);
});

test('in a repo with no origin the plan branch is cut locally and not pushed', async () => {
  const solo = gitRepo('solo', false);
  const owner = await addTask(db, { repo: 'solo', prompt: 'FAKE_DONE solo plan', plan_html: PLAN });
  const { name } = openPlanBranch(db, owner.id);
  await drain();
  assert.equal(db.getTask(owner.id)?.status, 'done');
  assert.equal(sh(solo, 'rev-parse', `refs/heads/${name}`), sh(solo, 'rev-parse', 'main'));
  assert.equal(db.planBranchNamed(asRepo(solo), name)?.status, 'active');
});

function asRepo(path: string) {
  const repo = db.listRepos().find((r) => r.path === path);
  assert.ok(repo);
  return repo.id;
}
