// The text pieces of the stats and scorecard reports (`agentdeck stats`).

export const num = (v: number | null, digits = 1, prefix = ''): string => (v === null ? '–' : `${prefix}${v.toFixed(digits)}`);

export const pct = (v: number | null): string => (v === null ? '–' : `${(v * 100).toFixed(0)}%`);

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
