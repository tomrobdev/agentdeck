// How a task's pull request moves from state to state: the rule table of what the daemon and the PR refresh report.
import { PR_STATES, type PrState } from '#domain/landing/pull-request/pr.ts';

/** What happened to a PR: opened, merged or closed on GitHub, seen open again after it closed, or it could not be opened. */
export type PrMove = 'opened' | 'merged' | 'closed' | 'reopened' | 'open_failed';

/** A PR's state as the table reads it: `none` is a task with no PR yet, or one a retry set aside. */
export type PrFrom = PrState | 'none';

export const PR_FROM: readonly PrFrom[] = ['none', ...PR_STATES];

export const PR_MOVES: Record<PrMove, Partial<Record<PrFrom, PrState>>> = {
  opened: { none: 'open', merged: 'open', closed: 'open', failed: 'open' },
  merged: { open: 'merged' },
  closed: { open: 'closed' },
  reopened: {},
  open_failed: { none: 'failed', merged: 'failed', closed: 'failed', failed: 'failed' },
};

export const prFrom = (state: PrState | null | undefined): PrFrom => state ?? 'none';

export function nextPrState(from: PrFrom, move: PrMove): PrState | null {
  return PR_MOVES[move][from] ?? null;
}

export function prStatesFor(move: PrMove): PrFrom[] {
  return PR_FROM.filter((s) => PR_MOVES[move][s] !== undefined);
}

export function seenMove(state: PrState): PrMove {
  if (state === 'open') return 'reopened';
  if (state === 'failed') return 'open_failed';
  return state;
}
