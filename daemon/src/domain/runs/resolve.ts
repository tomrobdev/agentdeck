// How a resolve run's end settles the sync it is part of (domain/runs/sync.ts).
import { type RunClass, parseStatus } from './run-result.ts';

/** What a resolve run's end settles on its own, or `check`: the agent said it was done, so the merge and the tests decide. */
export type ResolveOutcome =
  { outcome: 'cancelled' } | { outcome: 'rate_limited' | 'failed' | 'blocked'; reason: string } | { outcome: 'check' };

export function resolveOutcome(end: RunClass): ResolveOutcome {
  if (end.kind === 'cancelled') return { outcome: 'cancelled' };
  if (end.kind === 'rate_limited') return { outcome: 'rate_limited', reason: end.reason };
  if (end.kind === 'failed') return { outcome: 'failed', reason: end.reason };
  const status = parseStatus(end.result.result);
  if (status.blocked) return { outcome: 'blocked', reason: status.reason ?? 'the agent could not resolve the conflicts' };
  return { outcome: 'check' };
}
