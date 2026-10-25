// Tasks: list, add, edit and move through the lifecycle, merge, resolve and the log tail.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, route } from '../http.ts';
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
      const task = await actions.addTask(db, body as Parameters<typeof actions.addTask>[1]);
      return actions.taskDetail(db, task.id);
    }),
    route('GET', /^\/api\/tasks\/(\d+)$/, ({ params: [id] }) => detail(id)),
    route('POST', /^\/api\/tasks\/(\d+)$/, async ({ params: [id], body }) => {
      await actions.editTask(db, Number(id), body);
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
      return { ...result, task: detail(id) };
    }),
    // Bring the base branch into the task's branch, resolving conflicts with a claude run. Answers when it is done.
    route('POST', /^\/api\/tasks\/(\d+)\/resolve$/, async ({ params: [id] }) => {
      const report = await scheduler.track(actions.resolveTask(db, Number(id)), 'resolve');
      wake();
      return { ...report, task: detail(id) };
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
