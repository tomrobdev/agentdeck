// Tasks: list, add, edit and move through the lifecycle, sync and the log tail.
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, idsField, route } from '../http.ts';
import { streamLog } from '../log-stream.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
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
      return detail(id);
    }),
    route('DELETE', /^\/api\/tasks\/(\d+)\/links\/(\d+)$/, ({ params: [id, on] }) => {
      actions.unlinkTasks(db, Number(id), Number(on));
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
      return detail(id);
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/install-needs$/, async ({ params: [id] }) => {
      await actions.installNeeds(db, Number(id));
      return detail(id);
    }),
    route('POST', /^\/api\/tasks\/(\d+)\/clean$/, async ({ params: [id] }) => {
      await actions.removeTaskWorktree(db, Number(id));
      return detail(id);
    }),
    // Sync the task's branch with the base, settling conflicts with a claude run. Answers when it is done.
    route('POST', /^\/api\/tasks\/(\d+)\/sync$/, async ({ params: [id] }) => {
      const report = await scheduler.track(actions.syncNow(db, Number(id)), 'sync');
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
