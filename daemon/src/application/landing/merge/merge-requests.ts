// Merge requests: a person's Merge, recorded on the task and carried out by the daemon once the PR is ready (docs/plans/merge-requests.html; the carrying out is `refreshPrStates` and `autoMerge`).
import { API_PORT } from '../../../config.ts';
import type { App } from '../../ports/app.ts';
import type { TaskId } from '../../../domain/shared/index.ts';
import { MERGE_METHODS, type MergeMethod, isMergeMethod } from '../../../domain/repos/index.ts';
import { ActionError, object, requireTask, text } from '../../shared/input.ts';
import { mergeable, mergePreview } from './merge.ts';

export interface MergeRequestedResult {
  method: MergeMethod;
}

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
  failed: { id: TaskId; reason: string }[];
}

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

export interface MergeAllRequested {
  requested: { id: TaskId; waits: string[] }[];
  left: { id: TaskId; reason: string }[];
  daemon_running: boolean;
}

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
      waits.set(id, []);
    }
  }
  const res = requestMerges(app, { ids: [...waits.keys()] });
  return {
    requested: res.requested.map((id) => ({ id, waits: waits.get(id) ?? [] })),
    left: [...left, ...res.failed],
    daemon_running: (await app.service.daemonState(API_PORT)) !== null,
  };
}

export function cancelMergeRequest(app: App, id: TaskId): { cancelled: boolean } {
  requireTask(app, id);
  return { cancelled: app.clearMergeRequest(id) };
}
