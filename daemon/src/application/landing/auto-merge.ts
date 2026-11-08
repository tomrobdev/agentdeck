// Auto-merge: the daemon merges a done task's PR on its own when it passes the auto-merge check
// (docs/plans/auto-merge.html), and a person turns it on or off for one task.
import { github } from '../../adapters/github.ts';
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { AUTO_MERGE_LABEL, autoMergeOn } from '../../domain/landing/index.ts';
import type { PrDetails } from '../../domain/landing/index.ts';
import { mergeReason } from '../../domain/work/index.ts';
import { openPrUrl } from '../../domain/landing/index.ts';
import { errorMessage } from '../../domain/shared/index.ts';
import { ActionError, object, requireTask, requireTaskRepo } from '../shared/input.ts';
import { notifyLater } from '../operations/notifications.ts';
import { isMergeLocked } from '../work/checkout-locks.ts';
import { ensureAutoMergeLabel } from './open-pr.ts';
import { mergeable, mergeOpenPr } from './merge.ts';

/**
 * Merge the first PR the refresh found ready, with what GitHub said about it moments ago. One merge per refresh: it
 * moves the base, so the others are read again on the re-read the merge asks for. A merge gh refuses is logged and
 * notified, once per error while `told` is kept between calls; the task stays done with its PR open and the next
 * ready PR is tried. Returns the merged task, or null.
 */
export async function autoMerge(
  app: App,
  ready: { id: TaskId; pr: PrDetails }[],
  report: { log?: (msg: string) => void; told?: Map<TaskId, string> } = {},
): Promise<TaskId | null> {
  const { log = () => {}, told = new Map<TaskId, string>() } = report;
  for (const { id, pr } of ready) {
    if (isMergeLocked(id)) continue; // another merge of it is under way
    let target: ReturnType<typeof mergeable>;
    try {
      target = mergeable(app, id);
    } catch {
      continue; // it moved on since the refresh read it
    }
    // A person's merge request names its method; the rest merge as their repo does.
    const request = target.task.pr?.merge_request;
    const asked = request ? request.method : null;
    const method = asked ?? target.repo.merge_method;
    try {
      const res = await mergeOpenPr(app, target, pr, {
        method,
        deleteBranch: true,
        log,
        reason: mergeReason(asked ? 'request' : 'auto', method),
      });
      told.delete(id);
      const unblocked = res.unblocked.length ? `; ${res.unblocked.map((n) => `#${n}`).join(', ')} can start` : '';
      log(`task ${id}: ${asked ? 'merged its PR as requested' : 'auto-merged its PR'} (${method})${unblocked}`);
      if (res.cleanup_error) log(`task ${id}: cleanup after the merge incomplete: ${res.cleanup_error}`);
      notifyLater(app, {
        kind: 'merged',
        title: `Merged #${id}`,
        body: `${target.task.title} (${target.repo.name})${unblocked}`,
        task_id: id,
      });
      return id;
    } catch (err) {
      const error = errorMessage(err);
      // A request gh refused is dropped, told once: a person can ask again.
      if (asked) app.clearMergeRequest(id);
      // A merge made meanwhile (a CLI merge in another process) is no failure: say nothing.
      if ((await github.prDetails(target.url, target.cwd).catch(() => null))?.state === 'merged') continue;
      if (told.get(id) === error) continue;
      told.set(id, error);
      log(`task ${id}: auto-merge failed: ${error}`);
      notifyLater(app, { kind: 'merged', title: `Could not merge #${id}`, body: error, task_id: id });
    }
  }
  return null;
}

/**
 * Turn auto-merge on or off for one task, or back to its repo's setting (null). An open PR gets or loses the label to
 * match; a label gh could not change is returned, the setting is kept.
 */
export async function setAutoMerge(
  app: App,
  id: TaskId,
  patch: { auto_merge: boolean | null },
): Promise<{ auto_merge: boolean; label_error?: string }> {
  const value = object(patch).auto_merge;
  if (value !== null && typeof value !== 'boolean') throw new ActionError('auto_merge must be true, false or null');
  requireTask(app, id);
  const task = app.setAutoMerge(id, value)!;
  const repo = requireTaskRepo(app, task);
  const on = autoMergeOn(task, repo);
  const url = openPrUrl(task.pr);
  if (!url) return { auto_merge: on };
  try {
    if (on) await ensureAutoMergeLabel(repo.path);
    await github.setLabel(url, repo.path, AUTO_MERGE_LABEL.name, on);
    app.requestPrCheck();
    return { auto_merge: on };
  } catch (err) {
    return { auto_merge: on, label_error: errorMessage(err) };
  }
}
