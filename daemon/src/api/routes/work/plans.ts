// Plans: stored in AgentDeck, each the plan of the task it was first attached to (domain/plan).
import * as actions from '#application/actions.ts';
import type {
  AbandonedPlanBranch,
  LandingAnswered,
  OpenedPlanBranch,
  PlanBranch,
  PlanHtml,
  PlanLandingQuestion,
  TaskPlan,
} from '#api/contract/work.ts';
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
    route<PlanBranch[]>('POST', /^\/api\/tasks\/(\d+)\/plan-branch\/policy$/, ({ params: [id], body }) =>
      actions.setPlanLandingPolicy(db, taskIdParam(id), body),
    ),
    route<PlanLandingQuestion>('GET', /^\/api\/tasks\/(\d+)\/plan-branch\/question$/, ({ params: [id] }) =>
      actions.planLandingQuestion(db, taskIdParam(id)),
    ),
    route<LandingAnswered>('POST', /^\/api\/tasks\/(\d+)\/plan-branch\/answer$/, ({ params: [id], body }) =>
      actions.answerPlanLanding(db, taskIdParam(id), body),
    ),
  ];
}
