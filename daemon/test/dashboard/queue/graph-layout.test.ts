// The queue's graph layout. The dashboard has no test runner, so its pure layout is tested here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SIZE, type GraphEdge, chainOf, graphTasks, layoutGraph as layout, stuckSet } from '../../../../app/src/lib/graph.ts';
import { asTaskId } from '../../fixtures/fixtures.ts';

const e = (from: number, to: number, kind: 'builds_on' | 'after' = 'builds_on'): GraphEdge => ({
  from: asTaskId(from),
  to: asTaskId(to),
  kind,
});
const layoutGraph = (ids: number[], edges: GraphEdge[]) => layout(ids.map(asTaskId), edges);

function noOverlap(l: ReturnType<typeof layoutGraph>) {
  const { nodeWidth: w, nodeHeight: h } = DEFAULT_SIZE;
  for (const a of l.nodes)
    for (const b of l.nodes) {
      if (a.id >= b.id) continue;
      const apart = a.x + w <= b.x || b.x + w <= a.x || a.y + h <= b.y || b.y + h <= a.y;
      assert.ok(apart, `#${a.id} and #${b.id} overlap`);
    }
  for (const n of l.nodes) assert.ok(n.x + w <= l.width && n.y + h <= l.height, `#${n.id} is outside the canvas`);
}
const at = (l: ReturnType<typeof layoutGraph>, id: number) => l.nodes.find((n) => n.id === id)!;

test('a chain goes left to right on one row', () => {
  const l = layoutGraph([1, 2, 3], [e(1, 2), e(2, 3)]);
  noOverlap(l);
  assert.deepEqual(
    [1, 2, 3].map((id) => at(l, id).layer),
    [0, 1, 2],
  );
  assert.equal(new Set(l.nodes.map((n) => n.y)).size, 1);
});

test('a fan-out puts the dependents in one layer, one row each', () => {
  const l = layoutGraph([1, 2, 3, 4], [e(1, 2), e(1, 3, 'after'), e(1, 4)]);
  noOverlap(l);
  assert.deepEqual(
    [2, 3, 4].map((id) => at(l, id).layer),
    [1, 1, 1],
  );
  assert.equal(new Set([2, 3, 4].map((id) => at(l, id).y)).size, 3);
});

test('a diamond layers by the longest path', () => {
  const l = layoutGraph([1, 2, 3, 4], [e(1, 2), e(1, 3), e(2, 4), e(3, 4), e(1, 4, 'after')]);
  noOverlap(l);
  assert.deepEqual(
    [1, 2, 3, 4].map((id) => at(l, id).layer),
    [0, 1, 1, 2],
  );
});

test('two separate graphs are stacked without overlap', () => {
  const l = layoutGraph([1, 2, 3, 4, 5], [e(1, 2), e(1, 3), e(4, 5)]);
  noOverlap(l);
  assert.ok(at(l, 4).y > Math.max(at(l, 2).y, at(l, 3).y));
});

test('ordering cuts a crossing', () => {
  const l = layoutGraph([1, 2, 3, 4], [e(1, 4), e(2, 3)]);
  noOverlap(l);
  assert.equal(at(l, 4).y < at(l, 3).y, at(l, 1).y < at(l, 2).y);
});

test('edges to tasks that are not drawn are dropped', () => {
  assert.equal(layoutGraph([1, 2], [e(1, 2), e(9, 2)]).edges.length, 1);
});

const task = (id: number, extra: Record<string, unknown> = {}) =>
  ({ id, status: 'queued', pr_state: null, waiting: null, links: [], dependents: [], ...extra }) as never;
const ids = (ts: { id: number }[]) => ts.map((t) => t.id);

test('the graph is the linked tasks; unlinked ones stay out', () => {
  const all = [
    task(1, { dependents: [{ id: 2, kind: 'builds_on' }] }),
    task(2, { links: [{ on: 1, kind: 'builds_on', state: 'waiting' }] }),
    task(3),
  ];
  assert.deepEqual(ids(graphTasks(all, all, false)), [1, 2]);
});

test('a chain that is all finished hides unless shown', () => {
  const done = { status: 'done', pr_state: 'merged' };
  const all = [
    task(1, { ...done, dependents: [{ id: 2, kind: 'builds_on' }] }),
    task(2, { ...done, links: [{ on: 1, kind: 'builds_on', state: 'met' }] }),
    task(3, { dependents: [{ id: 4, kind: 'after' }] }),
    task(4, { links: [{ on: 3, kind: 'after', state: 'unlanded' }] }),
  ];
  assert.deepEqual(ids(graphTasks(all, all, false)), [3, 4]);
  assert.equal(graphTasks(all, all, true).length, 4);
});

test('a stuck task, its root and everything it holds are outlined', () => {
  const all = [
    task(1, { status: 'failed', dependents: [{ id: 2, kind: 'builds_on' }] }),
    task(2, {
      waiting: { on: [1], stuck: '#1 failed' },
      links: [{ on: 1, kind: 'builds_on', state: 'stuck' }],
      dependents: [
        { id: 3, kind: 'builds_on' },
        { id: 5, kind: 'after' },
      ],
    }),
    task(3, { links: [{ on: 2, kind: 'builds_on', state: 'waiting' }] }),
    task(4),
    task(5, { links: [{ on: 2, kind: 'after', state: 'unlanded' }] }),
  ];
  assert.deepEqual([...stuckSet(all)].sort(), [1, 2, 3]);
});

test('hovering a task highlights its chain up and down', () => {
  const edges = [e(1, 2), e(2, 3), e(2, 4, 'after'), e(5, 6)];
  assert.deepEqual([...chainOf(asTaskId(2), edges)].sort(), [1, 2, 3, 4]);
});
