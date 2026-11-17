// Whether a repo is due for an area review: a person's review of one part of a repo across everything merged into it since its last, marked by refs/reviewed/<area> (the review-area skill's marks).
import type { RepoId } from '#domain/shared/index.ts';
import { plural, wholeNumberError } from '#domain/shared/index.ts';
import type { Check } from '#domain/operations/health.ts';
import type { Notification } from '#domain/operations/notification.ts';

/** One area's mark: the area's name and when the base commit it points at was committed (ms since the epoch). */
export interface ReviewMark {
  area: string;
  at: number;
}

/** What git says about a repo's area reviews. */
export interface ReviewFacts {
  marks: ReviewMark[];
  /** Commits and lines (added plus deleted) merged into the base since the oldest mark; with no mark, since the repo was added. */
  commits: number;
  lines: number;
}

/** When a repo is due: its oldest mark is older than `days`, or more than `lines` lines merged since it. */
export interface ReviewDueSettings {
  days: number;
  lines: number;
}

export const DEFAULT_REVIEW_DUE: ReviewDueSettings = { days: 7, lines: 3000 };

/** A repo due for an area review, and the facts that made it due. */
export interface ReviewDue {
  repo_id: RepoId;
  repo: string;
  /** The area of the oldest mark, and its age in whole days; null when the repo has no mark. */
  area: string | null;
  days: number | null;
  commits: number;
  lines: number;
  /** The line the headline and the digest show. */
  line: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const REVIEW_REMIND_MS = DAY_MS;

export const reviewDueDaysError = (days: number): string | null => wholeNumberError('review_due_days', days, 1, 365);
export const reviewDueLinesError = (lines: number): string | null => wholeNumberError('review_due_lines', lines, 1, 1_000_000);

export function reviewDueLine(d: Pick<ReviewDue, 'days' | 'commits' | 'lines'>): string {
  const commits = plural(d.commits, 'commit');
  if (d.days === null)
    return `area review due: none yet, ${commits} (${d.lines.toLocaleString('en')} lines) merged since the repo was added`;
  return `area review due: ${plural(d.days, 'day')}, ${commits} since the last`;
}

export function reviewDue(
  repo: { id: RepoId; name: string },
  facts: ReviewFacts,
  settings: ReviewDueSettings,
  now: number,
): ReviewDue | null {
  const oldest = facts.marks.reduce<ReviewMark | null>((o, m) => (!o || m.at < o.at ? m : o), null);
  const days = oldest ? Math.max(0, Math.floor((now - oldest.at) / DAY_MS)) : null;
  const old = oldest !== null && now - oldest.at > settings.days * DAY_MS;
  if (!old && facts.lines <= settings.lines) return null;
  const due = { days, commits: facts.commits, lines: facts.lines };
  return { repo_id: repo.id, repo: repo.name, area: oldest?.area ?? null, ...due, line: reviewDueLine(due) };
}

export const remindReviewDue = (toldAt: number | null, now: number): boolean => toldAt === null || now - toldAt >= REVIEW_REMIND_MS;

export function reviewDueNotification(d: ReviewDue): Notification {
  const oldest = d.area ? ` The oldest mark is refs/reviewed/${d.area}.` : '';
  return {
    kind: 'review_due',
    title: `${d.repo}: area review due`,
    body: `${d.line.replace(/^area review due: /, '')}.${oldest} Run the review-area skill in a session on ${d.repo}.`,
  };
}

export function checkReviews(dues: ReviewDue[]): Check {
  const name = 'area reviews';
  if (!dues.length) return { name, ok: true, reason: 'none due', fix: null };
  return {
    name,
    ok: true,
    warning: true,
    reason: dues.map((d) => `${d.repo}: ${d.line}`).join('; '),
    fix: 'run the review-area skill (/review-area) in a session on the repo',
  };
}
