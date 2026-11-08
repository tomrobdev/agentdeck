// The queue's graph mode: which tasks form the graph and where each is drawn. Pure; the drawing is components/queue/GraphView.vue.
// Tasks are layered by longest path from a root (left to right: a task sits right of everything it depends on), ordered within a
// layer by the mean position of their neighbours, with a few sweeps to cut crossings. Separate graphs are stacked top to bottom.
import type { LinkKind, TaskSummary } from '../../../daemon/src/api/contract.ts';
import { isMerged, isStuck } from '../../../daemon/src/domain/work/index.ts';

export interface GraphEdge {
  /** The dependency. */
  from: number;
  /** The task that depends on it. */
  to: number;
  kind: LinkKind;
}

export interface Placed {
  id: number;
  x: number;
  y: number;
  layer: number;
}

export interface GraphLayout {
  nodes: Placed[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

export interface GraphSize {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
}

export const DEFAULT_SIZE: GraphSize = { nodeWidth: 188, nodeHeight: 46, gapX: 56, gapY: 14 };

const SWEEPS = 4;

/** Every link between the given tasks, as edges from the dependency to the dependent. Links to tasks not given are left out. */
export function edgesOf(tasks: Pick<TaskSummary, 'id' | 'links'>[]): GraphEdge[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.flatMap((t) => t.links.filter((l) => ids.has(l.on)).map((l) => ({ from: l.on, to: t.id, kind: l.kind })));
}

/** The tasks that form the graph: those with links or dependents. Unlinked tasks stay out. */
export const isLinked = (t: Pick<TaskSummary, 'links' | 'dependents'>): boolean => !!(t.links?.length || t.dependents?.length);

/** Done with nothing left to land: its PR is merged, or there never was one. */
const isFinished = (t: TaskSummary): boolean => t.status === 'done' && (isMerged(t) || t.pr_state === null);

/**
 * The tasks to draw. `all` is the whole queue (the structure comes from it) and `shown` the ones that pass the queue's filters.
 * A linked task is drawn when it passes the filters; a chain whose every task is finished is hidden unless `showFinished`.
 */
export function graphTasks(all: TaskSummary[], shown: TaskSummary[], showFinished: boolean): TaskSummary[] {
  const linked = shown.filter(isLinked);
  if (showFinished) return linked;
  const byId = new Map(all.map((t) => [t.id, t]));
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const t of all) parent.set(t.id, t.id);
  for (const e of edgesOf(all)) parent.set(find(e.from), find(e.to));
  const alive = new Set<number>();
  for (const t of all) if (!isFinished(byId.get(t.id)!)) alive.add(find(t.id));
  return linked.filter((t) => alive.has(find(t.id)));
}

/** The tasks a stuck task keeps from starting, and the stuck roots under them: outlined in the blocked colour. */
export function stuckSet(tasks: TaskSummary[]): Set<number> {
  const byId = new Map<number, TaskSummary>(tasks.map((t) => [t.id, t]));
  const set = new Set<number>();
  const mark = (id: number) => {
    if (set.has(id)) return;
    set.add(id);
    for (const d of byId.get(id)?.dependents ?? []) if (d.kind === 'builds_on') mark(d.id);
  };
  for (const t of tasks) {
    if (!isStuck(t)) continue;
    mark(t.id);
    // The root: the dependency whose own state won't get better. It is the one a person has to act on.
    for (const l of t.links) if (l.kind === 'builds_on' && l.state === 'stuck') set.add(l.on);
  }
  return set;
}

/** Everything a task depends on and everything depending on it, through links of either kind: the chain hover highlights. */
export function chainOf(id: number, edges: GraphEdge[]): Set<number> {
  const out = new Set<number>([id]);
  for (const dir of ['up', 'down'] as const) {
    const stack = [id];
    while (stack.length) {
      const at = stack.pop()!;
      for (const e of edges) {
        const next = dir === 'up' ? (e.to === at ? e.from : null) : e.from === at ? e.to : null;
        if (next !== null && !out.has(next)) {
          out.add(next);
          stack.push(next);
        }
      }
    }
  }
  return out;
}

/** Lay out the tasks `ids` joined by `edges` (edges outside `ids` are ignored). Cycles can't be made, but are tolerated. */
export function layoutGraph(ids: number[], allEdges: GraphEdge[], size: GraphSize = DEFAULT_SIZE): GraphLayout {
  const present = new Set(ids);
  const edges = allEdges.filter((e) => present.has(e.from) && present.has(e.to) && e.from !== e.to);
  const preds = new Map<number, number[]>();
  const succs = new Map<number, number[]>();
  for (const id of ids) {
    preds.set(id, []);
    succs.set(id, []);
  }
  for (const e of edges) {
    preds.get(e.to)!.push(e.from);
    succs.get(e.from)!.push(e.to);
  }

  // Separate graphs: weakly connected components, in the order their first task appears.
  const seen = new Set<number>();
  const components: number[][] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const comp: number[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const at = stack.pop()!;
      comp.push(at);
      for (const n of [...preds.get(at)!, ...succs.get(at)!]) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    components.push(comp.sort((a, b) => ids.indexOf(a) - ids.indexOf(b)));
  }

  const nodes: Placed[] = [];
  let top = 0;
  let width = 0;
  for (const comp of components) {
    const layerOf = layers(comp, preds);
    const depth = Math.max(...comp.map((id) => layerOf.get(id)!)) + 1;
    const columns: number[][] = Array.from({ length: depth }, () => []);
    for (const id of comp) columns[layerOf.get(id)!].push(id);
    order(columns, preds, succs);
    const rows = Math.max(...columns.map((c) => c.length));
    columns.forEach((col, layer) => {
      // Centre a short column against the tallest one.
      const offset = ((rows - col.length) * (size.nodeHeight + size.gapY)) / 2;
      col.forEach((id, i) =>
        nodes.push({ id, layer, x: layer * (size.nodeWidth + size.gapX), y: top + offset + i * (size.nodeHeight + size.gapY) }),
      );
    });
    width = Math.max(width, depth * size.nodeWidth + (depth - 1) * size.gapX);
    top += rows * (size.nodeHeight + size.gapY) + size.gapY * 2;
  }
  return { nodes, edges, width, height: Math.max(0, top - size.gapY * 2 - size.gapY) };
}

/** Longest path from a root. A cycle (which links refuse) would never settle, so the passes are bounded. */
function layers(comp: number[], preds: Map<number, number[]>): Map<number, number> {
  const layer = new Map(comp.map((id) => [id, 0]));
  for (let pass = 0; pass < comp.length; pass++) {
    let changed = false;
    for (const id of comp) {
      for (const p of preds.get(id)!) {
        if (layer.get(p)! + 1 > layer.get(id)!) {
          layer.set(id, layer.get(p)! + 1);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return layer;
}

/** Sort each column by the mean position of its neighbours in the previous (then next) one, a few sweeps. */
function order(columns: number[][], preds: Map<number, number[]>, succs: Map<number, number[]>): void {
  const position = new Map<number, number>();
  const index = () => columns.forEach((col) => col.forEach((id, i) => position.set(id, i)));
  index();
  const mean = (id: number, near: Map<number, number[]>, fallback: number) => {
    const ns = near.get(id)!.filter((n) => position.has(n));
    return ns.length ? ns.reduce((s, n) => s + position.get(n)!, 0) / ns.length : fallback;
  };
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const down = sweep % 2 === 0;
    const range = columns.map((_, i) => i);
    for (const l of down ? range.slice(1) : range.slice(0, -1).reverse()) {
      const col = columns[l];
      const keyed = col.map((id, i) => ({ id, key: mean(id, down ? preds : succs, i) }));
      // A stable sort keeps the current order for ties.
      keyed.sort((a, b) => a.key - b.key);
      columns[l] = keyed.map((k) => k.id);
      columns[l].forEach((id, i) => position.set(id, i));
    }
  }
}
