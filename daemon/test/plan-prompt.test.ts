// The linked plan steps in a worker's prompt (domain/run/prompt.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlanWithText } from '../src/domain/plan/plan.ts';
import { buildPrompt, planPromptBlock } from '../src/domain/run/prompt.ts';

const plan = (statuses: [string, string, string]) => `<!doctype html>
<html data-agentdeck-plan="1"><head><title>Cache plan</title></head><body>
  <p data-plan-summary>Make reads fast.</p>
  <section data-plan-step id="a" data-status="${statuses[0]}"><h2>Measure</h2><p>Time the <code>read</code> path.</p>
    <ul data-plan-done><li>A baseline is recorded.</li></ul></section>
  <section data-plan-step id="b" data-status="${statuses[1]}"><h2>Cache</h2><p>Add the cache.</p></section>
  <section data-plan-step id="c" data-status="${statuses[2]}"><h2>Docs</h2><p>Write it up.</p></section>
</body></html>`;

const task = (plan_steps: string[] | null, over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    prompt: 'Goal: speed up reads.',
    attempts: 1,
    plan_path: 'docs/plans/cache.html',
    plan_steps: plan_steps && JSON.stringify(plan_steps),
    ...over,
  }) as never;

test('step text leaves out the heading and the done criteria', () => {
  const parsed = parsePlanWithText(plan(['todo', 'todo', 'todo']))!;
  assert.deepEqual(parsed.texts, ['Time the read path.', 'Add the cache.', 'Write it up.']);
});

test('the block carries the linked steps by id', () => {
  const block = planPromptBlock(task(['a', 'c']), { path: 'docs/plans/cache.html', html: plan(['todo', 'todo', 'doing']) });
  assert.match(block, /docs\/plans\/cache\.html/);
  assert.match(block, /Cache plan/);
  assert.match(block, /Make reads fast\./);
  assert.match(block, /Step "a": Measure \(status: todo\)\nTime the read path\.\nDone when:\n- A baseline is recorded\./);
  assert.match(block, /Step "c": Docs \(status: doing\)/);
  assert.ok(!block.includes('Add the cache.'), 'step b is not linked');
  assert.match(block, /Do only these steps\. Set each one's data-status in docs\/plans\/cache\.html/);
});

test('without plan_steps every unfinished step is carried, and finished steps are left out', () => {
  const block = planPromptBlock(task(null), { path: 'docs/plans/cache.html', html: plan(['done', 'blocked', 'skipped']) });
  assert.match(block, /Step "b": Cache \(status: blocked\)/);
  assert.ok(!block.includes('Measure') && !block.includes('Docs'));
  const all = planPromptBlock(task(['a', 'c']), { path: 'docs/plans/cache.html', html: plan(['done', 'todo', 'skipped']) });
  assert.match(all, /already done or skipped/);
});

test('a retry sees the statuses the earlier attempt left on the branch', () => {
  const first = buildPrompt(task(['a', 'b']), [], null, { path: 'docs/plans/cache.html', html: plan(['todo', 'todo', 'todo']) });
  assert.match(first, /Step "a"/);
  const previous = { kind: 'work', outcome: 'failed', tests_passed: 0, result_text: null } as never;
  const retry = buildPrompt(task(['a', 'b'], { attempts: 2 }), [previous], null, {
    path: 'docs/plans/cache.html',
    html: plan(['done', 'todo', 'todo']),
  });
  assert.ok(!retry.includes('Step "a"'));
  assert.match(retry, /Step "b"/);
  assert.match(retry, /This is attempt 2/);
});

test('a missing plan leaves the task prompt and says so', () => {
  const prompt = buildPrompt(task(null), [], null, { path: 'docs/plans/cache.html', html: null });
  assert.ok(prompt.startsWith('Goal: speed up reads.'));
  assert.match(prompt, /docs\/plans\/cache\.html is not on this branch/);
  assert.equal(buildPrompt(task(null), []), 'Goal: speed up reads.', 'no plan, no block');
});
