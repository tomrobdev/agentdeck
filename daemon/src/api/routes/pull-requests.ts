// Pull requests: fix checks, close, merge (now, requested or automatic).
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, idsField, route } from '../http.ts';

export function routes({ db }: ApiContext): Route[] {
  const detail = (id: string) => actions.taskDetail(db, Number(id));
  return [
    // Retry a done task with its PR's failing checks (and their logs) in the note.
    route('POST', /^\/api\/tasks\/(\d+)\/fix-checks$/, async ({ params: [id] }) => {
      const result = await actions.fixChecks(db, Number(id));
      return { ...result, task: await detail(id) };
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/close-pr$/, async ({ params: [id] }) => {
      await actions.closeTaskPr(db, Number(id));
      return detail(id);
    }),
    // Merge the task's PR. GET is the preview the confirm dialog shows; POST merges.
    route('GET', /^\/api\/tasks\/(\d+)\/merge$/, ({ params: [id] }) => actions.mergePreview(db, Number(id))),
    route('POST', /^\/api\/tasks\/(\d+)\/merge$/, async ({ params: [id], body }) => {
      const result = await actions.mergeTask(db, Number(id), body);
      return { ...result, task: await detail(id) };
    }),
    // Ask the daemon to merge the task's PR once it is ready, or withdraw the request; the answer is at once.
    route('POST', /^\/api\/tasks\/(\d+)\/merge-request$/, async ({ params: [id], body }) => {
      const result = actions.requestMerge(db, Number(id), body);
      return { ...result, task: await detail(id) };
    }),
    route('DELETE', /^\/api\/tasks\/(\d+)\/merge-request$/, async ({ params: [id] }) => {
      const result = actions.cancelMergeRequest(db, Number(id));
      return { ...result, task: await detail(id) };
    }),
    // Merge requests for every task named: the review group's "Merge all". The ones that can't be requested come back with why.
    route('POST', /^\/api\/tasks\/merge-requests$/, ({ body }) => {
      const result = actions.requestMerges(db, { ids: idsField(body, 'ids', { required: true }) });
      return result;
    }),
    // Let the daemon merge the task's PR on its own, or not, or follow the repo (null).
    route('POST', /^\/api\/tasks\/(\d+)\/auto-merge$/, async ({ params: [id], body }) => {
      const result = await actions.setAutoMerge(db, Number(id), body as { auto_merge: boolean | null });
      return { ...result, task: await detail(id) };
    }),
  ];
}
