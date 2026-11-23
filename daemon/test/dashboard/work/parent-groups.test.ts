import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskSummary } from '#api/contract/work.ts';
import { linkOrder, mergePath, parentGroupOf, parentGroups } from '#app/lib/work/parent-groups.ts';

const url = (n: number) => `https://github.com/o/r/issues/${n}`;
const task = (id: number, number: number | null, parent: number | null, more: object = {}) =>
  ({
    id,
    repo_id: 4,
    repo: 'koc',
    title: `Task ${id}`,
    status: 'proposed',
    links: [],
    issue: number === null ? null : { number, url: url(number), parent: parent === null ? null : { number: parent, title: 'Orders' } },
    merges_into: { branch: 'develop', plan: null },
    ...more,
  }) as unknown as TaskSummary;
const onPlan = { merges_into: { branch: 'plan/9-orders', plan: { task: 9, base: 'develop' } } };
const ids = (tasks: TaskSummary[]) => tasks.map((t) => t.id);

test('sub-issues sit under their parent in the order they build on each other, tasks with none last', () => {
  const tasks = [
    task(1, 84, null),
    task(417, 85, 69, { links: [{ on: 415, kind: 'builds_on', state: 'waiting' }] }),
    task(415, 87, 69, { status: 'done', pr_state: 'merged' }),
  ];
  const [orders, rest] = parentGroups(tasks);
  assert.deepEqual([orders.label, ids(orders.tasks)], ['Orders', [415, 417]]);
  assert.deepEqual(orders.head, { issue: { number: 69, url: url(69) }, done: 1, total: 2, merges: '→ develop, a PR each' });
  assert.deepEqual([rest.label, ids(rest.tasks), rest.head.total], ['koc: no parent issue', [1], 0]);
});

test('progress counts every sub-issue, not only the ones a filter shows, and no cancelled one', () => {
  const all = [task(1, 85, 69), task(2, 86, 69, { status: 'done', pr_state: 'merged' }), task(3, 87, 69, { status: 'cancelled' })];
  const [g] = parentGroups([all[0]], all);
  assert.deepEqual([ids(g.tasks), g.head.done, g.head.total], [[1], 1, 2]);
});

test('a parent that is a plan leads its group, uncounted, and the head says what merges together', () => {
  const tasks = [task(1, 85, 69, onPlan), task(9, 69, null, { status: 'parked' })];
  const [g, ...others] = parentGroups(tasks);
  assert.equal(others.length, 0);
  assert.deepEqual([ids(g.tasks), g.head.total, g.head.merges], [[9, 1], 1, '→ plan/9-orders → develop, one PR together']);
});

test('tasks on a plan branch with no parent issue group by it', () => {
  const [g] = parentGroups([task(1, null, null, onPlan)], [task(1, null, null, onPlan), task(9, null, null, { title: 'The plan' })]);
  assert.deepEqual([g.key, g.label], ['branch:4:plan/9-orders', 'The plan']);
  assert.equal(mergePath([{ merges_into: undefined }]), '');
});

test('a task page shows its parent group, and none for a task with no parent', () => {
  const all = [task(1, 85, 69), task(2, 86, null)];
  assert.equal(parentGroupOf(all[0], all)?.head.issue?.number, 69);
  assert.equal(parentGroupOf(all[1], all), null);
});

test('links in a circle still list every task', () => {
  const link = (on: number) => ({ links: [{ on, kind: 'after', state: 'waiting' }] });
  assert.deepEqual(ids(linkOrder([task(2, 2, 69, link(1)), task(1, 1, 69, link(2))])), [1, 2]);
});
