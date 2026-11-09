// Plans: stored in AgentDeck, each the plan of the task it was first attached to (domain/plan).
import * as actions from '../../../application/actions.ts';
import type * as C from '../../contract.ts';
import { type ApiContext, type Route, route, taskIdParam } from '../../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route<C.TaskPlan>('POST', /^\/api\/tasks\/(\d+)\/plans$/, ({ params: [id], body }) => actions.attachPlan(db, taskIdParam(id), body)),
    route<C.PlanHtml>('GET', /^\/api\/tasks\/(\d+)\/plans\/(\d+)$/, ({ params: [id, pid] }) =>
      actions.planHtml(db, taskIdParam(id), Number(pid)),
    ),
  ];
}
