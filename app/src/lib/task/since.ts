// The Changes tab's "Since" choice: what each point is called, and which one the tab shows. Pure, so the daemon's tests can
// import it (daemon/test/work/read/changes-since.test.ts). The points themselves come from the daemon (sincePoints in domain/work).
import type { SincePoint } from '../../../../daemon/src/api/contract/files.ts';

/** The pick that shows the changes against the base. */
export const SINCE_BASE = 'base';

/**
 * A point's key in the menu: by what it is, not its commit, so "since the last review" stays picked when a new review
 * moves it, and a review and an attempt that end at the same commit are still two choices.
 */
export const sinceKey = (p: SincePoint): string => (p.kind === 'review' ? 'review' : `attempt-${p.attempt}`);

/** What a point is called in the menu. */
export const sinceLabel = (p: SincePoint): string => (p.kind === 'review' ? 'Since your last review' : `Since the end of run ${p.attempt}`);

/**
 * The point the tab shows, or null for the base. A person's pick (a key, or SINCE_BASE) stays while it is offered; with
 * none, or one no longer offered, the tab opens on the last review, which the daemon offers only when the head has moved
 * past it, and else on the base.
 */
export function shownSince(points: SincePoint[], picked: string | null): SincePoint | null {
  if (picked === SINCE_BASE) return null;
  return points.find((p) => sinceKey(p) === picked) ?? points.find((p) => p.kind === 'review') ?? null;
}
