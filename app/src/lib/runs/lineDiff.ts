// An Edit's old and new text as a line diff, for the run log. Hand-written: each text is at most CHANGE_MAX characters.
import type { LogChange } from '../../../../daemon/src/api/contract.ts';
import { CHANGE_MAX } from '../../../../daemon/src/domain/runs/index.ts';

/** One row of an edit's diff: a shared line, a removed or added one, or the mark where the log cut the old or new text. */
export type EditDiffRow = { type: 'ctx' | 'del' | 'add'; text: string } | { type: 'cut'; side: 'old' | 'new' };

const lines = (t: string): string[] => (t ? t.replace(/\n$/, '').split('\n') : []);

/** Whether the log cut a text: it keeps CHANGE_MAX characters of a longer one. */
export const isCut = (text: string): boolean => text.length >= CHANGE_MAX;

/**
 * The line diff of an edit: the lines both texts share as context, the rest removed or added (removals first), from the
 * longest common subsequence of lines. A text the log cut gets a mark after its last row, a line that may itself be cut
 * short; what follows the mark is not known to differ.
 */
export function lineDiff(change: Pick<LogChange, 'old' | 'new'>): EditDiffRow[] {
  const a = lines(change.old);
  const b = lines(change.new);
  // common[i][j]: the length of the longest common subsequence of a[i..] and b[j..].
  const common = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
  const rows: EditDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      rows.push({ type: 'ctx', text: a[i++] });
      j++;
    } else if (j === b.length || (i < a.length && common[i + 1][j] >= common[i][j + 1])) rows.push({ type: 'del', text: a[i++] });
    else rows.push({ type: 'add', text: b[j++] });
  }
  const marks: [number, EditDiffRow][] = [];
  if (isCut(change.old)) marks.push([rows.findLastIndex((r) => r.type === 'ctx' || r.type === 'del') + 1, { type: 'cut', side: 'old' }]);
  if (isCut(change.new)) marks.push([rows.findLastIndex((r) => r.type === 'ctx' || r.type === 'add') + 1, { type: 'cut', side: 'new' }]);
  // The later mark goes in first, so the earlier one's place does not move.
  for (const [at, mark] of marks.sort((x, y) => y[0] - x[0])) rows.splice(at, 0, mark);
  return rows;
}
