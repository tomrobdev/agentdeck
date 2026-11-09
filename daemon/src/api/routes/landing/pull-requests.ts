// Pull requests: fix checks, open, close, merge (now, requested or automatic).
import * as actions from '../../../application/actions.ts';
import type { TaskId } from '../../../domain/shared/index.ts';
import type { TaskDetail } from '../../contract/work.ts';
import type {
  AutoMergeResult,
  CancelMergeRequestResult,
  FixChecksResult,
  MergePreview,
  MergeResult,
  OpenPrResult,
  RequestMergeResult,
  RequestMergesResult,
} from '../../contract/landing.ts';
import { type ApiContext, type Route, idsField, route, taskIdParam } from '../../http.ts';
import * as wire from '../../wire.ts';

export function routes({ db }: ApiContext): Route[] {
  const detail = (id: TaskId) => wire.taskDetail(db, id);
  return [
    // Retry a done task with its PR's failing checks (and their logs) in the note.
    route<FixChecksResult>('POST', /^\/api\/tasks\/(\d+)\/fix-checks$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      const result = await actions.fixChecks(db, id);
      return { ...result, task: await detail(id) };
    }),
    // Open a done task's PR by hand: one that failed to open, never opened, or was closed.
    route<OpenPrResult>('POST', /^\/api\/tasks\/(\d+)\/open-pr$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      const result = await actions.openTaskPr(db, id);
      return { ...result, task: await detail(id) };
    }),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/close-pr$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      await actions.closeTaskPr(db, id);
      return detail(id);
    }),
    // Merge the task's PR. GET is the preview the confirm dialog shows; POST merges.
    route<MergePreview>('GET', /^\/api\/tasks\/(\d+)\/merge$/, ({ params: [id] }) => actions.mergePreview(db, taskIdParam(id))),
    route<MergeResult>('POST', /^\/api\/tasks\/(\d+)\/merge$/, async ({ params: [text], body }) => {
      const id = taskIdParam(text);
      const result = await actions.mergeTask(db, id, body);
      return { ...result, task: await detail(id) };
    }),
    // Ask the daemon to merge the task's PR once it is ready, or withdraw the request; the answer is at once.
    route<RequestMergeResult>('POST', /^\/api\/tasks\/(\d+)\/merge-request$/, async ({ params: [text], body }) => {
      const id = taskIdParam(text);
      const result = actions.requestMerge(db, id, body);
      return { ...result, task: await detail(id) };
    }),
    route<CancelMergeRequestResult>('DELETE', /^\/api\/tasks\/(\d+)\/merge-request$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      const result = actions.cancelMergeRequest(db, id);
      return { ...result, task: await detail(id) };
    }),
    // Merge requests for every task named: the review group's "Merge all". The ones that can't be requested come back with why.
    route<RequestMergesResult>('POST', /^\/api\/tasks\/merge-requests$/, ({ body }) => {
      const result = actions.requestMerges(db, { ids: idsField(body, 'ids', { required: true }) });
      return result;
    }),
    // Let the daemon merge the task's PR on its own, or not, or follow the repo (null).
    route<AutoMergeResult>('POST', /^\/api\/tasks\/(\d+)\/auto-merge$/, async ({ params: [text], body }) => {
      const id = taskIdParam(text);
      const result = await actions.setAutoMerge(db, id, body as { auto_merge: boolean | null });
      return { ...result, task: await detail(id) };
    }),
  ];
}
