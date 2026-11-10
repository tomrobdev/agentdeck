// Auto-merge: the daemon merges a done task's PR on its own when it passes the auto-merge check (docs/plans/auto-merge.html), and a person turns it on or off for one task.
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

export async function autoMerge(
  app: App,
  ready: ReadyPr[],
  report: { log?: (msg: string) => void; told?: Map<TaskId, string> } = {},
): Promise<TaskId | null> {
  const { log = () => {}, told = new Map<TaskId, string>() } = report;
  for (const { id, pr, requested } of ready) {
    if (isMergeLocked(id)) continue;
    let target: ReturnType<typeof mergeable>;
    try {
      target = mergeable(app, id);
    } catch {
      continue;
    }
    const request = target.task.pr?.merge_request;
    if (requested ? !request : !autoMergeOn(target.task, target.repo)) continue;
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
      if (res.elsewhere) continue;
      log(`task ${id}: ${requested ? 'merged its PR as requested' : 'auto-merged its PR'} (${method})${canStart(res.unblocked)}`);
      if (res.cleanup_error) log(`task ${id}: cleanup after the merge incomplete: ${res.cleanup_error}`);
      notifyLater(app, mergedNotification(target.task, target.repo.name, res.unblocked));
      return id;
    } catch (err) {
      const error = errorMessage(err);
      const failure = err instanceof MergeFailed ? err.failure : 'lasting';
      if (failure !== 'lasting') {
        if (told.get(id) !== error) log(`task ${id}: merge left for the next refresh: ${error}`);
        told.set(id, error);
        continue;
      }
      if (requested ? !app.clearMergeRequest(id) : told.get(id) === error) continue;
      told.set(id, error);
      log(`task ${id}: ${requested ? 'requested merge' : 'auto-merge'} failed: ${error}`);
      notifyLater(app, mergeFailedNotification(id, error));
    }
  }
  return null;
}

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
