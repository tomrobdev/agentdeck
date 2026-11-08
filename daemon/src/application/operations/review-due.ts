// Which repos are due for an area review (domain/operations/review-due.ts decides it from the refs/reviewed/* marks), and
// the reminder: the daemon's tick stores what is due for the headline and tells a person at most once a day per repo.
import type { App } from '../ports/app.ts';
import { type ReviewDue, remindReviewDue, reviewDue, reviewDueNotification } from '../../domain/operations/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { sqliteMs } from '../../domain/shared/index.ts';
import { notify } from './notifications.ts';

/** How often the daemon's tick reads the marks again. */
export const REVIEW_CHECK_MS = 60_000;

/** Whether the repo is due for an area review now; null when it is not, or when git could not say. */
export async function repoReviewDue(app: App, repo: Repo, now = Date.now()): Promise<ReviewDue | null> {
  const facts = await app.workspace.reviewFacts(repo.path, repo.base_branch, sqliteMs(repo.created_at)).catch(() => null);
  return facts && reviewDue(repo, facts, app.readSettings().review_due, now);
}

/** Every repo due for an area review now, archived ones left out. */
export async function reviewsDue(app: App, now = Date.now()): Promise<ReviewDue[]> {
  const dues = await Promise.all(
    app
      .listRepos()
      .filter((r) => !r.archived_at)
      .map((r) => repoReviewDue(app, r, now)),
  );
  return dues.filter((d): d is ReviewDue => d !== null);
}

/**
 * The tick's check: store the repos due for the headline (a moved mark drops its repo), and remind a person of each one
 * not told about in the last day. Returns the repos due.
 */
export async function checkReviewsDue(app: App, now = Date.now()): Promise<ReviewDue[]> {
  const dues = await reviewsDue(app, now);
  app.setReviewsDue(dues);
  for (const d of dues) {
    if (!remindReviewDue(app.reviewDueToldAt(d.repo_id), now)) continue;
    app.setReviewDueToldAt(d.repo_id, now);
    await notify(app, reviewDueNotification(d));
  }
  return dues;
}
