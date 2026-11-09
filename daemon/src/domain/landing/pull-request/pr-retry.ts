// Opening a done task's pull request again after it failed to open: how often, how far apart, and when a person must
// step in. Pure: no I/O. The failures are counted from the task's history (`prOpenFailures` in domain/work/lifecycle/history.ts).
import { sqliteMs, sqliteUtc } from '../../shared/index.ts';

/** How many times the PR refresh opens a failed PR again on its own; after that a person must (`agentdeck open-pr`). */
export const PR_OPEN_RETRIES = 5;
/** The wait before the first retry. Each one after waits twice as long as the one before: 3, 6, 12, 24 and 48 minutes. */
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

/** The wait after the `n`th retry (0 before the first): PR_RETRY_FIRST_WAIT_MS, doubled for each retry made. */
export const prRetryWaitMs = (retries: number): number => PR_RETRY_FIRST_WAIT_MS * 2 ** retries;

/**
 * Whether to open a failed PR again at `now` (ms since the epoch). The first failure is the open when the task finished,
 * so a task fails `PR_OPEN_RETRIES + 1` times before a person must open it. A failure at a time that can't be read is due.
 */
export function prRetry(failures: PrOpenFailures, now: number): PrRetry {
  const retries = failures.count - 1;
  const base = { failures: failures.count, error: failures.error };
  if (retries >= PR_OPEN_RETRIES) return { ...base, state: 'person', next_at: null };
  const at = sqliteMs(failures.at) + prRetryWaitMs(retries);
  if (!Number.isFinite(at)) return { ...base, state: 'due', next_at: null };
  return { ...base, state: at <= now ? 'due' : 'wait', next_at: sqliteUtc(new Date(at).toISOString()) };
}

/** Whether a done task's PR needs a person to open it: it failed to open, and the PR refresh has used up its retries. */
export const prNeedsPerson = (t: { status: string; pr_state: string | null; pr_retry?: Pick<PrRetry, 'state'> | null }): boolean =>
  t.status === 'done' && t.pr_state === 'failed' && t.pr_retry?.state === 'person';
