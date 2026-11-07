// Send a PR's failing checks back to the worker: the failed steps' logs go into a retry's note.
import { github } from '../../adapters/github.ts';
import type { Db } from '../../db/index.ts';
import type { TaskId } from '../../domain/shared/id.ts';
import { type FailedCheck, LOG_TAIL_BYTES, actionsRun, failingChecks, fixChecksNote, logTail } from '../../domain/landing/checks.ts';
import { openPrUrl } from '../../domain/landing/pr.ts';
import { errorMessage } from '../../domain/shared/text.ts';
import { ActionError, requireTask, requireTaskRepo } from '../shared/input.ts';
import { retryTask } from '../work/tasks.ts';

export interface FixChecksResult {
  /** The failing checks sent to the worker, by name. */
  checks: string[];
}

/**
 * Retry a done task whose open PR has failing checks, with a note naming each one. A GitHub Actions check brings the
 * tail of its failed steps' log (`gh run view --log-failed`); any other check its name and link. The worker continues
 * on the same branch, and the PR updates when it is done. Refused when the task isn't done with an open PR, or no
 * check is failing.
 */
export async function fixChecks(db: Db, id: TaskId): Promise<FixChecksResult> {
  const task = requireTask(db, id);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task's checks can be sent back`);
  const url = openPrUrl(task.pr);
  if (!url) throw new ActionError(`#${id} has no open pull request`);
  const repo = requireTaskRepo(db, task);
  const pr = await github.prDetails(url, repo.path).catch((err) => {
    throw new ActionError(`could not read the PR: ${errorMessage(err)}`);
  });
  const failing = failingChecks(pr.check_list ?? []);
  if (!failing.length) throw new ActionError(`no check is failing on #${id}'s PR`);

  // Each Actions check's share of the note's log budget; checks of one job share its log.
  const fromActions = failing.filter((c) => actionsRun(c.url)).length;
  const budget = Math.floor(LOG_TAIL_BYTES / Math.max(fromActions, 1));
  const logs = new Map<string, Promise<string>>();
  const failed = await Promise.all(
    failing.map(async (c): Promise<FailedCheck> => {
      const run = actionsRun(c.url);
      if (!run) return { name: c.name, url: c.url };
      const key = `${run.run}/${run.job ?? ''}`;
      if (!logs.has(key)) logs.set(key, github.failedLog(repo.path, run.run, run.job));
      try {
        const log = logTail(await logs.get(key)!, undefined, budget);
        return log ? { name: c.name, url: c.url, log } : { name: c.name, url: c.url, log_error: 'gh printed no failed steps' };
      } catch (err) {
        return { name: c.name, url: c.url, log_error: errorMessage(err) };
      }
    }),
  );
  // The reads took a while: a PR merged or closed meanwhile, or a task that left done, is not requeued.
  const now = requireTask(db, id);
  if (now.status !== 'done' || !openPrUrl(now.pr))
    throw new ActionError(`#${id} changed while its checks were read; its PR is no longer open`);
  retryTask(db, id, fixChecksNote(failed), ['done']);
  return { checks: failed.map((c) => c.name) };
}
