// A run addressing a review: what the worker is shown of it, and what its answers do to the comments afterwards.
import type { App } from '../../ports/app.ts';
import {
  type ReviewPrompt,
  hunkAround,
  isReviewRetry,
  latestRequestNote,
  matchAnswers,
  unansweredNote,
  withNote,
} from '../../../domain/landing/index.ts';
import { type ReviewComment, commentStatesFor, commentsToAddress } from '../../../domain/landing/index.ts';
import type { Repo } from '../../../domain/repos/index.ts';
import { type Task, latestRetryAt } from '../../../domain/work/index.ts';

export async function reviewForRun(
  app: App,
  task: Pick<Task, 'id'>,
  repo: Pick<Repo, 'path' | 'base_branch'>,
): Promise<{ prompt: ReviewPrompt; comments: ReviewComment[] } | null> {
  const reviews = app.reviewsForTask(task.id);
  const comments = commentsToAddress(reviews);
  if (!comments.length) return null;
  const patches = new Map<string, Promise<string | null>>();
  const patchAt = (head: string, path: string): Promise<string | null> => {
    const key = `${head}\0${path}`;
    let patch = patches.get(key);
    if (!patch) {
      patch = (async () => {
        try {
          const base = await app.workspace.diffBase(repo.path, repo.base_branch, head);
          return base ? (await app.workspace.filePatch(repo.path, base.sha, head, [path])).patch : null;
        } catch {
          return null;
        }
      })();
      patches.set(key, patch);
    }
    return patch;
  };
  const shown = await Promise.all(
    comments.map(async (comment) => {
      const patch = await patchAt(comment.head_commit, comment.path);
      return { comment, hunk: patch ? hunkAround(patch, comment.side, comment.line) : null };
    }),
  );
  const ownRetry = isReviewRetry(reviews, latestRetryAt(app.eventsForTask(task.id)));
  return { prompt: { comments: shown, note: latestRequestNote(reviews), ownRetry }, comments };
}

export function recordAnswers(app: App, comments: ReviewComment[], finalMessage: string): string {
  const { answered, unanswered } = matchAnswers(comments, finalMessage);
  for (const { comment, answer } of answered) app.moveComment(comment.id, commentStatesFor('answer'), 'answered', answer);
  return unanswered.length ? withNote(finalMessage, unansweredNote(unanswered)) : finalMessage;
}
