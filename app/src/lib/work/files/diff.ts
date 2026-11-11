// A small unified diff parser for one file's patch (`git diff` output).

export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  old: number | null;
  new: number | null;
  text: string;
}

export interface Hunk {
  header: string;
  lines: DiffLine[];
}

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split('\n')) {
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur || line.startsWith('\\')) continue;
    const mark = line[0];
    const text = line.slice(1);
    if (mark === '+') cur.lines.push({ type: 'add', old: null, new: newNo++, text });
    else if (mark === '-') cur.lines.push({ type: 'del', old: oldNo++, new: null, text });
    else if (mark === ' ') cur.lines.push({ type: 'ctx', old: oldNo++, new: newNo++, text });
  }
  return hunks;
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.type === 'ctx') {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

export function anchorOf(l: DiffLine): { side: 'old' | 'new'; line: number } {
  return l.type === 'del' ? { side: 'old', line: l.old ?? 0 } : { side: 'new', line: l.new ?? 0 };
}

export const anchorKey = (a: { side: string; line: number }) => `${a.side}:${a.line}`;
