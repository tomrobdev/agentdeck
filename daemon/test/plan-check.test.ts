// Linked plan steps a run leaves unfinished: a warning event, a badge flag, and a checklist in the PR body.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-plancheck-'));
process.env.AGENTDECK_HOME = home;
process.env.AGENTDECK_NO_NOTIFY = '1';
const fake = join(import.meta.dirname, 'fake-claude.mjs');
chmodSync(fake, 0o755);
process.env.AGENTDECK_CLAUDE_BIN = fake;

const { openDb } = await import('../src/db/index.ts');
const { Scheduler } = await import('../src/application/scheduler/scheduler.ts');
const { github } = await import('../src/adapters/github.ts');
const { updateRepo } = await import('../src/application/actions.ts');
const { linkedSteps, unfinishedSteps, unfinishedSummary } = await import('../src/domain/plan/plan.ts');
const { buildPrBody } = await import('../src/domain/pull-request/pr.ts');

const plan = (a: string, b: string) => `<!doctype html>
<html data-agentdeck-plan="1"><head><title>Cache plan</title></head><body>
  <p data-plan-summary>Make reads fast.</p>
  <section data-plan-step id="a" data-status="${a}"><h2>Measure</h2>
    <ul data-plan-done><li>A baseline is recorded.</li><li>Tests pass.</li></ul></section>
  <section data-plan-step id="b" data-status="${b}"><h2>Cache</h2><p>Add it.</p></section>
</body></html>`;

test('linked steps by id or all, and which are unfinished', () => {
  const html = plan('done', 'doing');
  assert.deepEqual(
    linkedSteps(html, ['a'])!.map((s) => s.id),
    ['a'],
  );
  assert.deepEqual(
    linkedSteps(html, null)!.map((s) => s.id),
    ['a', 'b'],
  );
  assert.equal(linkedSteps('<html></html>', null), null);
  const left = unfinishedSteps(linkedSteps(plan('skipped', 'blocked'), null)!);
  assert.deepEqual(
    left.map((s) => s.id),
    ['b'],
  );
  assert.equal(unfinishedSummary(left), 'left a linked plan step unfinished: b (blocked)');
});

test('the PR body lists criteria as checkboxes, and has no Plan section without a plan', () => {
  const runs = [{ attempt: 1, outcome: 'done', num_turns: 2, cost_usd: 0.1, tests_passed: 1, result_text: 'Did it.\nSTATUS: DONE' }];
  const steps = linkedSteps(plan('done', 'todo'), null)!;
  const body = buildPrBody({ id: 7 }, runs, { path: 'docs/plans/cache.html', steps });
  assert.match(body, /## Plan: `docs\/plans\/cache\.html`/);
  assert.match(body, /\*\*Measure\*\* \(done\)\n\n- \[ \] A baseline is recorded\.\n- \[ \] Tests pass\./);
  assert.match(body, /\*\*Cache\*\* \(todo\)\n\n\| Attempt/);
  assert.ok(!buildPrBody({ id: 7 }, runs).includes('Plan'));
  assert.ok(!buildPrBody({ id: 7 }, runs, { path: 'docs/plans/cache.html', steps: [] }).includes('Plan'));
});

const db = openDb(join(home, 'test.db'));
db.setSetting('max_concurrent', '1');
after(() => db.close());
const dir = join(home, 'demo');
const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
mkdirSync(join(dir, 'docs/plans'), { recursive: true });
sh('init', '-q', '-b', 'main');
sh('config', 'user.email', 'test@example.com');
sh('config', 'user.name', 'test');
writeFileSync(join(dir, 'README.md'), 'demo\n');
writeFileSync(join(dir, 'docs/plans/open.html'), plan('todo', 'todo'));
writeFileSync(join(dir, 'docs/plans/finished.html'), plan('done', 'skipped'));
sh('add', '-A');
sh('commit', '-q', '-m', 'init');
const repo = db.addRepo({ name: 'demo', path: dir, base_branch: 'main', test_cmd: 'test -f fake-output.txt' });
const drain = () => new Scheduler(db, { once: true, tickMs: 50, log: () => {} }).run();

const bodies: string[] = [];
github.push = async () => {};
github.createPr = async (pr) => {
  bodies.push(pr.body);
  return `https://github.com/acme/demo/pull/${bodies.length}`;
};

const unfinishedEvents = (id: number) => db.eventsForTask(id).filter((e) => e.type === 'plan_unfinished');

test('a done run with every linked step finished records no event', async () => {
  const t = db.addTask({ repo_id: repo.id, title: 'finished', prompt: 'FAKE_DONE x', plan_path: 'docs/plans/finished.html' });
  await drain();
  assert.equal(db.getTask(t.id)!.status, 'done');
  assert.deepEqual(unfinishedEvents(t.id), []);
  assert.ok(!db.planUnfinishedIds().has(t.id));
});

test('a done run with an unfinished linked step records the event and stays done', async () => {
  updateRepo(db, 'demo', { pr_mode: 'draft' });
  const t = db.addTask({
    repo_id: repo.id,
    title: 'unfinished',
    prompt: 'FAKE_DONE y',
    plan_path: 'docs/plans/open.html',
    plan_steps: JSON.stringify(['a']),
  });
  await drain();
  assert.equal(db.getTask(t.id)!.status, 'done');
  const events = unfinishedEvents(t.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, 'left a linked plan step unfinished: a (todo)');
  assert.ok(db.planUnfinishedIds().has(t.id));
  // The PR lists only the linked step, its criteria as checkboxes.
  const body = bodies.at(-1)!;
  assert.match(body, /## Plan: `docs\/plans\/open\.html`/);
  assert.match(body, /\*\*Measure\*\* \(todo\)/);
  assert.match(body, /- \[ \] A baseline is recorded\./);
  assert.ok(!body.includes('**Cache**'), 'step b is not linked');
});

test('a task with no plan gets no Plan section in its PR', async () => {
  const before = bodies.length;
  db.addTask({ repo_id: repo.id, title: 'plain', prompt: 'FAKE_DONE z' });
  await drain();
  assert.equal(bodies.length, before + 1);
  assert.ok(!bodies.at(-1)!.includes('## Plan'));
});
