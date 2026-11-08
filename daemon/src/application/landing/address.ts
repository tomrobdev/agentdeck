// A run addressing a review: what the worker is shown of it, and what its answers do to the comments afterwards.
import { diffBase, filePatch } from '../../adapters/git.ts';
import type { Db } from '../../db/index.ts';
import { type ReviewPrompt, hunkAround, latestRequestNote, matchAnswers, unansweredNote, withNote } from '../../domain/landing/index.ts';
import { type ReviewComment, commentStatesFor, commentsToAddress } from '../../domain/landing/index.ts';
import type { Repo } from '../../domain/repos/index.ts';
import type { Task } from '../../domain/work/index.ts';

/** The review a run of the task addresses: the open comments of its Request changes reviews with their diff hunks, or null when there are none. */
export async function reviewForRun(
  db: Db,
  task: Pick<Task, 'id'>,
  repo: Pick<Repo, 'path' | 'base_branch'>,
): Promise<{ prompt: ReviewPrompt; comments: ReviewComment[] } | null> {
  const reviews = db.reviewsForTask(task.id);
  const comments = commentsToAddress(reviews);
  if (!comments.length) return null;
  // The patch of a file at the commit a comment was made on; comments on one file share it.
  const patches = new Map<string, Promise<string | null>>();
  const patchAt = (head: string, path: string): Promise<string | null> => {
    const key = `${head}\0${path}`;
    let patch = patches.get(key);
    if (!patch) {
      patch = (async () => {
        try {
          const base = await diffBase(repo.path, repo.base_branch, head);
          return base ? (await filePatch(repo.path, base.sha, head, [path])).patch : null;
        } catch {
          return null; // the commit or file is gone: the comment goes without its hunk
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
  return { prompt: { comments: shown, note: latestRequestNote(reviews) }, comments };
}

/**
 * Store the answers in a run's final message: each answered comment moves to `answered` (unless it was resolved meanwhile).
 * Returns the final message with a line naming the comments left open, or as it was when every comment got an answer.
 */
export function recordAnswers(db: Db, comments: ReviewComment[], finalMessage: string): string {
  const { answered, unanswered } = matchAnswers(comments, finalMessage);
  for (const { comment, answer } of answered) db.moveComment(comment.id, commentStatesFor('answer'), 'answered', answer);
  return unanswered.length ? withNote(finalMessage, unansweredNote(unanswered)) : finalMessage;
}
