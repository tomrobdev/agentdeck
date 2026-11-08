// Merge requests: a person's Merge, recorded on the task and carried out by the daemon once the PR is ready
// (docs/plans/merge-requests.html; the carrying out is `refreshPrStates` and `autoMerge`).
import { API_PORT } from '../../config.ts';
import type { App } from '../ports/app.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import { MERGE_METHODS, type MergeMethod, isMergeMethod } from '../../domain/repos/index.ts';
import { ActionError, object, requireTask, text } from '../shared/input.ts';
import { mergeable, mergePreview } from './merge.ts';

export interface MergeRequestedResult {
  method: MergeMethod;
}

/**
 * Ask the daemon to merge a done task's open PR once it is ready. The method defaults to the repo's.
 * Asking again replaces the request. The scheduler reads the PRs again at once. Throws ActionError if the task is not
 * done or has no open PR.
 */
export function requestMerge(app: App, id: TaskId, opts: { method?: string } = {}): MergeRequestedResult {
  const given = text(object(opts), 'method', { empty: true, raw: true });
  const { task, repo } = mergeable(app, id);
  const method = given ?? repo.merge_method;
  if (!isMergeMethod(method)) throw new ActionError(`method must be one of ${MERGE_METHODS.join(', ')}`);
  if (!app.requestMerge(id, method)) throw new ActionError(`#${id} is no longer a done task with an open PR`);
  app.requestPrCheck();
  return { method };
}

export interface MergesRequestedResult {
  requested: TaskId[];
  /** The tasks it could not ask for, each with why. */
  failed: { id: TaskId; reason: string }[];
}

/** Request the merge of each task given (Merge all), each with its own method. The ones that can't be requested come back with why. */
export function requestMerges(app: App, input: { ids: TaskId[] }): MergesRequestedResult {
  const result: MergesRequestedResult = { requested: [], failed: [] };
  for (const id of new Set(input.ids)) {
    try {
      requestMerge(app, id);
      result.requested.push(id);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      result.failed.push({ id, reason: err.message });
    }
  }
  return result;
}

/** What `agentdeck merge --all` came to: the merges it requested, the PRs it left and why, and whether a daemon will carry them out now. */
export interface MergeAllRequested {
  /** Each requested merge, with why it waits when it can't merge at once. */
  requested: { id: TaskId; waits: string[] }[];
  left: { id: TaskId; reason: string }[];
  /** False when no daemon answers: the requests wait in the database until one starts. */
  daemon_running: boolean;
}

/**
 * Merge all, as the dashboard's: request the merge of each task given (`requestMerges`), so the daemon carries them out
 * once each PR is ready. Each PR is read first, so one the daemon would refuse (failing checks, failed tests, branch
 * protection) is left with why, not requested and dropped later. A PR that can't be read is requested: the daemon reads it.
 */
export async function requestAllMerges(app: App, input: { ids: TaskId[] }): Promise<MergeAllRequested> {
  const left: MergeAllRequested['left'] = [];
  const waits = new Map<TaskId, string[]>();
  for (const id of new Set(input.ids)) {
    try {
      const { request } = await mergePreview(app, id);
      if (request.verdict === 'never') left.push({ id, reason: request.reasons.join('; ') });
      else waits.set(id, request.reasons);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      waits.set(id, []); // requestMerge says why, if it can't be asked for
    }
  }
  const res = requestMerges(app, { ids: [...waits.keys()] });
  return {
    requested: res.requested.map((id) => ({ id, waits: waits.get(id) ?? [] })),
    left: [...left, ...res.failed],
    daemon_running: (await app.service.daemonState(API_PORT)) !== null,
  };
}

/** Withdraw a task's merge request; a task with none is left as it is. */
export function cancelMergeRequest(app: App, id: TaskId): { cancelled: boolean } {
  requireTask(app, id);
  return { cancelled: app.clearMergeRequest(id) };
}
