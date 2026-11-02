// Tasks: list, add, edit and move through the lifecycle, merge, resolve and the log tail.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, idsField, route } from '../http.ts';
import { streamLog } from '../log-stream.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
  const wake = () => scheduler.wake();
  const detail = (id: string) => actions.taskDetail(db, Number(id));
  return [
    route('GET', /^\/api\/tasks$/, ({ query }) => {
      const status = query.get('status') as actions.TaskStatus | null;
      const limit = Math.min(Math.max(Math.floor(Number(query.get('limit'))) || 200, 1), 1000);
      const before = Number(query.get('before')) || undefined;
      return actions.taskViews(db, { status: status ?? undefined, limit, before });
    }),
    route('POST', /^\/api\/tasks$/, async ({ body }) => {
      const links = { builds_on: idsField(body, 'builds_on'), after: idsField(body, 'after') };
      const task = await actions.addTask(db, { ...body, ...links } as Parameters<typeof actions.addTask>[1]);
      return { ...(await actions.taskDetail(db, task.id)), warnings: await actions.promptWarnings(db, task.id) };
    }),
    route('GET', /^\/api\/tasks\/(\d+)$/, ({ params: [id] }) => detail(id)),
    route('POST', /^\/api\/tasks\/(\d+)$/, async ({ params: [id], body }) => {
      await actions.editTask(db, Number(id), body);
      return { ...(await detail(id)), warnings: await actions.promptWarnings(db, Number(id)) };
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/links$/, ({ params: [id], body }) => {
      actions.linkTasks(db, Number(id), body as Parameters<typeof actions.linkTasks>[2]);
      wake();
      return detail(id);
    }),
    route('DELETE', /^\/api\/tasks\/(\d+)\/links\/(\d+)$/, ({ params: [id, on] }) => {
      actions.unlinkTasks(db, Number(id), Number(on));
      wake();
      return detail(id);
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/approve$/, ({ params: [id] }) => (actions.approveTask(db, Number(id)), detail(id))),
    route('POST', /^\/api\/tasks\/(\d+)\/reject$/, ({ params: [id] }) => (actions.rejectTask(db, Number(id)), detail(id))),
    route('POST', /^\/api\/tasks\/(\d+)\/cancel$/, ({ params: [id] }) => ({ result: actions.cancelTask(db, Number(id)) })),
    route(
      'POST',
      /^\/api\/tasks\/(\d+)\/retry$/,
      ({ params: [id], body }) => (actions.retryTask(db, Number(id), body.note as string | undefined), detail(id)),
    ),
    route('POST', /^\/api\/tasks\/(\d+)\/done$/, ({ params: [id], body }) => {
      actions.markDone(db, Number(id), body.note as string | undefined);
      wake();
      return detail(id);
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/install-needs$/, async ({ params: [id] }) => {
      await actions.installNeeds(db, Number(id));
      return detail(id);
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/close-pr$/, async ({ params: [id] }) => {
      await actions.closeTaskPr(db, Number(id));
      return detail(id);
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/clean$/, async ({ params: [id] }) => {
      await actions.removeTaskWorktree(db, Number(id));
      return detail(id);
    }),
    // Merge the task's PR. GET is the preview the confirm dialog shows; POST merges and wakes the scheduler so dependents start now.
    route('GET', /^\/api\/tasks\/(\d+)\/merge$/, ({ params: [id] }) => actions.mergePreview(db, Number(id))),
    route('POST', /^\/api\/tasks\/(\d+)\/merge$/, async ({ params: [id], body }) => {
      const result = await actions.mergeTask(db, Number(id), body);
      wake();
      return { ...result, task: await detail(id) };
    }),
    // Merge every PR named in one go: the review group's "Merge all". The ones that can't merge come back with why.
    route('POST', /^\/api\/tasks\/merge$/, async ({ body }) => {
      const result = await actions.mergeAll(db, { ids: idsField(body, 'ids', { required: true }) });
      wake();
      return result;
    }),
    // Ask the daemon to merge the task's PR once it is ready, or withdraw the request; the answer is at once.
    route('POST', /^\/api\/tasks\/(\d+)\/merge-request$/, async ({ params: [id], body }) => {
      const result = actions.requestMerge(db, Number(id), body);
      wake();
      return { ...result, task: await detail(id) };
    }),
    route('DELETE', /^\/api\/tasks\/(\d+)\/merge-request$/, async ({ params: [id] }) => {
      const result = actions.cancelMergeRequest(db, Number(id));
      return { ...result, task: await detail(id) };
    }),
    // Merge requests for every task named: the review group's "Merge all". The ones that can't be requested come back with why.
    route('POST', /^\/api\/tasks\/merge-requests$/, ({ body }) => {
      const result = actions.requestMerges(db, { ids: idsField(body, 'ids', { required: true }) });
      wake();
      return result;
    }),
    // Let the daemon merge the task's PR on its own, or not, or follow the repo (null).
    route('POST', /^\/api\/tasks\/(\d+)\/auto-merge$/, async ({ params: [id], body }) => {
      const result = await actions.setAutoMerge(db, Number(id), body as { auto_merge: boolean | null });
      return { ...result, task: await detail(id) };
    }),
    // Sync the task's branch with the base, settling conflicts with a claude run. Answers when it is done.
    route('POST', /^\/api\/tasks\/(\d+)\/resolve$/, async ({ params: [id] }) => {
      const report = await scheduler.track(actions.syncNow(db, Number(id)), 'sync');
      wake();
      return { ...report, task: await detail(id) };
    }),
    route('GET', /^\/api\/tasks\/(\d+)\/log$/, ({ req, res, params: [id], query }) => {
      // A run by its id (resolve runs share an attempt number with a work run), or by attempt.
      streamLog(db, req, res, Number(id), {
        attempt: Number(query.get('attempt')) || undefined,
        run: Number(query.get('run')) || undefined,
      });
      return undefined; // streamLog owns the response
    }),
  ];
}
