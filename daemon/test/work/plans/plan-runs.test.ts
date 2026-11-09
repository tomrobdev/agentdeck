// A run's plan: put in the worktree's plan file (.agentdeck/plan.html), which git ignores, and given back after the run.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { TaskId } from '../../../src/domain/shared/id.ts';
import { stopReasonOf } from '../../../src/domain/work/task.ts';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-planruns-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, '../../fixtures/fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../../fixtures/open-db.ts');
const { Scheduler } = await import('../../../src/application/scheduler/scheduler.ts');
const { commitLeftovers, ensureWorktree } = await import('../../../src/adapters/git.ts');
const { readPlanFile, writePlanFile } = await import('../../../src/adapters/plan-file.ts');
const { parsePlan } = await import('../../../src/domain/work/plan.ts');
const { planForRun, takePlanFile } = await import('../../../src/application/work/plans.ts');
const { LOG_DIR } = await import('../../../src/config.ts');
const { MAX_RESTARTS } = await import('../../../src/domain/work/lifecycle.ts');

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
  const owner = db.addTask({ repo_id: repo.id, title: 'a', prompt: 'FAKE_PLAN_ALL a', own_plan: plan, plan_steps: ['a'] });
  const sibling = db.addTask({
    repo_id: repo.id,
    title: 'b',
    prompt: 'FAKE_PLAN_ALL b',
    plan_task: owner.id,
    plan_steps: ['b'],
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
    const files = committed(db.getTask(t.id)!.checkout!.branch!);
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
  assert.equal(db.getTask(t.id)!.plan, null, 'it follows its own plan without a link');
  assert.ok(!committed(db.getTask(t.id)!.checkout!.branch!).some((f) => f.startsWith('.agentdeck')));
});

/** Set step `id`'s status in the plan file of `worktree`, as a worker does. */
function markStep(worktree: string, id: string, status: string): void {
  const file = join(worktree, '.agentdeck/plan.html');
  writeFileSync(file, readFileSync(file, 'utf8').replace(new RegExp(`(id="${id}" data-status=)"[^"]*"`), `$1"${status}"`));
}
const statuses = (taskId: TaskId) => parsePlan(db.ownPlan(taskId)!.html)!.steps.map((s) => [s.id, s.status]);

test('a plan’s owner with no --steps does not undo a step a sibling finished while it ran', async () => {
  // The owner was given the plan with --plan <file> and no --steps: it is linked to every step.
  const owner = db.addTask({ repo_id: repo.id, title: 'owner', prompt: 'p', own_plan: plan, status: 'proposed' });
  const sibling = db.addTask({
    repo_id: repo.id,
    title: 'sibling',
    prompt: 'p',
    plan_task: owner.id,
    plan_steps: ['b'],
    status: 'proposed',
  });
  const [ownerTree, siblingTree] = [mkdtempSync(join(home, 'owner-')), mkdtempSync(join(home, 'sibling-'))];
  // Both runs start with the plan as stored.
  await writePlanFile(ownerTree, planForRun(db, db.getTask(owner.id)!)?.html ?? null);
  await writePlanFile(siblingTree, planForRun(db, db.getTask(sibling.id)!)?.html ?? null);
  // The sibling finishes b and ends first; then the owner, which did a, ends.
  markStep(siblingTree, 'b', 'done');
  assert.equal(await takePlanFile(db, db.getTask(sibling.id)!, siblingTree), true);
  markStep(ownerTree, 'a', 'done');
  assert.equal(await takePlanFile(db, db.getTask(owner.id)!, ownerTree), true);
  assert.deepEqual(statuses(owner.id), [
    ['a', 'done'],
    ['b', 'done'],
    ['c', 'todo'],
  ]);
  // Taking the same file again changes nothing.
  assert.equal(await takePlanFile(db, db.getTask(owner.id)!, ownerTree), false);
});

