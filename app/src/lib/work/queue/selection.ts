// Moving the queue's selection with the arrow keys. Pure, so the daemon's tests can import it
// (daemon/test/dashboard/work/queue/selection.test.ts).

/**
 * The task selected after moving `by` rows from `selected` in `ids`, the rows in screen order. Nothing selected, or a
 * selection no longer shown, starts from the first row; the ends stop the move. Null when there are no rows.
 */
export function stepSelection(ids: number[], selected: number | null, by: number): number | null {
  if (!ids.length) return null;
  const i = ids.indexOf(selected ?? -1);
  return ids[Math.min(Math.max(i === -1 ? 0 : i + by, 0), ids.length - 1)];
}
