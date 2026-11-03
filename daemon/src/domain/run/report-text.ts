// The text pieces of the stats and scorecard reports (`agentdeck stats`). Pure: no I/O.

/** A number to `digits` places (with `prefix`), or "–" for none. */
export const num = (v: number | null, digits = 1, prefix = ''): string => (v === null ? '–' : `${prefix}${v.toFixed(digits)}`);

/** A 0..1 share as a whole percentage, or "–" for none. */
export const pct = (v: number | null): string => (v === null ? '–' : `${(v * 100).toFixed(0)}%`);

/** Aligned columns: the first left, the rest right, no trailing blanks. */
export function table(head: string[], rows: string[][]): string {
  const lines = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines
    .map((l) =>
      l
        .map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}
