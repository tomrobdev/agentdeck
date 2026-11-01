// A run's plan: put in the worktree's plan file (.agentdeck/plan.html), which git ignores, and given back after the run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-planruns-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { commitLeftovers } = await import('../src/adapters/git.ts');
const { readPlanFile, writePlanFile } = await import('../src/adapters/plan-file.ts');
const { parsePlan } = await import('../src/domain/plan/plan.ts');

const plan = `<!doctype html>
<html data-agentdeck-plan="1"><head><title>Shared plan</title></head><body>
  <p data-plan-summary>Three steps for three tasks.</p>
  <section data-plan-step id="a" data-status="todo"><h2>A</h2></section>
  <section data-plan-step id="b" data-status="todo"><h2>B</h2></section>
  <section data-plan-step id="c" data-status="todo"><h2>C</h2></section>
</body></html>`;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function newRepo(name: string): string {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

test('commitLeftovers never commits the plan file', async () => {
  const dir = newRepo('leftovers');
  await writePlanFile(dir, plan);
  assert.equal(await readPlanFile(dir), plan);
  assert.equal(git(dir, 'status', '--porcelain'), '', 'the plan folder is ignored');
  assert.equal(await commitLeftovers(dir, 'leftovers'), false);

  writeFileSync(join(dir, 'work.txt'), 'work\n');
  assert.equal(await commitLeftovers(dir, 'leftovers'), true);
  assert.deepEqual(git(dir, 'ls-files').split('\n'), ['README.md', 'work.txt']);

  // A run with no plan clears the file, so a plan written afterwards is the worker's own.
  await writePlanFile(dir, null);
  assert.equal(await readPlanFile(dir), null);
  assert.ok(existsSync(join(dir, '.agentdeck/.gitignore')));
});

const db = openDb(join(home, 'test.db'));
after(() => db.close());
const dir = newRepo('demo');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'test -f fake-output.txt' });
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();
const committed = (branch: string) => git(dir, 'ls-tree', '-r', '--name-only', branch).split('\n');

test('two tasks on one plan each write back only their own steps', async () => {
  db.setSetting('max_concurrent', '2');
  // The worker marks every step of the plan file done, linked or not, with a note in each.
  const owner = db.addTask({ repo_id: repo.id, title: 'a', prompt: 'FAKE_PLAN_ALL a', own_plan: plan, plan_steps: JSON.stringify(['a']) });
  const sibling = db.addTask({
    repo_id: repo.id,
    title: 'b',
    prompt: 'FAKE_PLAN_ALL b',
    plan_task: owner.id,
    plan_steps: JSON.stringify(['b']),
  });
  await drain();
  assert.equal(db.getTask(owner.id)!.status, 'done');
  assert.equal(db.getTask(sibling.id)!.status, 'done');

  const stored = db.ownPlan(owner.id)!;
  assert.equal(stored.name, `${owner.id}-shared-plan.html`);
  assert.deepEqual(
    parsePlan(stored.html)!.steps.map((s) => [s.id, s.status]),
    [
      ['a', 'done'],
      ['b', 'done'],
      ['c', 'todo'],
    ],
  );
  // Each step keeps the note its own task's run put in it; step c, no one's, has none.
  const sections = [...stored.html.matchAll(/<section[\s\S]*?<\/section>/g)].map((m) => m[0]);
  assert.equal(sections.length, 3);
  assert.match(sections[0], /noted by run/);
  assert.match(sections[1], /noted by run/);
  assert.doesNotMatch(sections[2], /noted by run/);
  assert.equal(db.plansForTask(sibling.id).length, 0, 'the sibling stores no plan of its own');

  // The prompt pointed the worker at the plan file; neither branch carries it.
  const calls = readFileSync(join(home, 'fake-claude-calls.log'), 'utf8');
  assert.match(calls, new RegExp(`--- Plan: ${owner.id}-shared-plan\\.html \\(in \\.agentdeck/plan\\.html\\) ---`));
  for (const t of [owner, sibling]) {
    const files = committed(db.getTask(t.id)!.branch!);
    assert.ok(files.includes('fake-output.txt'));
    assert.ok(!files.some((f) => f.startsWith('.agentdeck')), `#${t.id}'s branch has no plan file`);
  }
  assert.deepEqual(
    db.eventsForTask(owner.id).filter((e) => e.type === 'plan_unfinished'),
    [],
    'the linked step is done',
  );
});

test('a plan the worker writes is stored as the task’s own plan, named after it', async () => {
  db.setSetting('max_concurrent', '1');
  const t = db.addTask({ repo_id: repo.id, title: 'plan it', prompt: 'FAKE_WRITE_PLAN plan the work' });
  await drain();
  assert.equal(db.getTask(t.id)!.status, 'done');
  const plans = db.plansForTask(t.id);
  assert.deepEqual(
    plans.map((p) => [p.name, p.source, p.title]),
    [[`${t.id}-fake-plan-two-steps.html`, 'worker', 'Fake Plan: Two Steps!']],
  );
  assert.equal(db.getTask(t.id)!.plan_task, null, 'it follows its own plan without a link');
  assert.ok(!committed(db.getTask(t.id)!.branch!).some((f) => f.startsWith('.agentdeck')));
});
