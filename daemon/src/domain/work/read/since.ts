// Where the Changes tab can show a task's changes from, besides the base: the head a person's last review read, or the end of an earlier attempt.
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
    let last: { sha: string; ms: number } | null = null;
    for (const c of dated) if (c.ms <= end && (!last || c.ms > last.ms)) last = c;
    if (!last || out.at(-1)?.sha === last.sha) continue;
    out.push({ attempt, sha: last.sha, at });
  }
  return out;
}

export function sincePoints(
  commits: Pick<Commit, 'sha' | 'committed_at'>[],
  runs: RunTimes[],
  reviews: ReviewRead[],
  head: string,
): SincePoint[] {
  const onBranch = new Set(commits.map((c) => c.sha));
  const behind = (sha: string | null): sha is string => !!sha && sha !== head && onBranch.has(sha);
  const lastReview = reviews
    .flatMap((r) => (r.by === 'person' && r.submitted_at ? [{ sha: r.head_commit, at: r.submitted_at }] : []))
    .reduce<{ sha: string | null; at: string } | null>((last, r) => (!last || sqliteMs(r.at) > sqliteMs(last.at) ? r : last), null);
  const points: SincePoint[] = [];
  if (lastReview && behind(lastReview.sha)) points.push({ kind: 'review', sha: lastReview.sha, attempt: null, at: lastReview.at });
  for (const end of attemptEnds(commits, runs).reverse())
    if (behind(end.sha)) points.push({ kind: 'attempt', sha: end.sha, attempt: end.attempt, at: end.at });
  return points;
}
