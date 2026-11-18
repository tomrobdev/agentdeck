// Plans: stored in AgentDeck, each the plan of the task it was first attached to (domain/plan).
import * as actions from '#application/actions.ts';
import type { AbandonedPlanBranch, OpenedPlanBranch, PlanHtml, TaskPlan } from '#api/contract/work.ts';
import { type ApiContext, type Route, route, taskIdParam } from '#api/http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route<TaskPlan>('POST', /^\/api\/tasks\/(\d+)\/plans$/, ({ params: [id], body }) => actions.attachPlan(db, taskIdParam(id), body)),
    route<PlanHtml>('GET', /^\/api\/tasks\/(\d+)\/plans\/(\d+)$/, ({ params: [id, pid] }) =>
      actions.planHtml(db, taskIdParam(id), Number(pid)),
    ),
    route<OpenedPlanBranch>('POST', /^\/api\/tasks\/(\d+)\/plan-branch$/, ({ params: [id] }) =>
      actions.openPlanBranch(db, taskIdParam(id)),
    ),
    route<AbandonedPlanBranch>('POST', /^\/api\/tasks\/(\d+)\/plan-branch\/abandon$/, ({ params: [id] }) =>
      actions.abandonPlanBranch(db, taskIdParam(id)),
    ),
  ];
}
