// Where the Changes tab can show a task's changes from, besides the base: the head a person's last review read, or the end
// of an earlier attempt. Pure: worked out from the branch's commits, the task's runs and its reviews. No head is recorded on
// a run, so an attempt's end is the last branch commit made before its run ended.
import { sqliteMs } from '../../shared/index.ts';
import type { Commit } from './files.ts';

export type SinceKind = 'review' | 'attempt';

/** A commit on the task's branch the changes can be shown since. */
export interface SincePoint {
  kind: SinceKind;
  sha: string;
  /** The attempt it is the end of; null for a review. */
  attempt: number | null;
  /** When: the review's submit or the run's end, SQLite UTC. */
  at: string;
}

/** What attemptEnds reads of a run. */
export interface RunTimes {
  kind: string;
  attempt: number;
  ended_at: string | null;
}

/** What sincePoints reads of a review. */
export interface ReviewRead {
  by: string;
  submitted_at: string | null;
  head_commit: string | null;
}

/**
 * Each attempt's end, oldest attempt first: the last branch commit, by committer date, made before the attempt's last work
 * run ended. Resolve, unblock and review runs don't count (a resolve run commits its sync merge before it ends), nor does
 * a run that has not ended. An attempt with no commit before its end is left out, and so is one that ends where the attempt
 * before it ended: it committed nothing.
 */
export function attemptEnds(
  commits: Pick<Commit, 'sha' | 'committed_at'>[],
  runs: RunTimes[],
): { attempt: number; sha: string; at: string }[] {
  const lastRun = new Map<number, string>();
  for (const r of runs) {
    if (r.kind !== 'work' || !r.ended_at) continue;
    const seen = lastRun.get(r.attempt);
    if (!seen || sqliteMs(r.ended_at) > sqliteMs(seen)) lastRun.set(r.attempt, r.ended_at);
  }
  const dated = commits.map((c) => ({ sha: c.sha, ms: sqliteMs(c.committed_at) }));
  const out: { attempt: number; sha: string; at: string }[] = [];
  for (const [attempt, at] of [...lastRun].sort(([a], [b]) => a - b)) {
    const end = sqliteMs(at);
    // Newest first from git, so on a tie (one-second dates) the first one seen is the newer.
    let last: { sha: string; ms: number } | null = null;
    for (const c of dated) if (c.ms <= end && (!last || c.ms > last.ms)) last = c;
    if (!last || out.at(-1)?.sha === last.sha) continue;
    out.push({ attempt, sha: last.sha, at });
  }
  return out;
}

/**
 * Where the changes can be shown since, newest first: the head a person's last submitted review read, then each earlier
 * attempt's end. `commits` are the branch's own (against the base), with `head` among them. A point is offered only when
 * it is on the branch and behind `head`, so a review of the current head offers nothing.
 */
export function sincePoints(
  commits: Pick<Commit, 'sha' | 'committed_at'>[],
  runs: RunTimes[],
  reviews: ReviewRead[],
  head: string,
): SincePoint[] {
  const onBranch = new Set(commits.map((c) => c.sha));
  const behind = (sha: string | null): sha is string => !!sha && sha !== head && onBranch.has(sha);
  const lastReview = reviews
    .filter((r) => r.by === 'person' && r.submitted_at)
    .reduce<ReviewRead | null>((last, r) => (!last || sqliteMs(r.submitted_at!) > sqliteMs(last.submitted_at!) ? r : last), null);
  const points: SincePoint[] = [];
  if (lastReview && behind(lastReview.head_commit))
    points.push({ kind: 'review', sha: lastReview.head_commit, attempt: null, at: lastReview.submitted_at! });
  for (const end of attemptEnds(commits, runs).reverse())
    if (behind(end.sha)) points.push({ kind: 'attempt', sha: end.sha, attempt: end.attempt, at: end.at });
  return points;
}
