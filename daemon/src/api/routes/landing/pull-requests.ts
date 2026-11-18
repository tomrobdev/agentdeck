// Pull requests: fix checks, open, close, merge (now, requested or automatic).
import * as actions from '#application/actions.ts';
import type { TaskId } from '#domain/shared/index.ts';
import type { TaskDetail } from '#api/contract/work.ts';
import type {
  AutoMergeResult,
  CancelMergeRequestResult,
  FixChecksResult,
  MergePreview,
  MergeResult,
  OpenPrResult,
  RequestMergeResult,
  RequestMergesResult,
} from '#api/contract/landing.ts';
import { type ApiContext, type Route, idsField, route, taskIdParam } from '#api/http.ts';
import * as wire from '#api/wire.ts';

export function routes({ db }: ApiContext): Route[] {
  const detail = (id: TaskId) => wire.taskDetail(db, id);
  return [
    route<FixChecksResult>('POST', /^\/api\/tasks\/(\d+)\/fix-checks$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      const result = await actions.fixChecks(db, id);
      return { ...result, task: await detail(id) };
    }),
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
    route<MergePreview>('GET', /^\/api\/tasks\/(\d+)\/merge$/, ({ params: [id] }) => actions.mergePreview(db, taskIdParam(id))),
    route<MergeResult>('POST', /^\/api\/tasks\/(\d+)\/merge$/, async ({ params: [text], body }) => {
      const id = taskIdParam(text);
      const result = await actions.mergeTask(db, id, body);
      return { ...result, task: await detail(id) };
    }),
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
    route<RequestMergesResult>('POST', /^\/api\/tasks\/merge-requests$/, ({ body }) => {
      const result = actions.requestMerges(db, { ids: idsField(body, 'ids', { required: true }) });
      return result;
    }),
    route<AutoMergeResult>('POST', /^\/api\/tasks\/(\d+)\/auto-merge$/, async ({ params: [text], body }) => {
      const id = taskIdParam(text);
      const result = await actions.setAutoMerge(db, id, body as { auto_merge: boolean | null });
      return { ...result, task: await detail(id) };
    }),
  ];
}
