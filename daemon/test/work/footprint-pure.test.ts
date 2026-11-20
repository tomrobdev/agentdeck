// A task's footprint and when two overlap: the files its prompt and linked plan steps name, and those its branch changed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/index.ts';
import { footprint, overlapWith, startWait } from '#domain/work/index.ts';

const running = (id: number, paths: string[]) => ({ id: asTaskId(id), paths });

test('a shared file overlaps', () => {
  assert.equal(overlapWith(['src/a.ts', 'src/b.ts'], [running(1, ['src/c.ts']), running(2, ['src/b.ts'])]), 2);
});

test('a file inside a folder the other names overlaps, either way round', () => {
  assert.equal(overlapWith(['src/domain/a.ts'], [running(3, ['src/domain/'])]), 3);
  assert.equal(overlapWith(['src/domain/'], [running(4, ['src/domain/deep/b.ts'])]), 4);
});

test("disjoint paths don't overlap, nor does a sibling folder's file", () => {
  assert.equal(overlapWith(['src/a.ts', 'src/domain/'], [running(5, ['src/b.ts', 'src/domains/x.ts'])]), null);
});

test('an empty footprint overlaps nothing', () => {
  assert.equal(overlapWith([], [running(6, ['src/a.ts', 'src/'])]), null);
  assert.equal(overlapWith(['src/a.ts'], [running(7, [])]), null);
});

const plan = `<html data-agentdeck-plan="1"><title>P</title>
<section data-plan-step id="one" data-status="todo"><h2>One</h2><p>Change daemon/src/one.ts.</p>
<ul data-plan-done><li>A test in daemon/test/one.test.ts</li></ul></section>
<section data-plan-step id="two" data-status="todo"><h2>Two</h2><p>Change daemon/src/two.ts.</p></section>
<section data-plan-step id="old" data-status="done"><h2>Old</h2><p>Change daemon/src/old.ts.</p></section>
</html>`;

test("a footprint is the prompt's paths, its linked unfinished steps' paths and the branch's changed files", () => {
  assert.deepEqual(footprint({ prompt: 'Edit `src/p.ts`.', plan: { html: plan, steps: ['one'] }, changed: ['src/changed.ts'] }), [
    'src/p.ts',
    'daemon/src/one.ts',
    'daemon/test/one.test.ts',
    'src/changed.ts',
  ]);
  assert.deepEqual(footprint({ prompt: 'No paths here.', plan: { html: plan, steps: null }, changed: [] }), [
    'daemon/src/one.ts',
    'daemon/test/one.test.ts',
    'daemon/src/two.ts',
  ]);
  assert.deepEqual(footprint({ prompt: 'Create `src/new.ts`.', plan: null, changed: [] }), []);
});

test('a queued task whose footprint overlaps a running one waits for it, after an unblock run and before slots', () => {
  const ctx = {
    queue: null,
    repoPaused: null,
    draining: null,
    dependency: { kind: 'none' as const },
    unblocking: false,
    running: 9,
    max: 9,
  };
  assert.deepEqual(startWait({ status: 'queued' }, { ...ctx, overlap: asTaskId(12) }), { kind: 'overlap', with: 12 });
  assert.deepEqual(startWait({ status: 'queued' }, { ...ctx, overlap: asTaskId(12), unblocking: true }), { kind: 'unblocking' });
  assert.equal(startWait({ status: 'running' }, { ...ctx, overlap: asTaskId(12) }), null);
});
