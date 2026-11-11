// The import graphs behind docs/reference/context-map.md and adapter-use.md, worked out from `Source`s. Pure: no file reads.
import type { Source } from '#scripts/lib/sources.ts';

export function contextOf(path: string): string | null {
  const parts = path.split('/');
  if (parts[0] !== 'domain') return null;
  return parts.length > 2 ? `domain/${parts[1]}` : 'domain';
}

export interface ContextEdge {
  from: string;
  to: string;
  typeOnly: boolean;
  inCycle: boolean;
}

export interface ContextMap {
  contexts: string[];
  edges: ContextEdge[];
  cycles: string[][];
}

export function cyclesOf(nodes: string[], next: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const out: string[][] = [];
  let counter = 0;
  const visit = (v: string) => {
    index.set(v, counter);
    low.set(v, counter++);
    stack.push(v);
    onStack.add(v);
    for (const w of next.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      if (group.length > 1) out.push(group.sort());
    }
  };
  for (const n of nodes) if (!index.has(n)) visit(n);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

export function contextMap(sources: Source[]): ContextMap {
  const contexts = new Set<string>();
  const found = new Map<string, boolean>();
  for (const s of sources) {
    const from = contextOf(s.path);
    if (!from) continue;
    contexts.add(from);
    for (const i of s.imports) {
      const to = i.target && contextOf(i.target);
      if (!to) continue;
      contexts.add(to);
      if (to === from) continue;
      const key = `${from}\0${to}`;
      found.set(key, (found.get(key) ?? true) && i.typeOnly);
    }
  }
  const nodes = [...contexts].sort();
  const next = new Map<string, Set<string>>();
  for (const key of found.keys()) {
    const [from, to] = key.split('\0');
    next.set(from, (next.get(from) ?? new Set()).add(to));
  }
  const cycles = cyclesOf(nodes, next);
  const group = new Map(cycles.flatMap((c, n) => c.map((m) => [m, n] as const)));
  const edges = [...found]
    .map(([key, typeOnly]) => {
      const [from, to] = key.split('\0');
      return { from, to, typeOnly, inCycle: group.has(from) && group.get(from) === group.get(to) };
    })
    .sort((a, b) => (a.from + '\0' + a.to < b.from + '\0' + b.to ? -1 : 1));
  return { contexts: nodes, edges, cycles };
}

export function areaOf(path: string): string | null {
  const parts = path.split('/');
  return parts[0] === 'application' && parts.length > 1 ? parts[1] : null;
}

export interface AdapterUse {
  area: string;
  adapters: { adapter: string; imports: number }[];
}

export function adapterUse(sources: Source[]): AdapterUse[] {
  const byArea = new Map<string, Map<string, number>>();
  for (const s of sources) {
    const area = areaOf(s.path);
    if (!area) continue;
    for (const i of s.imports) {
      if (!i.target?.startsWith('adapters/')) continue;
      const counts = byArea.get(area) ?? new Map<string, number>();
      const name = i.target.slice('adapters/'.length);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      byArea.set(area, counts);
    }
  }
  return [...byArea]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([area, counts]) => ({
      area,
      adapters: [...counts].sort(([a], [b]) => (a < b ? -1 : 1)).map(([adapter, imports]) => ({ adapter, imports })),
    }));
}

export function folderOf(path: string, layer: string): string | null {
  const parts = path.split('/');
  if (parts[0] !== layer) return null;
  return parts.length > 2 ? `${layer}/${parts[1]}` : layer;
}

export interface FolderCycle {
  folders: string[];
  imports: { from: string; to: string; file: string; line: number; typeOnly: boolean }[];
}

export function folderCycles(sources: Source[], layer: string): FolderCycle[] {
  const nodes = new Set<string>();
  const next = new Map<string, Set<string>>();
  const ties: FolderCycle['imports'] = [];
  for (const s of sources) {
    const from = folderOf(s.path, layer);
    if (!from) continue;
    nodes.add(from);
    for (const i of s.imports) {
      const to = i.target && folderOf(i.target, layer);
      if (!to || to === from) continue;
      nodes.add(to);
      next.set(from, (next.get(from) ?? new Set()).add(to));
      ties.push({ from, to, file: s.path, line: i.line, typeOnly: i.typeOnly });
    }
  }
  return cyclesOf([...nodes].sort(), next).map((folders) => ({
    folders,
    imports: ties.filter((t) => folders.includes(t.from) && folders.includes(t.to)),
  }));
}
