// What the peek pane says of a task: its prompt's Goal, its model, its links and the actions for its stage. The dashboard has no
// test runner, so its rules are tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promptGoal } from '../../../../src/domain/work/index.ts';
import { promptSections } from '../../../../src/domain/work/task/task.ts';
import { linkParts, modelChip, modelLine, ownSteps, peekActions, peekProps } from '../../../../../app/src/lib/work/queue/peek.ts';

test('a prompt with sections shows its Goal, cut to a few lines', () => {
  const prompt = '## Goal\nShip the peek.\n\n## Context\nSee TaskPeek.vue.';
  assert.deepEqual(promptSections(prompt), [
    { heading: 'Goal', body: 'Ship the peek.' },
    { heading: 'Context', body: 'See TaskPeek.vue.' },
  ]);
  assert.equal(promptGoal(prompt), 'Ship the peek.');
  assert.equal(promptGoal(`## Goal\n${'x\n'.repeat(20)}## Change\ny`, 3), 'x\nx\nx');
});

test('a prompt with no sections shows its first lines', () => {
  assert.equal(promptGoal('Fix the bug\nin the parser'), 'Fix the bug\nin the parser');
  assert.equal(promptGoal(Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'), 2), 'line 0\nline 1');
  assert.equal(promptGoal(''), '');
});

test('a prompt with an empty Goal shows its first section that has text', () => {
  assert.equal(promptGoal('## Goal\n\n## Change\nDo the thing.'), 'Do the thing.');
  assert.equal(promptGoal('## Goal\n'), '');
});

test("the model is the latest run's when it differs from the task's, with both in the peek", () => {
  assert.deepEqual(modelChip({ model: 'sonnet', run_model: null }), { text: 'sonnet', title: 'Model: sonnet' });
  assert.equal(modelChip({ model: 'sonnet', run_model: 'sonnet' }).text, 'sonnet');
  assert.equal(modelChip({ model: 'sonnet', run_model: 'opus' }).text, 'opus');
  assert.deepEqual(modelLine({ model: 'sonnet', run_model: 'opus' }, 'claude-opus-5-5'), {
    text: 'opus · task: sonnet',
    title: 'claude-opus-5-5',
  });
  assert.equal(modelLine({ model: 'haiku', run_model: null }, null).text, 'haiku');
});

test('the peek row words attempts, max turns and auto-merge', () => {
  const task = { model: 'sonnet', run_model: null, priority: 2, attempts: 2, max_attempts: 2, max_turns: 60 };
  assert.deepEqual(
    peekProps({ ...task, auto_merge: null }).map((p) => p.text),
    ['2', '2 / 2', '60', "the repo's"],
  );
  assert.equal(peekProps({ ...task, auto_merge: 1 })[3].text, 'on');
  assert.equal(peekProps({ ...task, auto_merge: 0 })[3].text, 'off');
});

test('links read one line each', () => {
  assert.deepEqual(
    linkParts([
      { on: 239, kind: 'builds_on', state: 'met' },
      { on: 253, kind: 'after', state: 'waiting' },
    ] as never).map((l) => l.text),
    ['builds on #239 ✓ merged', 'after #253 waiting'],
  );
});

test('a task works on the steps its link names, else the unfinished ones', () => {
  const step = (id: string, status: 'todo' | 'done') => ({ id, title: id, status, done: [] });
  const steps = [step('a', 'done'), step('b', 'todo'), step('c', 'todo')];
  assert.deepEqual(
    ownSteps(steps, '["a","c"]').map((s) => s.id),
    ['a', 'c'],
  );
  assert.deepEqual(
    ownSteps(steps, null).map((s) => s.id),
    ['b', 'c'],
  );
  assert.equal(ownSteps(steps, 'nonsense').length, 2);
});

test('the peek offers the actions of the stage', () => {
  const base = { waiting: null, pr_state: null };
  assert.deepEqual(peekActions({ ...base, status: 'proposed' }), ['reject', 'approve']);
  assert.deepEqual(peekActions({ ...base, status: 'blocked' }), ['retry']);
  assert.deepEqual(peekActions({ ...base, status: 'running' }), ['cancel']);
  assert.deepEqual(peekActions({ ...base, status: 'done', pr_state: 'open' }), ['merge']);
  assert.deepEqual(peekActions({ ...base, status: 'done', pr_state: 'open', sync: {} }), []);
});
