// Auto-merge: the daemon merges a done task's PR on its own when it passes the auto-merge check
// (docs/plans/auto-merge.html), and a person turns it on or off for one task.
import type { App } from '../../ports/app.ts';
import type { TaskId } from '../../../domain/shared/index.ts';
import { AUTO_MERGE_LABEL, autoMergeOn } from '../../../domain/landing/index.ts';
import { mergeReason } from '../../../domain/work/index.ts';
import { openPrUrl } from '../../../domain/landing/index.ts';
import { errorMessage } from '../../../domain/shared/index.ts';
import { canStart, mergeFailedNotification, mergedNotification } from '../../../domain/operations/index.ts';
import { ActionError, object, requireTask, requireTaskRepo } from '../../shared/input.ts';
import { notifyLater } from '../../operations/notifications.ts';
import { isMergeLocked } from '../../work/checkout-locks.ts';
import { ensureAutoMergeLabel } from '../pull-request/open-pr.ts';
import { MergeFailed, mergeable, mergeOpenPr } from './merge.ts';
import type { ReadyPr } from '../pull-request/refresh.ts';

/**
 * Merge the first PR the refresh found ready, with what GitHub said about it moments ago, and only its head then. One
 * merge per refresh: it moves the base, so the others are read again on the re-read the merge asks for. An entry whose
 * reason to merge went meanwhile (its request withdrawn, or auto-merge turned off for it) is skipped. A merge that fails
 * for something that passes on its own (the head or the base moved, GitHub answered 5xx, a timeout) is logged once per
 * error while `told` is kept between calls and left for the next round, request and all. Any other refusal drops the
 * request and is notified: for a request when it was still there to drop, else once per error. The task stays done with
 * its PR open and the next ready PR is tried. Returns the merged task, or null.
 */
export async function autoMerge(
  app: App,
  ready: ReadyPr[],
  report: { log?: (msg: string) => void; told?: Map<TaskId, string> } = {},
): Promise<TaskId | null> {
  const { log = () => {}, told = new Map<TaskId, string>() } = report;
  for (const { id, pr, requested } of ready) {
    if (isMergeLocked(id)) continue; // another merge of it is under way
    let target: ReturnType<typeof mergeable>;
    try {
      target = mergeable(app, id);
    } catch {
      continue; // it moved on since the refresh read it
    }
    // What made it ready must still be so: the person's request, or auto-merge for the task.
    const request = target.task.pr?.merge_request;
    if (requested ? !request : !autoMergeOn(target.task, target.repo)) continue;
    // A person's merge request names its method; the rest merge as their repo does.
    const asked = requested ? (request?.method ?? null) : null;
    const method = asked ?? target.repo.merge_method;
    try {
      const res = await mergeOpenPr(app, target, pr, {
        method,
        deleteBranch: true,
        log,
        reason: mergeReason(requested ? 'request' : 'auto', method),
      });
      told.delete(id);
      // A merge someone else made and recorded meanwhile (a CLI merge in another process) is theirs: say nothing.
      if (res.elsewhere) continue;
      log(`task ${id}: ${requested ? 'merged its PR as requested' : 'auto-merged its PR'} (${method})${canStart(res.unblocked)}`);
      if (res.cleanup_error) log(`task ${id}: cleanup after the merge incomplete: ${res.cleanup_error}`);
      notifyLater(app, mergedNotification(target.task, target.repo.name, res.unblocked));
      return id;
    } catch (err) {
      const error = errorMessage(err);
      const failure = err instanceof MergeFailed ? err.failure : 'lasting';
      if (failure !== 'lasting') {
        // It passes on its own: the next refresh reads the PR again and judges it anew.
        if (told.get(id) !== error) log(`task ${id}: merge left for the next refresh: ${error}`);
        told.set(id, error);
        continue;
      }
      // A request gh refused for good is dropped and told: a person can ask again. One withdrawn meanwhile tells nothing.
      if (requested ? !app.clearMergeRequest(id) : told.get(id) === error) continue;
      told.set(id, error);
      log(`task ${id}: ${requested ? 'requested merge' : 'auto-merge'} failed: ${error}`);
      notifyLater(app, mergeFailedNotification(id, error));
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
    if (on) await ensureAutoMergeLabel(app, repo.path);
    await app.codeHost.setLabel(url, repo.path, AUTO_MERGE_LABEL.name, on);
    app.requestPrCheck();
    return { auto_merge: on };
  } catch (err) {
    return { auto_merge: on, label_error: errorMessage(err) };
  }
}
