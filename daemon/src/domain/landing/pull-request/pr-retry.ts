// Opening a done task's pull request again after it failed to open: how often, how far apart, and when a person must step in.
import { sqliteMs, sqliteUtc } from '../../shared/index.ts';

export const PR_OPEN_RETRIES = 5;
export const PR_RETRY_FIRST_WAIT_MS = 3 * 60_000;

/** The failed opens of a task's PR since it last finished done: how many, the last one's error, and when it failed (SQLite UTC). */
export interface PrOpenFailures {
  count: number;
  error: string;
  at: string;
}

/**
 * Where opening a failed PR again stands. `due`: the PR refresh opens it now. `wait`: it does at `next_at`. `person`: the
 * retries are used up, so a person must open it, and `error` is why.
 */
export interface PrRetry {
  state: 'due' | 'wait' | 'person';
  /** How many times it failed to open, the first open when the task finished included. */
  failures: number;
  /** The last failure's error. */
  error: string;
  /** When the next retry is due (SQLite UTC); null when a person must open it. */
  next_at: string | null;
}

export const prRetryWaitMs = (retries: number): number => PR_RETRY_FIRST_WAIT_MS * 2 ** retries;

export function prRetry(failures: PrOpenFailures, now: number): PrRetry {
  const retries = failures.count - 1;
  const base = { failures: failures.count, error: failures.error };
  if (retries >= PR_OPEN_RETRIES) return { ...base, state: 'person', next_at: null };
  const at = sqliteMs(failures.at) + prRetryWaitMs(retries);
  if (!Number.isFinite(at)) return { ...base, state: 'due', next_at: null };
  return { ...base, state: at <= now ? 'due' : 'wait', next_at: sqliteUtc(new Date(at).toISOString()) };
}

export const prNeedsPerson = (t: { status: string; pr_state: string | null; pr_retry?: Pick<PrRetry, 'state'> | null }): boolean =>
  t.status === 'done' && t.pr_state === 'failed' && t.pr_retry?.state === 'person';
