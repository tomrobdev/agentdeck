// Pure tests of builds-on links across repos and targets: met once the work is merged where the dependent gets it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asTaskId } from '#domain/shared/index.ts';
import {
  type Link,
  type LinkTarget,
  type Place,
  type PlanBranchStatus,
  linkState,
  placeAt,
  releasedBy,
  startState,
} from '#domain/work/index.ts';

const id = asTaskId;
const builds = (task: number, on: number): Link => ({ task_id: id(task), on: id(on), kind: 'builds_on' });
const base: Place = placeAt(null, 'main', null);
const plan = (status: PlanBranchStatus): Place => placeAt('plan/9-x', 'main', status);
const queued = (place: Place): LinkTarget => ({ status: 'queued', pr: null, pr_mode: 'ready', place, links: [] });
const merged = (place: Place): LinkTarget => ({
  status: 'done',
  done_by: null,
  pr: { state: 'merged' },
  pr_mode: 'ready',
  place,
  links: [],
});

const start = (tasks: Record<number, LinkTarget>, links: Link[]) =>
  startState({ id: id(1) }, links, (t) => {
    const found = tasks[t];
    return found && { ...found, links: links.filter((l) => l.task_id === t) };
  });

test('a task on the base building on work merged into a plan branch waits until that plan branch lands', () => {
  const links = [builds(1, 2)];
  assert.deepEqual(start({ 1: queued(base), 2: merged(plan('active')) }, links), { kind: 'waiting', on: [2] });
  assert.deepEqual(start({ 1: queued(base), 2: merged(plan('landing')) }, links), { kind: 'waiting', on: [2] });
  assert.deepEqual(start({ 1: queued(base), 2: merged(plan('landed')) }, links), { kind: 'met' });
  assert.deepEqual(start({ 1: queued(base), 2: merged(plan('abandoned')) }, links), {
    kind: 'stuck',
    on: 2,
    reason: '#2 is merged into plan/9-x, which was abandoned',
  });
});

test('a task on a plan branch gets work merged into the same plan branch, in any repo, and work on the base', () => {
  const links = [builds(1, 2)];
  assert.deepEqual(start({ 1: queued(plan('active')), 2: merged(plan('active')) }, links), { kind: 'met' }, 'same name');
  assert.deepEqual(start({ 1: queued(plan('open')), 2: merged(base) }, links), { kind: 'met' }, 'the base syncs in');
  const other = placeAt('plan/7-y', 'develop', 'active');
  assert.deepEqual(start({ 1: queued(plan('active')), 2: merged(other) }, links), { kind: 'waiting', on: [2] });
});

test('a task on a branch that is no plan branch never gets work merged anywhere else', () => {
  const release = placeAt('release', 'main', null);
  assert.deepEqual(start({ 1: queued(release), 2: merged(base) }, [builds(1, 2)]), {
    kind: 'stuck',
    on: 2,
    reason: "#2 is merged into its base, which never reaches this task's target",
  });
  assert.deepEqual(start({ 1: queued(release), 2: merged(release) }, [builds(1, 2)]), { kind: 'met' });
});

test('a chain through a plan branch: #3 on the base builds on #2 on the plan branch, which builds on #4 on the base', () => {
  const links = [builds(3, 2), builds(2, 4)];
  const chain = (status: PlanBranchStatus) => (t: number) => ({ 2: merged(plan(status)), 3: queued(base), 4: merged(base) })[t];
  const at = (status: PlanBranchStatus) =>
    startState({ id: id(3) }, links, (t) => {
      const found = chain(status)(t);
      return found && { ...found, links: links.filter((l) => l.task_id === t) };
    });
  assert.deepEqual(at('active'), { kind: 'waiting', on: [2] });
  assert.deepEqual(at('landed'), { kind: 'met' });
});

test('releasedBy reads the waiting task’s own place: a merge into a plan branch releases only tasks on it', () => {
  const links = [builds(5, 2), builds(6, 2)];
  const tasks: Record<number, LinkTarget> = { 2: queued(plan('active')), 5: queued(plan('active')), 6: queued(base) };
  const index = {
    linksOf: (t: number) => links.filter((l) => l.task_id === t),
    dependentsOf: (t: number) => links.filter((l) => l.on === t).map((l) => ({ id: l.task_id, status: 'queued', kind: l.kind })),
    target: (t: number) => tasks[t] && { ...tasks[t], links: links.filter((l) => l.task_id === t) },
  };
  assert.deepEqual(
    releasedBy(id(2), index).map((t) => t.id),
    [5],
  );
});

test('linkState reads the dependent’s place for builds-on links only: an after link lands with its plan branch', () => {
  assert.equal(linkState({ on: id(2), kind: 'builds_on' }, merged(plan('active'))).kind, 'waiting');
  assert.equal(linkState({ on: id(2), kind: 'builds_on' }, merged(plan('active')), plan('active')).kind, 'met');
  assert.equal(linkState({ on: id(2), kind: 'after' }, merged(plan('active'))).kind, 'met');
});
