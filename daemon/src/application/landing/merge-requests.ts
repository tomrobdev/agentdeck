// Merge requests: a person's Merge, recorded on the task and carried out by the daemon once the PR is ready
// (docs/plans/merge-requests.html; the carrying out is `refreshPrStates` and `autoMerge`).
import type { Db } from '../../db/index.ts';
import type { TaskId } from '../../domain/shared/id.ts';
import { MERGE_METHODS, type MergeMethod, isMergeMethod } from '../../domain/repos/repo.ts';
import { ActionError, object, requireTask, text } from '../shared/input.ts';
import { mergeable } from './merge.ts';

export interface MergeRequestedResult {
  method: MergeMethod;
}

/**
 * Ask the daemon to merge a done task's open PR once it is ready. The method defaults to the repo's.
 * Asking again replaces the request. The scheduler reads the PRs again at once. Throws ActionError if the task is not
 * done or has no open PR.
 */
export function requestMerge(db: Db, id: TaskId, opts: { method?: string } = {}): MergeRequestedResult {
  const given = text(object(opts), 'method', { empty: true, raw: true });
  const { task, repo } = mergeable(db, id);
  const method = given ?? repo.merge_method;
  if (!isMergeMethod(method)) throw new ActionError(`method must be one of ${MERGE_METHODS.join(', ')}`);
  if (!db.requestMerge(id, method)) throw new ActionError(`#${id} is no longer a done task with an open PR`);
  db.requestPrCheck();
  return { method };
}

export interface MergesRequestedResult {
  requested: TaskId[];
  /** The tasks it could not ask for, each with why. */
  failed: { id: TaskId; reason: string }[];
}

/** Request the merge of each task given (Merge all), each with its own method. The ones that can't be requested come back with why. */
export function requestMerges(db: Db, input: { ids: TaskId[] }): MergesRequestedResult {
  const result: MergesRequestedResult = { requested: [], failed: [] };
  for (const id of new Set(input.ids)) {
    try {
      requestMerge(db, id);
      result.requested.push(id);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      result.failed.push({ id, reason: err.message });
    }
  }
  return result;
}

/** Withdraw a task's merge request; a task with none is left as it is. */
export function cancelMergeRequest(db: Db, id: TaskId): { cancelled: boolean } {
  requireTask(db, id);
  return { cancelled: db.clearMergeRequest(id) };
}
