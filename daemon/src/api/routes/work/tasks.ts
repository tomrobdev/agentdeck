// Tasks: list, add, edit and move through the lifecycle, sync, verify runs and the log tail.
import * as actions from '#application/actions.ts';
import { type TaskId, parseId } from '#domain/shared/index.ts';
import { TASK_STATUSES } from '#domain/work/index.ts';
import type { CancelResult, TaskDetail, TaskSaved, TaskSummary } from '#api/contract/work.ts';
import type { SyncResult, VerifyResult } from '#api/contract/runs.ts';
import { type ApiContext, BadRequest, type Route, idsField, route, taskIdParam } from '#api/http.ts';
import { streamLog } from '#api/log-stream.ts';
import * as wire from '#api/wire.ts';

export function routes({ db, scheduler }: ApiContext): Route[] {
  const detail = (id: TaskId) => wire.taskDetail(db, id);
  return [
    route<TaskSummary[]>('GET', /^\/api\/tasks$/, ({ query }) => {
      const param = query.get('status');
      if (param !== null && !(TASK_STATUSES as string[]).includes(param))
        throw new BadRequest(`status takes one of ${TASK_STATUSES.join(', ')}`);
      const status = param as actions.TaskStatus | null;
      const limit = Math.min(Math.max(Math.floor(Number(query.get('limit'))) || 200, 1), 1000);
      const beforeParam = query.get('before');
      const before = beforeParam === null ? undefined : (parseId<TaskId>(beforeParam) ?? undefined);
      return wire.taskViews(db, { status: status ?? undefined, limit, before });
    }),
    route<TaskSaved>('POST', /^\/api\/tasks$/, async ({ body }) => {
      const links = { builds_on: idsField(body, 'builds_on'), after: idsField(body, 'after') };
      const task = await actions.addTask(db, { ...body, ...links } as Parameters<typeof actions.addTask>[1]);
      return { ...(await wire.taskDetail(db, task.id)), warnings: await actions.promptWarnings(db, task.id) };
    }),
    route<TaskDetail>('GET', /^\/api\/tasks\/(\d+)$/, ({ params: [id] }) => detail(taskIdParam(id))),
    route<TaskSaved>('POST', /^\/api\/tasks\/(\d+)$/, async ({ params: [text], body }) => {
      const id = taskIdParam(text);
      await actions.editTask(db, id, body);
      return { ...(await detail(id)), warnings: await actions.promptWarnings(db, id) };
    }),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/links$/, ({ params: [text], body }) => {
      const id = taskIdParam(text);
      const on = parseId<TaskId>(body.on);
      if (on === null) throw new BadRequest('on must be a task id');
      if (body.kind !== 'builds_on' && body.kind !== 'after') throw new BadRequest('kind must be one of builds_on, after');
      actions.linkTasks(db, id, { on, kind: body.kind });
      return detail(id);
    }),
    route<TaskDetail>('DELETE', /^\/api\/tasks\/(\d+)\/links\/(\d+)$/, ({ params: [text, on] }) => {
      const id = taskIdParam(text);
      actions.unlinkTasks(db, id, taskIdParam(on));
      return detail(id);
    }),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/approve$/, ({ params: [text] }) => {
      const id = taskIdParam(text);
      actions.approveTask(db, id);
      return detail(id);
    }),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/reject$/, ({ params: [text] }) => {
      const id = taskIdParam(text);
      actions.rejectTask(db, id);
      return detail(id);
    }),
    route<CancelResult>('POST', /^\/api\/tasks\/(\d+)\/cancel$/, ({ params: [id] }) => ({
      result: actions.cancelTask(db, taskIdParam(id)),
    })),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/retry$/, ({ params: [text], body }) => {
      const id = taskIdParam(text);
      actions.retryTask(db, id, { note: body.note as string | undefined, model: body.model as string | undefined });
      return detail(id);
    }),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/done$/, ({ params: [text], body }) => {
      const id = taskIdParam(text);
      actions.markDone(db, id, body.note as string | undefined);
      return detail(id);
    }),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/install-needs$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      await actions.installNeeds(db, id);
      return detail(id);
    }),
    route<TaskDetail>('POST', /^\/api\/tasks\/(\d+)\/clean$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      await actions.removeTaskWorktree(db, id);
      return detail(id);
    }),
    route<SyncResult>('POST', /^\/api\/tasks\/(\d+)\/sync$/, async ({ params: [text] }) => {
      const id = taskIdParam(text);
      const report = await scheduler.track(actions.syncNow(db, id), 'sync');
      return { ...report, task: await detail(id) };
    }),
    route<VerifyResult>('POST', /^\/api\/tasks\/(\d+)\/verify$/, async ({ params: [text], body }) => {
      const id = taskIdParam(text);
      if (body.wait !== undefined && typeof body.wait !== 'boolean') throw new BadRequest('wait must be true or false');
      const { run_id, done } = actions.startVerify(db, id);
      scheduler.track(done, 'verify');
      const report = body.wait === true ? await done : null;
      return { run_id, report, task: await detail(id) };
    }),
    route('GET', /^\/api\/tasks\/(\d+)\/log$/, ({ req, res, params: [id], query }) => {
      streamLog(db, req, res, taskIdParam(id), {
        attempt: Number(query.get('attempt')) || undefined,
        run: Number(query.get('run')) || undefined,
      });
      return undefined;
    }),
  ];
}
