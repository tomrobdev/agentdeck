// Plans: stored in AgentDeck, each the plan of the task it was first attached to (domain/plan).
import * as actions from '../../application/actions.ts';
import { type ApiContext, type Route, route } from '../http.ts';

export function routes({ db }: ApiContext): Route[] {
  return [
    route('POST', /^\/api\/tasks\/(\d+)\/plans$/, ({ params: [id], body }) => actions.attachPlan(db, Number(id), body)),
    route('GET', /^\/api\/tasks\/(\d+)\/plans\/(\d+)$/, ({ params: [id, pid] }) => actions.planHtml(db, Number(id), Number(pid))),
  ];
}
