// Which repos are due for an area review (domain/operations/review-due.ts decides it from the refs/reviewed/* marks), and the reminder: the daemon's tick stores what is due for the headline and tells a person at most once a day per repo.
import type { App } from '../ports/app.ts';
import { type ReviewDue, remindReviewDue, reviewDue, reviewDueNotification } from '../../domain/operations/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import { sqliteMs } from '../../domain/shared/index.ts';
import { notify } from './notifications.ts';

export const REVIEW_CHECK_MS = 60_000;

export async function repoReviewDue(app: App, repo: Repo, now = Date.now()): Promise<ReviewDue | null> {
  const facts = await app.workspace.reviewFacts(repo.path, repo.base_branch, sqliteMs(repo.created_at)).catch(() => null);
  return facts && reviewDue(repo, facts, app.readSettings().review_due, now);
}

export async function reviewsDue(app: App, now = Date.now()): Promise<ReviewDue[]> {
  const dues = await Promise.all(
    app
      .listRepos()
      .filter((r) => !r.archived_at)
      .map((r) => repoReviewDue(app, r, now)),
  );
  return dues.filter((d): d is ReviewDue => d !== null);
}

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
