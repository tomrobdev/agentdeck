// Plans: stored in AgentDeck per task, named after the task they belong to (`112-plans-in-agentdeck.html`).
import type { App } from '../ports/app.ts';
import {
  type OwnPlan,
  PLAN_LIMIT,
  type ParsedPlan,
  type TaskPlan,
  linkedSteps,
  missingFollowedSteps,
  parsePlan,
  planAfterRun,
  toPlan,
} from '../../domain/work/index.ts';
import type { TaskId } from '../../domain/shared/index.ts';
import type { PrPlan } from '../../domain/landing/index.ts';
import type { PromptPlan } from '../../domain/runs/index.ts';
import { hasPlanLink, otherPlanOwner } from '../../domain/work/index.ts';
import { PLAN_ATTACHABLE_STATUSES, type Task } from '../../domain/work/index.ts';
import { ActionError, object, requireTask } from '../shared/input.ts';

export function readPlanInput(html: unknown): { html: string; plan: ParsedPlan } {
  if (typeof html !== 'string' || !html.trim()) throw new ActionError('the plan is empty');
  if (Buffer.byteLength(html) > PLAN_LIMIT) throw new ActionError(`a plan can be at most ${PLAN_LIMIT / 1024} KB`);
  const plan = parsePlan(html);
  if (!plan) throw new ActionError('not an AgentDeck plan: its <html> tag needs data-agentdeck-plan="1" (see docs/plan-format.md)');
  return { html, plan };
}

export function followedPlan(app: App, task: Pick<Task, 'id' | 'plan'>): (OwnPlan & { steps: string[] | null }) | null {
  if (task.plan !== null) {
    const plan = app.ownPlan(task.plan.task);
    return plan ? { ...plan, steps: task.plan.steps } : null;
  }
  const own = app.ownPlan(task.id);
  return own ? { ...own, steps: null } : null;
}

export function planForRun(app: App, task: Task): PromptPlan | null {
  const plan = followedPlan(app, task);
  if (plan) return { name: plan.name, html: plan.html, steps: plan.steps };
  return task.plan !== null ? { name: `#${task.plan.task}'s plan`, html: null, steps: task.plan.steps } : null;
}

export async function takePlanFile(app: App, task: Task, worktree: string): Promise<boolean> {
  const { written, given } = await app.workspace.readPlanFiles(worktree);
  if (written === null || !parsePlan(written)) return false;
  const changed = storeWrittenPlan(app, task, written, given);
  await app.workspace.writeGivenPlan(worktree, written);
  return changed;
}

function storeWrittenPlan(app: App, task: Task, written: string, given: string | null): boolean {
  const plan = followedPlan(app, task);
  if (plan) {
    const own = otherPlanOwner(task) === null;
    const html = planAfterRun({ stored: plan.html, given, written, ids: plan.steps, own, followed: own && app.planShared(task.id) });
    if (html === plan.html) return false;
    app.updatePlanHtml(plan.id, html);
    return true;
  }
  if (hasPlanLink(task)) return false;
  app.saveOwnPlan(task.id, written, 'worker');
  return true;
}

export function checkFollowers(app: App, owner: TaskId, plan: ParsedPlan, skip?: TaskId): void {
  const followers = app
    .planFollowers(owner)
    .filter((f) => f.id !== skip)
    .map((f) => ({ id: f.id, steps: f.plan?.steps ?? null }));
  const missing = missingFollowedSteps(plan, followers);
  if (missing.length) {
    const list = missing.map((m) => `#${m.id} (${m.missing.join(', ')})`).join(', ');
    throw new ActionError(`the new plan drops steps that tasks following it link: ${list}`);
  }
}

export function followedSteps(app: App, task: Task): ReturnType<typeof linkedSteps> {
  const plan = followedPlan(app, task);
  return plan && linkedSteps(plan.html, plan.steps);
}

export function prPlanFor(app: App, task: Task): PrPlan | null {
  const plan = followedPlan(app, task);
  const steps = followedSteps(app, task);
  return plan && steps ? { name: plan.name, steps } : null;
}

export function plansShown(app: App, task: Pick<Task, 'id' | 'plan'>): TaskPlan[] {
  const own = app.plansForTask(task.id);
  const owner = otherPlanOwner(task);
  const linked = owner === null ? undefined : app.ownPlan(owner);
  return linked ? [toPlan(linked), ...own] : own;
}

export function attachPlan(app: App, id: TaskId, input: { html?: unknown }): TaskPlan {
  const task = requireTask(app, id);
  const notNow = (status: string) => new ActionError(`#${id} is ${status}; a plan can't be attached while it runs`, undefined, 'conflict');
  if (!PLAN_ATTACHABLE_STATUSES.includes(task.status)) throw notNow(task.status);
  const { html, plan } = readPlanInput(object(input).html);
  checkFollowers(app, id, plan);
  const saved = app.attachOwnPlan(id, html);
  if (!saved) throw notNow(app.getTask(id)?.status ?? task.status);
  return saved;
}

export function planHtml(app: App, id: TaskId, planId: number): { html: string } {
  const html = app.planHtml(id, planId);
  if (html === undefined) throw new ActionError('no such plan', undefined, 'not_found');
  return { html };
}