test('a task given its plan with --plan <file>, no one following it, keeps a step its worker added', async () => {
  const t = db.addTask({ repo_id: repo.id, title: 'adds a step', prompt: 'p', own_plan: plan, status: 'proposed' });
  assert.equal(t.plan?.task, t.id);
  const tree = mkdtempSync(join(home, 'adds-'));
  await writePlanFile(tree, planForRun(db, t)?.html ?? null);
  const file = join(tree, '.agentdeck/plan.html');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('</body>', '<section data-plan-step id="d" data-status="todo"><h2>D</h2></section>\n</body>'),
  );
  markStep(tree, 'a', 'done');
  assert.equal(await takePlanFile(db, t, tree), true);
  assert.deepEqual(statuses(t.id), [
    ['a', 'done'],
    ['b', 'todo'],
    ['c', 'todo'],
    ['d', 'todo'],
  ]);
});

test('the step statuses a run marked before a restart cut it off survive when its session cannot be resumed', async () => {
  db.setSetting('max_concurrent', '1');
  const t = db.addTask({ repo_id: repo.id, title: 'cut off', prompt: 'FAKE_DONE after a restart', own_plan: plan });
  // A run that a restart cut off before claude named a session, after the worker finished step a.
  const claimed = db.claimNextTask()!;
  assert.equal(claimed.id, t.id);
  const wt = await ensureWorktree(repo, claimed);
  db.setCheckout(t.id, { branch: wt.branch, worktree: wt.path });
  db.startRun(t.id, claimed.attempts, join(LOG_DIR, `task-${t.id}-attempt-1.jsonl`));
  await writePlanFile(wt.path, planForRun(db, claimed)?.html ?? null);
  markStep(wt.path, 'a', 'done');
  assert.deepEqual(db.recoverOrphans(), { requeued: 1, failed: [] });

  await drain();
  const after = db.getTask(t.id)!;
  assert.equal(after.status, 'done', stopReasonOf(after) ?? '');
  assert.deepEqual(
    db.runsForTask(t.id).map((r) => [r.outcome, r.session_id === null]),
    [
      ['interrupted', true],
      ['done', false],
    ],
    'the cut-off run had no session to resume; the next one started afresh',
  );
  assert.deepEqual(statuses(t.id), [
    ['a', 'done'],
    ['b', 'todo'],
    ['c', 'todo'],
  ]);
});

test('the step statuses a cut-off run marked survive when the restarts fail the task and a person retries it', async () => {
  db.setSetting('max_concurrent', '1');
  const t = db.addTask({ repo_id: repo.id, title: 'restarted out', prompt: 'FAKE_DONE after a retry', own_plan: plan });
  // Restart after restart cuts its runs off, until the last recovery fails the task; the last run had finished step a.
  for (let i = 0; i < MAX_RESTARTS; i++) {
    const claimed = db.claimNextTask()!;
    assert.equal(claimed.id, t.id);
    const wt = await ensureWorktree(repo, claimed);
    db.setCheckout(t.id, { branch: wt.branch, worktree: wt.path });
    db.startRun(t.id, claimed.attempts, join(LOG_DIR, `task-${t.id}-attempt-${claimed.attempts}.jsonl`));
    await writePlanFile(wt.path, planForRun(db, claimed)?.html ?? null);
    if (i === MAX_RESTARTS - 1) markStep(wt.path, 'a', 'done');
    db.recoverOrphans();
  }
  assert.equal(db.getTask(t.id)!.status, 'failed');
  // The person's retry is a new attempt.
  assert.equal(db.applyEvent(t.id, { type: 'retry' })?.task.status, 'queued');

  await drain();
  const after = db.getTask(t.id)!;
  assert.equal(after.status, 'done', stopReasonOf(after) ?? '');
  assert.equal(after.attempts, 2);
  assert.deepEqual(statuses(t.id), [
    ['a', 'done'],
    ['b', 'todo'],
    ['c', 'todo'],
  ]);
});
