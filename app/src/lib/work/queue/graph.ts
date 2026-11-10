// The queue's graph mode: which tasks form the graph and where each is drawn. Pure; the drawing is components/work/queue/GraphView.vue.
import type { LinkKind } from '../../../../../daemon/src/domain/work/index.ts';
import type { TaskSummary } from '../../../../../daemon/src/api/contract/work.ts';
import { isMerged, isStuck } from '../../../../../daemon/src/domain/work/index.ts';

export interface GraphEdge {
  from: number;
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

export function edgesOf(tasks: Pick<TaskSummary, 'id' | 'links'>[]): GraphEdge[] {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.flatMap((t) => t.links.filter((l) => ids.has(l.on)).map((l) => ({ from: l.on, to: t.id, kind: l.kind })));
}

export const isLinked = (t: Pick<TaskSummary, 'links' | 'dependents'>): boolean => !!(t.links?.length || t.dependents?.length);

const isFinished = (t: TaskSummary): boolean => t.status === 'done' && (isMerged(t) || t.pr_state === null);

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
    for (const l of t.links) if (l.kind === 'builds_on' && l.state === 'stuck') set.add(l.on);
  }
  return set;
}

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
      keyed.sort((a, b) => a.key - b.key);
      columns[l] = keyed.map((k) => k.id);
      columns[l].forEach((id, i) => position.set(id, i));
    }
  }
}
