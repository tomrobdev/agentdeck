// Measuring the code comments a work run's branch adds, against its repo's limits, into the run log.
import type { App } from '#application/ports/app.ts';
import type { Repo } from '#domain/repos/index.ts';
import type { Run } from '#domain/runs/index.ts';
import { type CodeCommentCount, codeCommentLimitOn, codeCommentsOver, codeCommentsText, countCodeComments } from '#domain/landing/index.ts';
import type { OpenedRun } from '#application/runs/claude-run.ts';

export async function measureCodeComments(
  app: App,
  repo: Repo,
  checkout: { worktree: string; target: string },
  log: OpenedRun['log'],
): Promise<{ count: CodeCommentCount; over: boolean } | null> {
  if (!codeCommentLimitOn(repo)) return null;
  const added = await app.workspace.addedLines(checkout.worktree, checkout.target, 'HEAD');
  if (!added) {
    app.runLog.event(log, { type: 'agentdeck_error', text: 'count code comments: the branch could not be compared with its base' });
    return null;
  }
  const count = countCodeComments(added);
  const over = codeCommentsOver(count, repo);
  app.runLog.event(log, {
    type: 'agentdeck_code_comments',
    ...count,
    max_lines: repo.code_comment_max_lines,
    max_percent: repo.code_comment_max_percent,
    over,
    text: codeCommentsText(count, repo),
  });
  return { count, over };
}

export const codeCommentFields = (count: CodeCommentCount): Pick<Run, 'code_comment_lines' | 'code_comment_percent'> => ({
  code_comment_lines: count.lines,
  code_comment_percent: count.percent,
});
