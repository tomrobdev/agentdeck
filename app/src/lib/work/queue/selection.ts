export function stepSelection(ids: number[], selected: number | null, by: number): number | null {
  if (!ids.length) return null;
  const i = ids.indexOf(selected ?? -1);
  return ids[Math.min(Math.max(i === -1 ? 0 : i + by, 0), ids.length - 1)];
}
