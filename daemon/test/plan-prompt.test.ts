// The linked plan steps in a worker's prompt (domain/runs/prompt.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlanWithText } from '../src/domain/work/plan.ts';
import { buildPrompt, planPromptBlock, workerSystemPrompt } from '../src/domain/runs/prompt.ts';

const plan = (statuses: [string, string, string]) => `<!doctype html>
<html data-agentdeck-plan="1"><head><title>Cache plan</title></head><body>
  <p data-plan-summary>Make reads fast.</p>
  <section data-plan-step id="a" data-status="${statuses[0]}"><h2>Measure</h2><p>Time the <code>read</code> path.</p>
    <ul data-plan-done><li>A baseline is recorded.</li></ul></section>
  <section data-plan-step id="b" data-status="${statuses[1]}"><h2>Cache</h2><p>Add the cache.</p></section>
  <section data-plan-step id="c" data-status="${statuses[2]}"><h2>Docs</h2><p>Write it up.</p></section>
</body></html>`;

const NAME = '12-cache-plan.html';
const task = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    prompt: 'Goal: speed up reads.',
    attempts: 1,
    plan_task: 12,
    plan_steps: null,
    ...over,
  }) as never;

test('step text leaves out the heading and the done criteria', () => {
  const parsed = parsePlanWithText(plan(['todo', 'todo', 'todo']))!;
  assert.deepEqual(parsed.texts, ['Time the read path.', 'Add the cache.', 'Write it up.']);
});

test('the block carries the linked steps by id, and says where the plan file is', () => {
  const block = planPromptBlock({ name: NAME, html: plan(['todo', 'todo', 'doing']), steps: ['a', 'c'] });
  assert.match(block, /--- Plan: 12-cache-plan\.html \(in \.agentdeck\/plan\.html\) ---/);
  assert.match(block, /Cache plan/);
  assert.match(block, /Make reads fast\./);
  assert.match(block, /Step "a": Measure \(status: todo\)\nTime the read path\.\nDone when:\n- A baseline is recorded\./);
  assert.match(block, /Step "c": Docs \(status: doing\)/);
  assert.ok(!block.includes('Add the cache.'), 'step b is not linked');
  assert.match(block, /Do only these steps\. Set each one's data-status in \.agentdeck\/plan\.html as you go, and never commit that file/);
  assert.ok(!/commit the plan/i.test(block));
});

test('without linked steps every unfinished step is carried, and finished steps are left out', () => {
  const block = planPromptBlock({ name: NAME, html: plan(['done', 'blocked', 'skipped']), steps: null });
  assert.match(block, /Step "b": Cache \(status: blocked\)/);
  assert.ok(!block.includes('Measure') && !block.includes('Docs'));
  const all = planPromptBlock({ name: NAME, html: plan(['done', 'todo', 'skipped']), steps: ['a', 'c'] });
  assert.match(all, /already done or skipped/);
});

test('a retry sees the statuses the earlier attempt left in the stored plan', () => {
  const first = buildPrompt(task(), [], null, { name: NAME, html: plan(['todo', 'todo', 'todo']), steps: ['a', 'b'] });
  assert.match(first, /Step "a"/);
  const previous = { kind: 'work', outcome: 'failed', tests_passed: 0, result_text: null } as never;
  const retry = buildPrompt(task({ attempts: 2 }), [previous], null, {
    name: NAME,
    html: plan(['done', 'todo', 'todo']),
    steps: ['a', 'b'],
  });
  assert.ok(!retry.includes('Step "a"'));
  assert.match(retry, /Step "b"/);
  assert.match(retry, /This is attempt 2/);
});

test('a missing plan leaves the task prompt and says so', () => {
  const prompt = buildPrompt(task(), [], null, { name: "#12's plan", html: null, steps: null });
  assert.ok(prompt.startsWith('Goal: speed up reads.'));
  assert.match(prompt, /The plan #12's plan could not be read/);
  assert.equal(buildPrompt(task(), []), 'Goal: speed up reads.', 'no plan, no block');
});

test('the system prompt has the worker write plans to the plan file, never committed, and never under docs/plans/', () => {
  const system = workerSystemPrompt('pnpm test');
  assert.match(system, /write it to \.agentdeck\/plan\.html/);
  assert.match(system, /never commit it/);
  assert.ok(!system.includes('docs/plans'));
  assert.ok(!/commit (it|the plan)\. /.test(system));
});
