// Auto-merge: the daemon merges a done task's PR on its own when it passes the auto-merge check
// (docs/plans/auto-merge.html), and a person turns it on or off for one task.
import { github } from '../../adapters/github.ts';
import type { Db } from '../../db/index.ts';
import { AUTO_MERGE_LABEL, autoMergeOn } from '../../domain/pull-request/auto-merge.ts';
import type { PrDetails } from '../../domain/pull-request/merge.ts';
import { hasOpenPr } from '../../domain/task/stage.ts';
import { ActionError, object, requireTask, requireTaskRepo } from '../input.ts';
import { notifyLater } from '../notifications.ts';
import { ensureAutoMergeLabel } from './open-pr.ts';
import { isMergeLocked, mergeable, mergeOpenPr } from './pull-requests.ts';

/**
 * Merge the first PR the refresh found ready, with what GitHub said about it moments ago. One merge per refresh: it
 * moves the base, so the others are read again on the re-read the merge asks for. A merge gh refuses is logged and
 * notified, once per error while `told` is kept between calls; the task stays done with its PR open and the next
 * ready PR is tried. Returns the merged task, or null.
 */
export async function autoMerge(
  db: Db,
  ready: { id: number; pr: PrDetails }[],
  report: { log?: (msg: string) => void; told?: Map<number, string> } = {},
): Promise<number | null> {
  const { log = () => {}, told = new Map<number, string>() } = report;
  for (const { id, pr } of ready) {
    if (isMergeLocked(id)) continue; // another merge of it is under way
    let target: ReturnType<typeof mergeable>;
    try {
      target = mergeable(db, id);
    } catch {
      continue; // it moved on since the refresh read it
    }
    // A person's merge request names its method; the rest merge as their repo does.
    const asked = target.task.merge_requested_at ? target.task.merge_request_method : null;
    const method = asked ?? target.repo.merge_method;
    try {
      const res = await mergeOpenPr(db, target, pr, {
        method,
        deleteBranch: true,
        log,
        reason: asked ? `requested (${method})` : `auto-merged (${method})`,
      });
      told.delete(id);
      const unblocked = res.unblocked.length ? `; ${res.unblocked.map((n) => `#${n}`).join(', ')} can start` : '';
      log(`task ${id}: ${asked ? 'merged its PR as requested' : 'auto-merged its PR'} (${method})${unblocked}`);
      if (res.cleanup_error) log(`task ${id}: cleanup after the merge incomplete: ${res.cleanup_error}`);
      notifyLater(db, {
        kind: 'merged',
        title: `Merged #${id}`,
        body: `${target.task.title} (${target.repo.name})${unblocked}`,
        task_id: id,
      });
      return id;
    } catch (err) {
      const error = (err as Error).message;
      // A request gh refused is dropped, told once: a person can ask again.
      if (asked) db.clearMergeRequest(id);
      // A merge made meanwhile (a CLI merge in another process) is no failure: say nothing.
      if ((await github.prDetails(target.url, target.cwd).catch(() => null))?.state === 'merged') continue;
      if (told.get(id) === error) continue;
      told.set(id, error);
      log(`task ${id}: auto-merge failed: ${error}`);
      notifyLater(db, { kind: 'merged', title: `Could not merge #${id}`, body: error, task_id: id });
    }
  }
  return null;
}

/**
 * Turn auto-merge on or off for one task, or back to its repo's setting (null). An open PR gets or loses the label to
 * match; a label gh could not change is returned, the setting is kept.
 */
export async function setAutoMerge(
  db: Db,
  id: number,
  patch: { auto_merge: boolean | null },
): Promise<{ auto_merge: boolean; label_error?: string }> {
  const value = object(patch).auto_merge;
  if (value !== null && typeof value !== 'boolean') throw new ActionError('auto_merge must be true, false or null');
  requireTask(db, id);
  const task = db.setAutoMerge(id, value === null ? null : value ? 1 : 0)!;
  const repo = requireTaskRepo(db, task);
  const on = autoMergeOn(task, repo);
  if (!task.pr_url || !hasOpenPr(task)) return { auto_merge: on };
  try {
    if (on) await ensureAutoMergeLabel(repo.path);
    await github.setLabel(task.pr_url, repo.path, AUTO_MERGE_LABEL.name, on);
    db.requestPrCheck();
    return { auto_merge: on };
  } catch (err) {
    return { auto_merge: on, label_error: (err as Error).message };
  }
}
