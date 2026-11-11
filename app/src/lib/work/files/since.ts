import type { SincePoint } from '#daemon/api/contract/files.ts';

export const SINCE_BASE = 'base';

export const sinceKey = (p: SincePoint): string => (p.kind === 'review' ? 'review' : `attempt-${p.attempt}`);

export const sinceLabel = (p: SincePoint): string => (p.kind === 'review' ? 'Since your last review' : `Since the end of run ${p.attempt}`);

export function shownSince(points: SincePoint[], picked: string | null): SincePoint | null {
  if (picked === SINCE_BASE) return null;
  return points.find((p) => sinceKey(p) === picked) ?? points.find((p) => p.kind === 'review') ?? null;
}
