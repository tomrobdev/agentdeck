import type { ChangedFile } from '#daemon/api/contract/files.ts';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  badge?: string;
  badgeTitle?: string;
  meta?: string;
  delta?: { add: number; del: number };
}

export const CHANGE_LABEL: Record<ChangedFile['status'], string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' };

export function changedTree(files: readonly ChangedFile[]): Map<string, TreeNode[]> {
  const byPath = new Map(files.map((f) => [f.path, f]));
  type Dir = { dirs: Map<string, Dir>; files: string[] };
  const root: Dir = { dirs: new Map(), files: [] };
  for (const p of byPath.keys()) {
    const parts = p.split('/');
    let d = root;
    for (const part of parts.slice(0, -1)) {
      const next: Dir = d.dirs.get(part) ?? { dirs: new Map(), files: [] };
      d.dirs.set(part, next);
      d = next;
    }
    d.files.push(p);
  }
  const out = new Map<string, TreeNode[]>();
  const walk = (dir: Dir, base: string) => {
    const nodes: TreeNode[] = [];
    out.set(base, nodes);
    for (const [name, child] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let path = base ? `${base}/${name}` : name;
      let d = child;
      while (d.files.length === 0 && d.dirs.size === 1) {
        const [n, c] = [...d.dirs][0];
        label += `/${n}`;
        path += `/${n}`;
        d = c;
      }
      nodes.push({ name: label, path, type: 'dir' });
      walk(d, path);
    }
    for (const p of [...dir.files].sort()) {
      const f = byPath.get(p);
      if (!f) continue;
      nodes.push({
        name: p.slice(p.lastIndexOf('/') + 1),
        path: p,
        type: 'file',
        badge: f.status,
        badgeTitle: CHANGE_LABEL[f.status],
        meta: f.binary ? 'bin' : undefined,
        delta: f.binary ? undefined : { add: f.additions, del: f.deletions },
      });
    }
  };
  walk(root, '');
  return out;
}
