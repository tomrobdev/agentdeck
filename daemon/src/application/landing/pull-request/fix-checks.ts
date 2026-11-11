// Send a PR's failing checks back to the worker: each failed step and what its log says go into a retry's note.
import type { App } from '#application/ports/app.ts';
import type { TaskId } from '#domain/shared/index.ts';
import {
  type FailedCheck,
  LOG_TAIL_BYTES,
  type PrCheck,
  actionsRun,
  carryFailures,
  failingChecks,
  fixChecksNote,
  headBytes,
} from '#domain/landing/index.ts';
import { openPrUrl } from '#domain/landing/index.ts';
import { errorMessage } from '#domain/shared/index.ts';
import { ActionError, requireTask, requireTaskRepo } from '#application/shared/input.ts';
import { readFailure } from '#application/landing/pull-request/check-failures.ts';
import { retryTask } from '#application/landing/person-events.ts';

export interface FixChecksResult {
  checks: string[];
}

export async function fixChecks(app: App, id: TaskId): Promise<FixChecksResult> {
  const task = requireTask(app, id);
  if (task.status !== 'done') throw new ActionError(`#${id} is ${task.status}; only a done task's checks can be sent back`);
  const url = openPrUrl(task.pr);
  if (!url) throw new ActionError(`#${id} has no open pull request`);
  const repo = requireTaskRepo(app, task);
  const pr = await app.codeHost.prDetails(url, repo.path).catch((err) => {
    throw new ActionError(`could not read the PR: ${errorMessage(err)}`);
  });
  const { checks } = carryFailures(task.pr?.checks.latest ?? null, pr.head ?? null, pr.check_list ?? []);
  const failing = failingChecks(checks);
  if (!failing.length) throw new ActionError(`no check is failing on #${id}'s PR`);

  const fromActions = failing.filter((c) => actionsRun(c.url)).length;
  const budget = Math.floor(LOG_TAIL_BYTES / Math.max(fromActions, 1));
  const reads = new Map<string, Promise<PrCheck>>();
  const failed = await Promise.all(
    failing.map(async (c): Promise<FailedCheck> => {
      const url = c.url;
      if (!url || !actionsRun(url)) return { name: c.name, url: c.url };
      let read: PrCheck = c;
      if (!c.excerpt) {
        const pending = reads.get(url) ?? readFailure(app, repo.path, c, budget);
        reads.set(url, pending);
        read = await pending;
      }
      if (read.state === 'not_run') return { name: c.name, url: c.url, log_error: `CI did not run: ${read.not_run ?? 'it never started'}` };
      return read.excerpt
        ? { name: c.name, url: c.url, step: read.step ?? null, excerpt: headBytes(read.excerpt, budget) }
        : { name: c.name, url: c.url, step: read.step ?? null, log_error: read.excerpt_error ?? 'gh printed no failed steps' };
    }),
  );
  const now = requireTask(app, id);
  if (now.status !== 'done' || !openPrUrl(now.pr))
    throw new ActionError(`#${id} changed while its checks were read; its PR is no longer open`);
  retryTask(app, id, { note: fixChecksNote(failed) }, ['done']);
  return { checks: failed.map((c) => c.name) };
}
